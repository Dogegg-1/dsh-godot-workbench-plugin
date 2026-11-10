import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fault, confined, durableRecord } from './storage.mjs';
import { observeRuntime, validateScenario, runtimeSourceManifest } from './runtime-observation.mjs';
import { newExecution, executionHealth } from './task-execution.mjs';

const active = job => ['running', 'cancelling'].includes(job.state.status);
const blocking = job => active(job) || job.state.status === 'unconfirmed';
const maxWaitMs = 10000;
const instances = new WeakMap();
export function runtimeJobs(controller) {
  if (!instances.has(controller)) instances.set(controller, new RuntimeJobs({ persist: true, isolateRuntime: controller.isolateRuntime }));
  return instances.get(controller);
}

export class RuntimeJobs {
  constructor({ run = observeRuntime, outputParent = os.tmpdir(), persist = false, isolateRuntime = false } = {}) {
    this.run = run; this.outputParent = outputParent; this.jobs = new Map(); this.persist = persist; this.loaded = new Set();
    this.isolateRuntime = isolateRuntime;
  }
  async restore(root) {
    if (!this.persist || (this.loaded.has(root) && ![...this.jobs.values()].some(job => job.root === root && job.state.status === 'unconfirmed'))) return;
    const folder = await confined(root, '.game-workbench/runtime-history', { mustExist: false });
    const names = await fs.readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const records = [];
    for (const name of names.filter(name => /^[\w-]+\.json$/.test(name))) {
      const file = await confined(root, `.game-workbench/runtime-history/${name}`);
      if ((await fs.stat(file)).size > 2_000_000) throw fault('INVALID_RUNTIME_HISTORY', '运行历史过大，原记录已保留，请核查后再继续。');
      let saved;
      try { saved = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw fault('INVALID_RUNTIME_HISTORY', '运行历史损坏，原记录已保留，请核查后再继续。'); }
      if (!saved || saved.version !== 1 || saved.root !== root || typeof saved.engine !== 'string' || typeof saved.requestId !== 'string' || typeof saved.signature !== 'string' || !saved.state || `${saved.state.id}.json` !== name || !['passed', 'failed', 'cancelled', 'running', 'cancelling'].includes(saved.state.status) || !Number.isFinite(Date.parse(saved.state.startedAt)) || (saved.result?.sourceManifest && (!Array.isArray(saved.result.sourceManifest) || saved.result.sourceManifest.some(item => !item || typeof item.path !== 'string' || typeof item.hash !== 'string')))) throw fault('INVALID_RUNTIME_HISTORY', '运行历史不属于此工程或格式不完整，原记录已保留。');
      if (active(saved)) {
        const health = executionHealth({ id: saved.state.id, status: 'running', execution: saved.owner });
        saved.state.status = health.state === 'interrupted' ? 'interrupted' : 'unconfirmed';
        saved.state.conclusion = health.state === 'interrupted' ? '上次检查的工作台已退出，没有收到完整结果。测试游戏可能仍在运行；这不是检查通过或已成功停止的证明。' : '上次检查的工作台可能仍在运行，暂不启动重复检查。请回到原窗口查看结果。';
      }
      records.push(saved);
    }
    records.sort((a, b) => a.state.startedAt.localeCompare(b.state.startedAt));
    for (const saved of records.filter((record, index) => record.state.status === 'unconfirmed' || index >= records.length - 20)) if (!this.jobs.has(saved.state.id) || this.jobs.get(saved.state.id).state.status === 'unconfirmed') {
      saved.state = { ...saved.state, hasEvidence: false, restored: true, humanPlaytest: false,
        historyNotice: ['interrupted', 'unconfirmed'].includes(saved.state.status) ? null : '这是重启前的运行摘要。详细日志和画面未在此恢复，不能当作本次运行或人工试玩结果。' };
      this.jobs.set(saved.state.id, saved);
    }
    this.loaded.add(root);
  }
  async save(job) {
    if (!this.persist) return;
    const folder = await confined(job.root, '.game-workbench/runtime-history', { mustExist: false });
    await fs.mkdir(folder, { recursive: true });
    const result = job.result ? { sourceManifest: job.result.sourceManifest,
      execution: { exitCode: job.result.execution?.exitCode }, imported: { exitCode: job.result.imported?.exitCode } } : null;
    const record = { version: 1, root: job.root, engine: job.engine, requestId: job.requestId, signature: job.signature, state: job.state, result, owner: job.owner };
    const file = await confined(job.root, `.game-workbench/runtime-history/${job.state.id}.json`, { mustExist: false });
    const temporary = path.join(folder, `${job.state.id}.pending`);
    await durableRecord(temporary, JSON.stringify(record));
    await fs.rename(temporary, file);
  }
  start(wb, { requestId, scenario } = {}) {
    if (!wb.enginePath) throw fault('ENGINE_REQUIRED', '请先配置 Godot，再运行游戏检查');
    if (typeof requestId !== 'string' || !/^[\w-]{8,80}$/.test(requestId)) throw fault('INVALID_REQUEST', '运行请求标识无效');
    const normalized = validateScenario(scenario);
    const signature = JSON.stringify({ engine: wb.enginePath, scenario: normalized, ...(this.isolateRuntime ? { sandbox: 'windows-appcontainer-window-v1' } : {}) });
    for (const job of this.jobs.values()) if (job.root === wb.root && job.requestId === requestId) {
      if (job.signature !== signature) throw fault('REQUEST_CONFLICT', '同一运行请求的内容已改变，请使用新的请求标识');
      return this.snapshot(job);
    }
    if ([...this.jobs.values()].some(blocking)) throw fault('RUNTIME_BUSY', '已有检查正在运行或尚无法确认结束，请先查看原窗口的结果');
    const abort = new AbortController(); const id = randomUUID();
    const job = { root: wb.root, engine: wb.enginePath, requestId, signature, abort, owner: newExecution(), state: { id, projectRoot: wb.root, status: 'running', startedAt: new Date().toISOString(), humanPlaytest: false } };
    this.jobs.set(id, job);
    if (this.jobs.size > 20) {
      const old = [...this.jobs].find(([, value]) => !blocking(value));
      if (old) this.jobs.delete(old[0]);
    }
    // Capture root and engine now; later project selection must not retarget this run.
    const options = { projectRoot: wb.root, engine: wb.enginePath, outputParent: this.outputParent, scenario: normalized, signal: abort.signal, isolateRuntime: this.isolateRuntime };
    job.done = Promise.resolve().then(async () => {
      // Persist intent before starting the engine. A failed journal write must
      // not leave an unrecorded game process running.
      await this.save(job);
      return this.run(options);
    }).then(result => {
      job.result = result;
      job.state.status = abort.signal.aborted ? 'cancelled' : result.passed ? 'passed' : 'failed';
      job.state.conclusion = abort.signal.aborted ? '本次检查已取消，不能作为通过依据。' : result.conclusion;
      job.state.completedSteps = result.observations?.steps.length ?? 0;
      job.state.totalSteps = normalized.steps.length;
      job.state.hasEvidence = true;
    }, error => {
      job.state.status = abort.signal.aborted ? 'cancelled' : 'failed';
      job.state.conclusion = abort.signal.aborted ? '本次检查已取消。' : `检查未完成：${error.message}`;
      job.state.code = error.code ?? 'RUNTIME_FAILED';
    }).finally(async () => {
      job.state.finishedAt = new Date().toISOString();
      try { await this.save(job); } catch { job.state.historyNotice = '本次运行摘要未能保存，重启后可能丢失；请保留当前依据。'; }
    });
    return this.snapshot(job);
  }
  find(root, id) {
    const job = id ? this.jobs.get(id) : [...this.jobs.values()].filter(j => j.root === root).at(-1);
    if (id && (!job || job.root !== root)) throw fault('RUNTIME_NOT_FOUND', '找不到此项目的运行检查；宿主重启后不会自动重跑');
    return job ?? null;
  }
  snapshot(job) {
    const previousNativeFailures = [];
    if (job.result?.sourceManifest) {
      const source = JSON.stringify(job.result.sourceManifest);
      for (const previous of this.jobs.values()) {
        if (previous === job) break;
        if (previous.root !== job.root || previous.engine !== job.engine || previous.state.status !== 'failed' || !previous.result?.sourceManifest || JSON.stringify(previous.result.sourceManifest) !== source) continue;
        const phase = ['execution', 'imported'].find(name => {
          const code = previous.result[name]?.exitCode;
          return Number.isInteger(code) && (code >>> 0) >= 0xc0000000;
        });
        if (phase) previousNativeFailures.push({ id: previous.state.id, startedAt: previous.state.startedAt, exitCode: previous.result[phase].exitCode, phase });
      }
    }
    return structuredClone({ ...job.state, previousNativeFailures,
      stabilityNotice: job.state.status === 'passed' && previousNativeFailures.length ? '本次检查通过，但这版工程曾异常退出；原因尚未核实，不能据此认定已修好或运行稳定。' : null,
    });
  }
  status(root, id) { const job = this.find(root, id); return job ? this.snapshot(job) : null; }
  async wait(root, id, { timeoutMs = maxWaitMs, signal } = {}) {
    if (typeof id !== 'string' || !id.trim()) throw fault('INVALID_REQUEST', '等待运行检查需要本次运行标识');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxWaitMs) throw fault('INVALID_REQUEST', '等待时间必须为 1 至 10000 毫秒');
    signal?.throwIfAborted();
    const job = this.find(root, id);
    if (!active(job) || !job.done) return this.snapshot(job);

    const timer = new AbortController();
    const waitSignal = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
    try {
      await Promise.race([job.done, delay(timeoutMs, undefined, { signal: waitSignal })]);
      signal?.throwIfAborted();
      return this.snapshot(job);
    } finally {
      timer.abort();
    }
  }
  cancel(root, id) {
    const job = this.find(root, id);
    if (!job) throw fault('RUNTIME_NOT_FOUND', '找不到运行检查');
    if (active(job)) { job.state.status = 'cancelling'; job.abort.abort(); }
    return this.snapshot(job);
  }
  evidence(root, id) {
    const job = this.find(root, id);
    if (!job?.result || job.state.restored) throw fault('EVIDENCE_UNAVAILABLE', '详细依据未保留在当前宿主中；历史摘要仍保留，不会自动重跑');
    const result = job.result;
    const logs = phase => phase ? { exitCode: phase.exitCode, timedOut: phase.timedOut, truncated: phase.truncated, stdout: phase.stdout.slice(0, 16000), stderr: phase.stderr.slice(0, 16000), displayTruncated: phase.stdout.length > 16000 || phase.stderr.length > 16000,
      ...(phase.sandbox ? { sandbox: phase.sandbox } : {}) } : null;
    return structuredClone({ ...this.snapshot(job), root: result.root, observations: result.observations, issues: result.issues, importIssues: result.importIssues, imported: logs(result.imported), execution: logs(result.execution), frameTiming: result.frameTiming, sandbox: result.sandbox === true });
  }
  async currentEvidence(root, id) {
    const evidence = this.evidence(root, id); const job = this.find(root, id);
    try {
      const current = await runtimeSourceManifest(root);
      evidence.sourceState = job.result.sourceManifest ? JSON.stringify(current) === JSON.stringify(job.result.sourceManifest) ? 'unchanged' : 'changed' : 'unknown';
    } catch { evidence.sourceState = 'unknown'; }
    return evidence;
  }
  async image(root, id, stepIndex) {
    const job = this.find(root, id);
    if (!Number.isInteger(stepIndex) || stepIndex < 0) throw fault('INVALID_EVIDENCE', '画面编号无效');
    const image = job?.result?.observations?.steps[stepIndex]?.image;
    if (!image) throw fault('EVIDENCE_UNAVAILABLE', '此步骤没有画面');
    const file = await confined(job.result.root, image);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1) throw fault('INVALID_EVIDENCE', '画面必须是独立普通文件');
    const tooLarge = () => fault('EVIDENCE_TOO_LARGE', '画面过大，请使用更小的窗口重新检查');
    if (stat.size > 8_000_000) throw tooLarge();
    const bytes = await fs.readFile(file);
    if (bytes.length > 8_000_000) throw tooLarge();
    if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw fault('INVALID_EVIDENCE', '画面文件不是 PNG');
    return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
  }
}
