import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSaveDirectoryProbe, verifySaveDirectory } from './save-directory.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { confined, fault, readRecord } from './storage.mjs';
import { runProcess } from './project.mjs';
import { summarizeFrameTimes } from './frame-timing.mjs';
import { createIsolatedRuntime } from './windows-runtime-isolation.mjs';

const excluded = new Set(['.git', '.godot', '.game-workbench', 'node_modules', 'logs', 'tmp', 'export', 'build']);
const omit = name => excluded.has(name) || name.startsWith('.') || /credential|secret|password|token/i.test(name);
const hash = data => createHash('sha256').update(data).digest('hex');
export async function runtimeSourceManifest(root) {
  const files = []; let bytes = 0;
  async function walk(dir = '') {
    for (const entry of await fs.readdir(await confined(root, dir), { withFileTypes: true })) {
      if (omit(entry.name)) continue;
      const relative = path.posix.join(dir, entry.name); const file = await confined(root, relative);
      if (entry.isDirectory()) await walk(relative);
      else {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.nlink !== 1) throw fault('UNSUPPORTED_FILE', '观测不支持链接或特殊文件');
        bytes += stat.size;
        if (bytes > 256_000_000 || files.length >= 10000) throw fault('COPY_LIMIT', '工程超出观测容量');
        files.push({ path: relative, hash: hash(await fs.readFile(file)) });
      }
    }
  }
  await walk(); return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function validateScenario(input) {
  if (!input || !Array.isArray(input.steps) || !input.steps.length || input.steps.length > 100) throw fault('INVALID_SCENARIO', '观测需要 1 至 100 个步骤');
  const size = input.size ?? [960, 640];
  if (!Array.isArray(size) || size.length !== 2 || size.some(n => !Number.isInteger(n) || n < 320 || n > 2560)) throw fault('INVALID_SCENARIO', '窗口尺寸须在 320 至 2560 之间');
  let frames = 0;
  const steps = input.steps.map((step, index) => {
    if (!step || !['wait', 'sample', 'click', 'key', 'assert', 'capture'].includes(step.type)) throw fault('INVALID_SCENARIO', `步骤 ${index + 1} 类型无效`);
    const result = { type: step.type, label: String(step.label ?? `步骤 ${index + 1}`).slice(0, 160) };
    if (['click', 'assert'].includes(step.type)) {
      if (typeof step.node !== 'string' || step.node.length > 256 || step.node.startsWith('/') || step.node.includes('..') || step.node.includes(':')) throw fault('INVALID_SCENARIO', '节点路径必须相对于游戏根节点');
      result.node = step.node;
    }
    if (step.type === 'assert') {
      if (typeof step.property !== 'string' || !/^[\w]+$/.test(step.property) || !['string', 'number', 'boolean'].includes(typeof step.equals) || (typeof step.equals === 'number' && !Number.isFinite(step.equals))) throw fault('INVALID_SCENARIO', '断言仅支持单个属性与明确的文本、数字或布尔值');
      result.property = step.property; result.equals = step.equals;
    }
    if (step.type === 'key') {
      if (!Number.isInteger(step.code) || step.code < 1 || step.code > 0x1ffffff || typeof step.pressed !== 'boolean') throw fault('INVALID_SCENARIO', '按键需要有效键码及按下/松开状态');
      result.code = step.code; result.pressed = step.pressed; result.echo = step.echo === true;
    }
    if (step.type === 'wait') {
      if (!Number.isInteger(step.frames) || step.frames < 1 || step.frames > 600) throw fault('INVALID_SCENARIO', '每步等待须为 1 至 600 帧');
      result.frames = step.frames; frames += step.frames;
    }
    if (step.type === 'sample') {
      const count = step.frames ?? 180; const warmup = step.warmupFrames ?? 60;
      if (!Number.isInteger(count) || count < 60 || count > 600 || !Number.isInteger(warmup) || warmup < 30 || warmup > 300) throw fault('INVALID_SCENARIO', '帧时间采样需60–600帧，预热需30–300帧');
      result.frames = count; result.warmupFrames = warmup; frames += count + warmup;
    }
    return result;
  });
  if (frames > 1800) throw fault('INVALID_SCENARIO', '总等待不超过 1800 帧');
  return { size, steps };
}

const isolationNotices = [
  ['ERROR: Condition "res != ((HRESULT)0x00000000)" is true. Returning: String()', 'at: get_system_dir (platform/windows/os_windows.cpp:2502)', 4],
  ['ERROR: Call to GetAdaptersAddresses failed with error 5.', 'at: get_local_interfaces (drivers/windows/ip_windows.cpp:117)', 1],
  ['ERROR: Method/function failed. Returning: ""', 'at: get_filesystem_type (drivers/windows/dir_access_windows.cpp:412)', 2],
  ['ERROR: Failed to read the root certificate store.', 'at: get_system_ca_certificates (platform/windows/os_windows.cpp:2582)', 1],
  ['ERROR: Condition "_sock == (SOCKET)(~0)" is true. Returning: FAILED', 'at: open (drivers/windows/net_socket_winsock.cpp:238)', 2],
  ['ERROR: Condition "err != OK" is true. Returning: ERR_CANT_CREATE', 'at: listen (core/io/tcp_server.cpp:56)', 2],
];

export function runtimeIssues(output, { isolateRuntime = false } = {}) {
  const issues = []; let current;
  for (const line of output.split(/\r?\n/)) {
    if (/^(?:SCRIPT ERROR:|ERROR:|WARNING:)/.test(line)) {
      current = { severity: line.startsWith('WARNING:') ? 'warning' : 'error', message: line, stack: [] }; issues.push(current);
    } else if (current && /^\s+/.test(line) && line.trim()) current.stack.push(line);
    else current = null;
  }
  const groups = new Map();
  issues.forEach((issue, index) => {
    const key = JSON.stringify(issue); const previous = groups.get(key);
    if (previous) { previous.count++; previous.lastOccurrence = index; }
    else groups.set(key, { ...issue, count: 1, firstOccurrence: index, lastOccurrence: index });
  });
  const unique = [...groups.values()];
  // LPAC denies some optional engine services during startup. Keep the logs,
  // and downgrade only the exact, bounded messages observed on this build.
  if (!isolateRuntime || !/^Godot Engine v4\.7\.2\.stable\.official\.ed1daf0bf\b/m.test(output)) return unique;
  return unique.map(issue => {
    const known = issue.stack.length === 1 && isolationNotices.some(([message, frame, maximum]) =>
      issue.message === message && issue.stack[0].trim() === frame && issue.count <= maximum);
    return known ? { ...issue, severity: 'warning', kind: 'isolation-notice' } : issue;
  });
}

export async function observeRuntime({ projectRoot, engine, outputParent, scenario, signal, isolateRuntime = false }) {
  const normalized = validateScenario(scenario);
  signal?.throwIfAborted();
  if (!path.isAbsolute(engine)) throw fault('INVALID_ENGINE', '需要 Godot 完整路径');
  const source = await fs.realpath(projectRoot); const parent = await fs.realpath(outputParent);
  const relative = path.relative(source, parent);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw fault('INVALID_OUTPUT', '观测副本必须放在源工程外');
  const root = await fs.mkdtemp(path.join(parent, 'runtime-'));
  const game = path.join(root, 'game'); await fs.mkdir(game);
  let bytes = 0, files = 0; const sourceManifest = [];
  async function copy(relativeDir = '') {
    for (const entry of await fs.readdir(await confined(source, relativeDir), { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (omit(entry.name)) continue;
      const relativeFile = path.join(relativeDir, entry.name);
      const from = await confined(source, relativeFile); const to = path.join(game, relativeFile);
      if (entry.isDirectory()) { await fs.mkdir(to); await copy(relativeFile); }
      else {
        const stat = await fs.lstat(from);
        if (!stat.isFile() || stat.nlink !== 1) throw fault('UNSUPPORTED_FILE', '观测副本不支持链接或特殊文件');
        bytes += stat.size; files++;
        if (bytes > 256_000_000 || files > 10000) throw fault('COPY_LIMIT', '工程超出本版观测副本容量，请缩小验证工程');
        const content = await fs.readFile(from);
        await fs.writeFile(to, content, { flag: 'wx' });
        sourceManifest.push({ path: relativeFile.split(path.sep).join('/'), hash: hash(content) });
      }
    }
  }
  await copy(); await fs.access(path.join(game, 'project.godot'));
  const run = isolateRuntime ? await createIsolatedRuntime({ root, engine, signal }) : runProcess;
  // Never overwrite an existing override: it could contain essential project settings.
  const id = randomUUID(); const harness = `dsh_observe_${id.replaceAll('-', '')}`;
  await fs.writeFile(path.join(game, 'override.cfg'), `[application]\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name="dsh-workbench-tests/${id}"\n`, { flag: 'wx' });
  const saveProbe = await createSaveDirectoryProbe(game);
  let saveDirectory;
  try { saveDirectory = await verifySaveDirectory({ executable: engine, project: game, script: saveProbe, expected: `dsh-workbench-tests/${id}`, signal, run, containedIn: isolateRuntime ? game : undefined }); }
  catch (error) { await fs.writeFile(path.join(root, 'save-directory.json'), JSON.stringify(error.evidence ?? { message: error.message }, null, 2)); throw error; }
  await fs.writeFile(path.join(root, 'save-directory.json'), JSON.stringify(saveDirectory, null, 2));
  await fs.mkdir(path.join(game, harness));
  await fs.copyFile(new URL('./runtime-runner.gd', import.meta.url), path.join(game, harness, 'runner.gd'));
  await fs.writeFile(path.join(game, harness, 'scenario.json'), JSON.stringify(normalized));
  const imported = await run(engine, ['--headless', '--path', game, '--editor', '--import'], { cwd: game, signal, timeoutMs: 60000 });
  const importIssues = runtimeIssues(`${imported.stdout}\n${imported.stderr}`, { isolateRuntime: imported.sandbox === 'windows-lpac' });
  let execution = null, observations = null;
  if (imported.exitCode === 0 && !imported.timedOut && !imported.truncated && !importIssues.some(i => i.severity === 'error')) {
    // Let Godot use the project's renderer and its own supported fallback.
    // Forcing Compatibility here could hide Forward+/Mobile rendering defects.
    execution = await run(engine, ['--path', game, '--resolution', normalized.size.join('x'), '--script', `res://${harness}/runner.gd`], { cwd: game, signal, timeoutMs: 60000, windowed: true });
    const { raw } = await readRecord(root, `game/${harness}/result.json`, 2_000_000);
    if (raw) observations = JSON.parse(raw.toString('utf8'));
    for (const step of observations?.steps ?? []) if (step.image) {
      if (!/^frame-\d{3}\.png$/.test(step.image)) throw fault('INVALID_EVIDENCE', '运行返回了无效画面路径');
      await confined(root, `game/${harness}/${step.image}`);
      step.image = `game/${harness}/${step.image}`;
    }
  }
  const issues = execution ? runtimeIssues(`${execution.stdout}\n${execution.stderr}`) : [];
  const timing = [];
  for (const [index, step] of (observations?.steps ?? []).entries()) if (step.type === 'sample' && step.passed) {
    if (step.samplesMs?.length !== normalized.steps[index]?.frames) throw fault('INVALID_TIMING', '帧时间样本不完整');
    step.timing = summarizeFrameTimes(step.samplesMs);
    timing.push({ stepIndex: index, label: step.label, ...step.timing, environment: step.environment, warmupFrames: normalized.steps[index].warmupFrames });
  }
  const passed = Boolean(execution?.exitCode === 0 && !execution.timedOut && !execution.truncated && observations?.complete && observations.steps.length === normalized.steps.length && observations.steps.every(s => s.passed) && !issues.some(i => i.severity === 'error'));
  const hasAssertions = normalized.steps.some(step => step.type === 'assert');
  const nativeExit = execution?.exitCode >>> 0;
  const failedConclusion = isolateRuntime && !observations && nativeExit >= 0xc0000000
    ? `受限游戏窗口启动时提前退出（0x${nativeExit.toString(16).toUpperCase()}），没有收到点击或画面依据。`
    : '本次运行检查未通过，请查看失败步骤和运行日志。';
  const passedConclusion = hasAssertions ? '本次操作和属性检查通过，请查看画面确认显示效果。' : '已启动并完成本次观测，尚未检查具体玩法。';
  const result = { passed, conclusion: passed ? passedConclusion : failedConclusion, root,
    sourceManifest: sourceManifest.sort((a, b) => a.path.localeCompare(b.path)), copiedFiles: files,
    imported, importIssues, execution, issues, observations, humanPlaytest: false, frameTiming: timing.length ? timing : 'not-measured', sandbox: isolateRuntime };
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(result, null, 2));
  return result;
}
