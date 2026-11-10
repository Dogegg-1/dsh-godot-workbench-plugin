import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lifecycleStages, gddSections, prototypeBriefPolicy } from './lifecycle-schema.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const now = () => new Date().toISOString();
export function fault(code, message) { return Object.assign(new Error(message), { code }); }
export const STATE_LIMIT = 16 * 1024 * 1024;
export function validateState(state) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(state) || state.schemaVersion !== 1 || typeof state.projectId !== 'string' || !state.projectId || !Number.isSafeInteger(state.revision) || state.revision < 0 || !['tasks', 'diagnostics', 'events'].every(key => Array.isArray(state[key])) || (state.plan !== null && !object(state.plan))) throw fault('INVALID_STATE', '工作台记录格式损坏或版本不兼容，请先查看恢复记录；原文件未被覆盖');
  if (state.plan && (!['title', 'concept', 'experience', 'coreLoop', 'platform'].every(key => typeof state.plan[key] === 'string') || !['inScope', 'outOfScope', 'acceptance', 'assumptions', 'blockingQuestions'].every(key => Array.isArray(state.plan[key]) && state.plan[key].every(value => typeof value === 'string')))) throw fault('INVALID_STATE', '方案记录格式不完整，请先核查恢复版本');
  if (state.planningPolicy !== undefined && state.planningPolicy !== prototypeBriefPolicy) throw fault('INVALID_STATE', '无法识别该项目的开工条件，请核查工作台版本和记录。');
  if (state.tasks.some(task => !object(task) || typeof task.id !== 'string' || typeof task.title !== 'string' || !Array.isArray(task.dependsOn) || !Array.isArray(task.evidence) || !['pending', 'running', 'failed', 'cancelled', 'awaiting-review', 'accepted'].includes(task.status))) throw fault('INVALID_STATE', '任务记录格式不完整，请先核查恢复版本');
  const objects = value => Array.isArray(value) && value.every(object);
  if(state.qaRuns!==undefined&&(!objects(state.qaRuns)||state.qaRuns.some(run=>typeof run.id!=='string'||run.actor!=='local-user'||!object(run.basis)||!objects(run.results)||run.results.some(r=>!Number.isInteger(r.number)||!['passed','failed','not-tested'].includes(r.outcome)||typeof r.note!=='string'||typeof r.target!=='string')))) throw fault('INVALID_STATE','QA记录损坏，请保留记录并核查');
  const validStage = value => lifecycleStages.some(stage => stage.id === value);
  if (state.lifecycle !== undefined) {
    const value = state.lifecycle;
    if (!object(value) || !['prototype', 'full'].includes(value.mode) || !validStage(value.stage) || !Number.isSafeInteger(value.iteration) || value.iteration < 1 || !Number.isSafeInteger(value.version) || value.version < 1 || !objects(value.history) || value.history.length !== value.version || value.history.some(item => !validStage(item.from) || !validStage(item.to) || item.actor !== 'local-user' || !['mode','advance','iterate'].includes(item.action) || !object(item.basis) || typeof item.statement !== 'string' || !item.statement.trim())) throw fault('INVALID_STATE', '开发阶段记录损坏，请保留记录并核查');
  }
  if (state.plan?.gdd !== undefined && (!object(state.plan.gdd) || Object.entries(state.plan.gdd).some(([key,value]) => !Object.hasOwn(gddSections,key) || typeof value !== 'string'))) throw fault('INVALID_STATE', '设计详情记录损坏，请先核查恢复版本');
  if (state.tasks.some(task => task.summaryBasis !== undefined && (!object(task.summaryBasis) || !['summaryHash','planHash','fingerprint','at'].every(key=>typeof task.summaryBasis[key]==='string') || !objects(task.summaryBasis.files) || task.summaryBasis.files.length>1000 || task.summaryBasis.files.some(file=>typeof file.path!=='string'||typeof file.hash!=='string') || typeof task.summaryBasis.scanComplete!=='boolean'))) throw fault('INVALID_STATE', '摘要文件基线损坏，请保留记录并核查');
  if (state.temporaryFixes !== undefined && (!objects(state.temporaryFixes) || state.temporaryFixes.length > 100 || state.temporaryFixes.some(item => !['id', 'taskId', 'title', 'reason', 'scope', 'limitations', 'removalCondition', 'followUp'].every(key => typeof item[key] === 'string') || !Number.isSafeInteger(item.version) || item.version < 1 || !['open', 'resolved'].includes(item.status) || !Array.isArray(item.paths) || !item.paths.length || item.paths.length > 10 || item.paths.some(p => typeof p !== 'string') || (item.status === 'resolved' && (!object(item.resolution) || !object(item.resolution.hashes) || typeof item.resolution.verification !== 'string'))))) throw fault('INVALID_STATE', '临时修复记录格式不完整，请先核查恢复版本');
  const invalidReport = report => !object(report) || !objects(report.issues) || !object(report.aiReview) || (report.aiReview.findings !== undefined && !objects(report.aiReview.findings));
  if (state.diagnostics.some(invalidReport)) throw fault('INVALID_STATE', '检查记录格式不完整，请先核查恢复版本');
  if (state.automaticChecks !== undefined && (!objects(state.automaticChecks) || state.automaticChecks.some(check => !['id', 'taskId', 'executionId', 'requestHash'].every(key => typeof check[key] === 'string') || !['checking', 'completed', 'failed'].includes(check.status) || !['quick', 'engine', 'static'].includes(check.mode) || (check.mode === 'static' && (typeof check.engineSkippedReason !== 'string' || !check.engineSkippedReason.trim())) || !Array.isArray(check.paths) || check.paths.some(p => typeof p !== 'string')))) throw fault('INVALID_STATE', '自动检查记录格式不完整，请先核查恢复版本');
  if (state.fileChanges !== undefined && (!Array.isArray(state.fileChanges) || state.fileChanges.some(change => !object(change) || !['id', 'path', 'before', 'after'].every(key => typeof change[key] === 'string')))) throw fault('INVALID_STATE', '文件变更记录格式不完整，请先核查恢复版本');
  if (state.fileRecoveries !== undefined && (!objects(state.fileRecoveries) || state.fileRecoveries.some(item => !['id', 'path', 'statement', 'observed', 'selected'].every(key => typeof item[key] === 'string') || !['keep', 'before', 'after'].includes(item.choice)))) throw fault('INVALID_STATE', '文件恢复记录格式不完整，请保留现场后核查');
  if (state.fileBaselines !== undefined && (!object(state.fileBaselines) || Object.values(state.fileBaselines).some(baseline => !object(baseline) || !Array.isArray(baseline.files) || baseline.files.some(file => !object(file) || typeof file.path !== 'string' || typeof file.hash !== 'string')))) throw fault('INVALID_STATE', '文件基线记录格式不完整，请先核查恢复版本');
  return state;
}

export async function readRecord(root, relative, limit = STATE_LIMIT) {
  const file = await confined(root, relative, { mustExist: false });
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw fault('UNSUPPORTED_RECORD', '记录不是独立普通文件或超过读取限制，请保留现场后核查');
    const raw = await fs.readFile(file);
    if (raw.length > limit) throw fault('UNSUPPORTED_RECORD', '记录在读取期间变大，请重新核查');
    return { file, raw, hash: createHash('sha256').update(raw).digest('hex') };
  } catch (error) { if (error.code === 'ENOENT') return { file, raw: null, hash: 'missing' }; throw error; }
}
export async function durableRecord(file, raw) {
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
}
export async function saveStateSnapshot(root, raw) {
  const state = validateState(JSON.parse(raw.toString('utf8')));
  const hash = createHash('sha256').update(raw).digest('hex');
  const dir = await confined(root, '.game-workbench/state-history', { mustExist: false }); await fs.mkdir(dir, { recursive: true });
  const file = await confined(root, `.game-workbench/state-history/${state.revision}-${hash}.json`, { mustExist: false });
  try { await durableRecord(file, raw); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (createHash('sha256').update(await fs.readFile(file)).digest('hex') !== hash) throw fault('CORRUPT_SNAPSHOT', '记录快照校验失败，请保留快照后核查');
}

export async function confined(root, relative, { mustExist = true } = {}) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw fault('OUTSIDE_PROJECT', '路径必须位于项目内');
  const base = await fs.realpath(root);
  const target = path.resolve(base, relative);
  const resolvedRelative = path.relative(base, target);
  if (path.isAbsolute(resolvedRelative) || resolvedRelative === '..' || resolvedRelative.startsWith(`..${path.sep}`) || relative.includes(':')) throw fault('OUTSIDE_PROJECT', '路径解析后越出项目或含不支持的卷/流语法');
  const parts = resolvedRelative.split(path.sep).filter(Boolean);
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw fault('SYMLINK_PATH', '项目操作不跟随符号链接或目录联接');
    } catch (error) {
      if (error.code !== 'ENOENT' || mustExist) throw error;
      break;
    }
  }
  return target;
}

export class Store {
  constructor(root) { this.root = path.resolve(root); }
  async prepare() {
    await fs.access(this.root);
    this.dir = await confined(this.root, '.game-workbench', { mustExist: false });
    await fs.mkdir(this.dir, { recursive: true });
    return this;
  }
  async read() {
    const { raw } = await readRecord(this.root, '.game-workbench/state.json');
    if (raw !== null) {
      try { return validateState(JSON.parse(raw.toString('utf8'))); }
      catch (error) { if (error instanceof SyntaxError) throw fault('INVALID_STATE', '工作台记录无法解析，请查看恢复记录；原文件未被覆盖'); throw error; }
    }
    for (const dir of ['state-history', 'file-journal']) {
      const folder = await confined(this.root, `.game-workbench/${dir}`, { mustExist: false });
      const names = await fs.readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      if (names.some(name => name.endsWith('.json'))) throw fault('STATE_MISSING', '发现历史记录但当前记录丢失，请先恢复，不能作为新工程覆盖');
    }
    return { schemaVersion: 1, projectId: randomUUID(), revision: 0, plan: null, approval: null, tasks: [], diagnostics: [], events: [] };
  }
  async transaction(change) {
    await this.prepare();
    const recoveryGate = await confined(this.root, '.game-workbench/record-recovery.lock', { mustExist: false });
    const checkRecovery = async () => { try { await fs.lstat(recoveryGate); } catch (error) { if (error.code === 'ENOENT') return; throw error; } throw fault('RECORD_RECOVERY_BUSY', '记录正在恢复或恢复过程曾中断，请先核查恢复现场'); };
    await checkRecovery();
    const lock = await confined(this.root, '.game-workbench/write.lock', { mustExist: false });
    let handle;
    try { handle = await fs.open(lock, 'wx'); }
    catch (e) { if (e.code === 'EEXIST') throw fault('PROJECT_BUSY', '项目记录正在写入，或上次写入异常中断；请核查后重试'); throw e; }
    const temp = path.join(this.dir, `state-${randomUUID()}.tmp`);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: now() }));
      await checkRecovery();
      const state = await this.read();
      const previous = await readRecord(this.root, '.game-workbench/state.json');
      if (previous.raw) await saveStateSnapshot(this.root, previous.raw);
      const result = await change(state);
      state.revision++;
      state.updatedAt = now();
      validateState(state);
      const raw = JSON.stringify(state, null, 2);
      if (Buffer.byteLength(raw) > STATE_LIMIT) throw fault('STATE_TOO_LARGE', '工作台记录超过 16 MiB，请先归档；当前状态尚未覆盖');
      await durableRecord(temp, raw);
      await fs.rename(temp, await confined(this.root, '.game-workbench/state.json', { mustExist: false }));
      // The state has committed. A backup failure must not invite replay of a
      // successful mutation; surface it separately through status.
      try { await saveStateSnapshot(this.root, Buffer.from(raw)); this.backupWarning = null; }
      catch (error) { this.backupWarning = error.message; }
      return result;
    } finally {
      await handle.close();
      await fs.rm(lock, { force: true });
      await fs.rm(temp, { force: true });
    }
  }
}

export function event(state, type, data) {
  // Queuing changes the report's workflow fingerprint. Keep its separate engineering evidence.
  if (['plan-revised', 'plan-confirmed', 'task-start', 'task-submit', 'task-fail', 'task-retry', 'task-reviewed', 'task-cancelled', 'file-changed', 'file-rolled-back', 'temporary-fix-changed'].includes(type)) for (const report of state.diagnostics) report.stale = true;
  state.events.push({ id: randomUUID(), at: now(), type, data });
}
