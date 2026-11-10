import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { confined, fault } from './storage.mjs';
import { buildPlayable } from './playable-build.mjs';
import { runtimeSourceManifest } from './runtime-observation.mjs';
import { classifyBuildFailure } from './build-failure.mjs';
import { newExecution, executionHealth } from './task-execution.mjs';

const instances = new WeakMap();
const active = job => ['running', 'cancelling'].includes(job.state.status);
const blocking = job => active(job) || job.state.status === 'unconfirmed';
export function buildJobs(controller) {
  if (!instances.has(controller)) instances.set(controller, new BuildJobs({ directory: path.join(controller.settingsPath ? path.dirname(controller.settingsPath) : os.tmpdir(), 'dsh-playable-builds'), isolateRuntime: controller.restrictedProduction === true }));
  return instances.get(controller);
}
export class BuildJobs {
  constructor({ directory, build = buildPlayable, isolateRuntime = false } = {}) {
    this.directory = path.resolve(directory); this.build = build; this.jobs = new Map();
    this.isolateRuntime = isolateRuntime;
    this.ready = this.load(); this.ready.catch(() => {});
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    const files = (await fs.readdir(this.directory)).filter(name => /^job-[a-f0-9-]{36}\.json$/.test(name));
    for (const name of files) {
      const known = this.jobs.get(name.slice(4, -5));
      if (known && known.state.status !== 'unconfirmed') continue;
      const file = await confined(this.directory, name);
      if ((await fs.stat(file)).size > 65536) throw fault('INVALID_BUILD_RECORD', '构建记录过大，请保留文件后核查');
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      if (record.version !== 1 || name !== `job-${record.state?.id}.json` || !path.isAbsolute(record.root ?? '') || typeof record.requestId !== 'string') throw fault('INVALID_BUILD_RECORD', '构建记录格式异常，请保留后核查');
      const job = { ...record, abort: new AbortController(), saves: Promise.resolve() };
      if (active(job)) {
        const health = executionHealth({ id: job.state.id, status: 'running', execution: job.owner });
        job.state.status = health.state === 'interrupted' ? 'interrupted' : 'unconfirmed';
        job.state.message = health.state === 'interrupted'
          ? '上次构建的工作台已退出，没有收到完成结果。测试游戏可能仍在运行；本次不代表构建成功或已停止。'
          : '原工作台可能仍在构建，暂不重复生成。请回到原窗口查看结果。';
      }
      this.jobs.set(job.state.id, job);
    }
  }
  persist(job) {
    const record = JSON.stringify({ version: 1, root: job.root, engine: job.engine, owner: job.owner, requestId: job.requestId, resultDirectory: job.resultDirectory, state: job.state }, null, 2);
    job.saves = job.saves.catch(() => {}).then(async () => {
      const target = await confined(this.directory, `job-${job.state.id}.json`, { mustExist: false });
      const temporary = await confined(this.directory, `job-${job.state.id}-${randomUUID()}.tmp`, { mustExist: false });
      await fs.writeFile(temporary, record, { flag: 'wx' }); await fs.rename(temporary, target);
    });
    return job.saves;
  }
  snapshot(job) { return structuredClone(job.state); }
  async start(wb, { requestId, graphics = 'project' } = {}) {
    await this.ready;
    if ([...this.jobs.values()].some(job => job.state.status === 'unconfirmed')) await this.load();
    if (!['project', 'angle'].includes(graphics)) throw fault('INVALID_GRAPHICS', '未知试玩图形设置');
    if (!wb.enginePath) throw fault('ENGINE_REQUIRED', '请先配置 Godot');
    if (typeof requestId !== 'string' || !/^[\w-]{8,80}$/.test(requestId)) throw fault('INVALID_REQUEST', '构建请求标识无效');
    for (const job of this.jobs.values()) if (job.root === wb.root && job.requestId === requestId) {
      if (job.engine !== wb.enginePath || (job.state.graphics ?? 'project') !== graphics || Boolean(job.state.isolated) !== this.isolateRuntime) throw fault('REQUEST_CONFLICT', '同一请求的引擎、图形设置或执行边界已改变，请重新发起');
      if (!active(job) && job.done) await job.done;
      return this.snapshot(job);
    }
    if ([...this.jobs.values()].some(blocking)) throw fault('BUILD_BUSY', '已有构建正在执行或尚无法确认结束，请先查看原窗口的结果');
    const job = { root: wb.root, engine: wb.enginePath, owner: newExecution(), requestId, abort: new AbortController(), saves: Promise.resolve(), state: { graphics, id: randomUUID(), projectRoot: wb.root, status: 'running', phase: 'checking', startedAt: new Date().toISOString(), exportPassed: false, startupPassed: false, humanPlaytest: false, ...(this.isolateRuntime ? { isolated: true } : {}) } };
    this.jobs.set(job.state.id, job);
    try { await this.persist(job); } catch (error) { this.jobs.delete(job.state.id); throw error; }
    job.done = Promise.resolve().then(() => this.build({ projectRoot: job.root, engine: job.engine, graphics: job.state.graphics, outputParent: this.directory, signal: job.abort.signal, ...(this.isolateRuntime ? { isolateRuntime: true } : {}), onProgress: value => { job.state.phase = value.phase; this.persist(job).catch(() => {}); } })).then(report => {
      job.resultDirectory = path.relative(this.directory, report.root);
      const status = job.abort.signal.aborted ? 'cancelled' : report.status;
      job.state = { ...job.state, status, exportPassed: report.exportPassed, startupPassed: report.startupPassed, saveIsolationVerified: report.checks?.packedSaveDirectory?.verified === true, code: report.error?.code, message: report.error?.message ?? '试玩包已生成并完成自动启动检查。', output: report.output, sourceState: report.sourceState, hasEvidence: true };
      if (status === 'failed' && report.compatibilityRetry === true) job.state.compatibilityRetry = true;
    }, error => { job.state.status = job.abort.signal.aborted ? 'cancelled' : 'failed'; job.state.message = error.message; job.state.code = error.code ?? 'BUILD_FAILED'; }).finally(async () => {
      job.state.finishedAt = new Date().toISOString();
      try { await this.persist(job); } catch { job.state.status = 'record-failed'; job.state.message = '构建结果未能保存，请保留产物并核查记录目录。'; }
    });
    return this.snapshot(job);
  }
  async find(root, id) {
    await this.ready;
    if ([...this.jobs.values()].some(job => job.state.status === 'unconfirmed')) await this.load();
    const job = id ? this.jobs.get(id) : [...this.jobs.values()].filter(item => item.root === root && (!this.isolateRuntime || item.state.isolated === true)).sort((a, b) => a.state.startedAt.localeCompare(b.state.startedAt)).at(-1);
    if (id && (!job || job.root !== root)) throw fault('BUILD_NOT_FOUND', '找不到此项目的构建记录');
    // Once execution reaches a terminal state, expose it only after the last
    // write has settled so an immediate reopen sees the same build ID and result.
    if (job && !active(job) && job.done) await job.done;
    return job ?? null;
  }
  async status(root, id) { const job = await this.find(root, id); return job ? this.snapshot(job) : null; }
  async cancel(root, id) {
    const job = await this.find(root, id); if (!job) throw fault('BUILD_NOT_FOUND', '找不到构建记录');
    if (active(job)) { job.state.status = 'cancelling'; job.abort.abort(); await this.persist(job); }
    return this.snapshot(job);
  }
  async report(root, id) {
    const job = await this.find(root, id);
    if (!job?.resultDirectory) throw fault('EVIDENCE_UNAVAILABLE', '构建依据尚未生成');
    const folder = await confined(this.directory, job.resultDirectory);
    const file = await confined(folder, 'build-report.json');
    if ((await fs.stat(file)).size > 8_000_000) throw fault('INVALID_BUILD_RECORD', '构建依据过大');
    const report = JSON.parse(await fs.readFile(file, 'utf8'));
    if (report.sourceRoot !== root || path.resolve(report.root) !== folder) throw fault('INVALID_BUILD_RECORD', '构建依据与项目不一致');
    return { job, report, folder };
  }
  async evidence(root, id) {
    const { job, report } = await this.report(root, id);
    let sourceState = 'unknown';
    try { sourceState = JSON.stringify(await runtimeSourceManifest(root)) === JSON.stringify(report.sourceManifest) ? 'unchanged' : 'changed'; } catch {}
    const checks = Object.fromEntries(Object.entries(report.checks).map(([name, check]) => [name, { ...check, stdout: check.stdout?.slice(0, 16000), stderr: check.stderr?.slice(0, 16000), fileLog: check.fileLog?.slice(0, 16000), displayTruncated: Boolean(check.fileLogTruncated || [check.stdout, check.stderr, check.fileLog].some(text => text?.length > 16000)) }]));
    return { ...this.snapshot(job), sourceState, checks, failure: classifyBuildFailure(report), artifacts: report.artifacts, limitations: report.limitations, engineVersion: report.engineVersion,
      ...(report.isolation ? { isolation: report.isolation, template: report.template } : {}) };
  }
  async verifyDelivery(root, id) {
    if (typeof id !== 'string' || !id) throw fault('DELIVERY_REQUIRED', '请先选择本次验收的试玩包');
    const evidence = await this.evidence(root, id);
    if (evidence.status !== 'ready' || !evidence.exportPassed || !evidence.startupPassed || evidence.sourceState !== 'unchanged') throw fault('DELIVERY_REQUIRED', '试玩包尚未检查通过，或与当前工程不同');
    const output = await this.verifiedOutput(root, id);
    return { id, status: 'ready', sourceState: 'unchanged', exportPassed: true, startupPassed: true, artifactsVerified: true, artifacts: evidence.artifacts, output };
  }
  async verifiedOutput(root, id) {
    const { job, report, folder } = await this.report(root, id);
    if (this.isolateRuntime && (job.state.isolated !== true || job.state.status !== 'ready' || report.startupPassed !== true ||
      ['saveDirectory', 'import', 'export', 'packedSaveDirectory'].some(phase => report.checks?.[phase]?.sandbox !== 'windows-lpac') || report.checks?.startup?.sandbox !== 'windows-appcontainer')) {
      throw fault('ISOLATION_REQUIRED', '请先生成并验证当前配置的受限试玩包');
    }
    if (report.checks?.packedSaveDirectory?.verified !== true) throw fault('SAVE_DIRECTORY_UNVERIFIED', '这个试玩包尚未核实独立存档位置，请用新版重新生成；暂不打开旧包。');
    if (!report.exportPassed || !job.state.exportPassed) throw fault('BUILD_NOT_EXPORTED', '尚未生成完整试玩包');
    const output = await confined(folder, 'playable');
    for (const name of ['game.exe', 'game.pck']) {
      const expected = report.artifacts?.find(item => item.name === name);
      const bytes = await fs.readFile(await confined(output, name));
      if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw fault('BUILD_CHANGED', '试玩文件已变化，请核对后重新生成');
    }
    return output;
  }
  async openFolder(root, id, { open = openWindowsFolder, currentVersion = false } = {}) {
    const output = currentVersion ? (await this.verifyDelivery(root, id)).output : await this.verifiedOutput(root, id);
    await open(output); return { status: 'requested', output, message: '已请求打开产物文件夹，请连同 EXE 和 PCK 一起保留。' };
  }
}
function openWindowsFolder(folder) {
  if (process.platform !== 'win32') throw fault('UNSUPPORTED_PLATFORM', '当前只支持 Windows 文件夹入口');
  return new Promise((resolve, reject) => {
    // This is an explicit user-facing folder action, not a background helper.
    const child = spawn(path.join(process.env.WINDIR ?? 'C:\\Windows', 'explorer.exe'), [folder], { shell: false, detached: true, windowsHide: false, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
