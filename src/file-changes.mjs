import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { confined, fault, event, now, digest } from './storage.mjs';
import { requireApproval } from './planning.mjs';
import { inspectProject } from './project.mjs';

const LIMIT = 16 * 1024 * 1024;
const hash = data => createHash('sha256').update(data).digest('hex');
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const missing = 'missing';
function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || path.isAbsolute(value)) throw fault('INVALID_FILE', '需要工程内的相对文件路径');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some(p => !p || p === '..' || p.startsWith('.') || /[. ]$|:/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)
    || /^(node_modules|logs|tmp|build|export|saves?|savegames?)$/i.test(p) || /credential|secret|token|password/i.test(p))) throw fault('EXCLUDED_FILE', '此路径属于缓存、私密数据、存档或不支持的路径；不纳入普通工程修改与回退');
  if (/^(save|savegame)([._-].*)?\.(json|dat|bin|sav)$/i.test(parts.at(-1))) throw fault('EXCLUDED_FILE', '玩家存档不纳入工程文件回退');
  return parts.join('/');
}
async function bytesAt(root, relative, linkedStage) {
  const file = await confined(root, relative, { mustExist: false });
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw fault('UNSUPPORTED_FILE', '只支持普通文件，不修改目录、链接或共享硬链接');
    if (stat.nlink > 1) {
      const stage = linkedStage && await fs.lstat(await confined(root, linkedStage)).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (stat.nlink !== 2 || !stage?.isFile() || stage.dev !== stat.dev || stage.ino !== stat.ino) throw fault('UNSUPPORTED_FILE', '文件含未知共享硬链接，保留现场后核查');
    }
    if (stat.size > LIMIT) throw fault('FILE_TOO_LARGE', '单文件超过 16 MiB，尚未修改；请先规划大文件处理方式');
    const data = await fs.readFile(file);
    if (data.length > LIMIT) throw fault('FILE_TOO_LARGE', '文件在读取时增大，尚未修改');
    return data;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const identity = data => data === null ? missing : hash(data);
async function metadataDir(root, relative) {
  const target = await confined(root, relative, { mustExist: false });
  await fs.mkdir(target, { recursive: true });
  return await confined(root, relative);
}
async function durable(file, data) {
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}
async function blob(root, data) {
  if (data === null) return missing;
  const id = hash(data);
  await metadataDir(root, '.game-workbench/versions');
  const target = await confined(root, `.game-workbench/versions/${id}`, { mustExist: false });
  try { await durable(target, data); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (hash(await fs.readFile(target)) !== id) throw fault('CORRUPT_VERSION', '保存的文件版本校验失败，未继续修改');
  return id;
}
async function loadBlob(root, id) {
  if (id === missing) return null;
  if (!/^[a-f0-9]{64}$/.test(id)) throw fault('CORRUPT_VERSION', '文件版本标识无效');
  const file = await confined(root, `.game-workbench/versions/${id}`);
  if ((await fs.stat(file)).size > LIMIT) throw fault('CORRUPT_VERSION', '文件版本超出大小限制');
  const data = await fs.readFile(file);
  if (hash(data) !== id) throw fault('CORRUPT_VERSION', '保存的文件版本已变化，拒绝恢复');
  return data;
}
function contentView(data) {
  if (data === null) return { encoding: 'utf8', content: null, bytes: 0 };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (text.includes('\0')) throw new Error('binary');
    return { encoding: 'utf8', content: text.slice(0, 32000), truncated: text.length > 32000, bytes: data.length };
  } catch { return { encoding: 'binary', content: null, bytes: data.length }; }
}
export async function readProjectFile(root, { path: input }) {
  const relative = relativePath(input); const data = await bytesAt(root, relative);
  return { path: relative, hash: identity(data), ...contentView(data), note: '写入须传当前 hash；truncated=true 时此内容不完整，不应据此重写整个文件。' };
}
export async function pendingFileOperations(root, state) {
  let dir;
  try { dir = await confined(root, '.game-workbench/file-journal'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const known = new Set([...(state.fileChanges ?? []), ...(state.fileRecoveries ?? [])].map(c => c.id));
  const pending = [];
  for (const name of await fs.readdir(dir)) {
    if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
    const file = await confined(root, `.game-workbench/file-journal/${name}`);
    if ((await fs.stat(file)).size > 16000) throw fault('INVALID_JOURNAL', '文件恢复记录过大，请保留现场后核查');
    const entry = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!known.has(entry.id) && entry.id === name.slice(0, -5)) pending.push(entry);
  }
  return pending;
}
export async function assertNoFileRecovery(root, state) {
  if ((await pendingFileOperations(root, state)).length) throw fault('FILE_RECOVERY_REQUIRED', '上次文件操作未完成记账，原版与目标版均已留存。请先核查恢复记录，暂不继续写入。');
}

async function recoveryView(root, state, operationId) {
  const entries = await pendingFileOperations(root, state);
  if (entries.length > 100) throw fault('RECOVERY_LIMIT', '中断记录超过 100 项，请保留现场后分批核查');
  const operations = [];
  for (const entry of entries) {
    const validHash = value => value === missing || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
    if (!/^[a-f0-9-]+$/.test(entry.id) || !validHash(entry.before) || !validHash(entry.after) || !['edit', 'rollback', 'recovery'].includes(entry.kind) || typeof entry.taskId !== 'string' || typeof entry.executionId !== 'string') throw fault('INVALID_JOURNAL', '中断记录格式损坏，请保留原件核查');
    const relative = relativePath(entry.path);
    const stagePath = `.game-workbench/file-journal/${entry.id}.staged`;
    const displacedPath = `.game-workbench/file-journal/${entry.id}.displaced`;
    const before = await loadBlob(root, entry.before), after = await loadBlob(root, entry.after);
    const current = await bytesAt(root, relative, stagePath), displaced = await bytesAt(root, displacedPath);
    const stage = await bytesAt(root, stagePath, relative);
    const currentHash = identity(current), displacedHash = identity(displaced);
    // A vacant path after rename is an expected interruption point. Any new
    // third version is a conflict, even when the user asks to restore a blob.
    const conflict = ![missing, entry.before, entry.after].includes(currentHash)
      || (displacedHash !== missing && displacedHash !== entry.before);
    const item = { id: entry.id, taskId: entry.taskId, path: relative, kind: entry.kind,
      before: entry.before, after: entry.after, current: currentHash, displaced: displacedHash,
      staged: identity(stage), conflict, displacedPath, stagePath,
      choices: conflict ? ['keep'] : ['keep', 'before', 'after'] };
    if (entry.id === operationId) item.detail = Object.fromEntries(Object.entries({before, after, current, displaced}).map(([name, data]) => [name, contentView(data)]));
    operations.push(item);
  }
  return { operations, token: digest({ revision: state.revision, operations: operations.map(({detail, ...item}) => item) }),
    note: '保留当前版本不会认领用户改动。原件和目标版继续留存；选择恢复会修改该文件，其他文件和玩家存档保持现状。操作后须重新诊断和验收。' };
}
export async function inspectFileRecovery(workbench, { operationId } = {}) {
  return recoveryView(workbench.root, await workbench.store.read(), operationId);
}
export async function resolveFileRecovery(workbench, { operationId, token, choice, statement, stoppedConfirmed } = {}) {
  if (!['keep', 'before', 'after'].includes(choice) || typeof token !== 'string' || typeof statement !== 'string' || !statement.trim() || statement.length > 4000 || stoppedConfirmed !== true) throw fault('INVALID_RECOVERY', '请核对版本、填写原因，并确认 Agent 已停止及编辑器内容已保存');
  const committed = [];
  try {
    return await workbench.store.transaction(async state => {
      if (state.tasks.some(t => t.status === 'running')) throw fault('TASK_RUNNING', '请先停止任务或核查中断任务，再恢复文件');
      const preview = await recoveryView(workbench.root, state);
      if (preview.token !== token) throw fault('STALE_RECOVERY', '文件或记录已变化，请重新核对版本');
      const item = preview.operations.find(entry => entry.id === operationId);
      if (!item) throw fault('UNKNOWN_RECOVERY', '此操作已处理或不存在');
      if (!item.choices.includes(choice)) throw fault('FILE_CONFLICT', '检测到用户后续版本，只能保留当前文件；请先人工比较合并，不能自动覆盖');
      const entry = (await pendingFileOperations(workbench.root, state)).find(entry => entry.id === operationId);
      // Remove only our matching staging link. The working file keeps the same
      // inode and bytes; unrelated shared links were rejected during preview.
      const target = await confined(workbench.root, item.path, {mustExist:false});
      const targetStat = await fs.lstat(target).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (targetStat?.nlink === 2) {
        const stage = await confined(workbench.root, item.stagePath);
        const stat = await fs.lstat(stage);
        if (stat.dev !== targetStat.dev || stat.ino !== targetStat.ino) throw fault('STALE_RECOVERY', '暂存链接变化，请重新核对');
        await fs.unlink(stage);
      }
      const observedCurrent = await bytesAt(workbench.root, item.path), observedDisplaced = await bytesAt(workbench.root, item.displacedPath);
      if (identity(observedCurrent) !== item.current || identity(observedDisplaced) !== item.displaced) throw fault('STALE_RECOVERY', '文件再次变化，未覆盖；请重新核对');
      await blob(workbench.root, observedCurrent); await blob(workbench.root, observedDisplaced);
      const desired = choice === 'keep' ? item.current : item[choice];
      if (desired !== item.current) {
        const change = { id: randomUUID(), at: now(), taskId: entry.taskId, executionId: entry.executionId, path: item.path, before: item.current, after: desired, kind: 'recovery', statement: statement.trim() };
        if (item.current !== missing) change.displacedPath = `.game-workbench/file-journal/${change.id}.displaced`;
        await replaceFile(workbench.root, change, await bytesAt(workbench.root, item.path), await loadBlob(workbench.root, desired));
        (state.fileChanges ??= []).push(change); committed.push(change.id);
      }
      // Only a known intended result may be attributed to the original task.
      if (!item.conflict && desired === entry.after) (state.fileChanges ??= []).push(entry);
      const resolution = { id: entry.id, at: now(), path: item.path, choice, statement: statement.trim(), observed: item.current, displaced: item.displaced, selected: desired, conflict: item.conflict, verification: 'not-run' };
      (state.fileRecoveries ??= []).push(resolution);
      for (const task of state.tasks) if (['accepted', 'awaiting-review'].includes(task.status)) { task.status = 'failed'; task.updatedAt = now(); }
      for (const report of state.diagnostics) report.stale = true;
      event(state, 'file-recovery-resolved', resolution);
      if (identity(await bytesAt(workbench.root, item.path)) !== desired || identity(await bytesAt(workbench.root, item.displacedPath)) !== item.displaced) throw fault('STALE_RECOVERY', '恢复过程中发生新编辑，各版本已保留，请重新核查中断记录');
      return { ...resolution, message: choice === 'keep' ? '已保留当前文件并记录处理结果。原件仍在，需要重新诊断。' : '已恢复所选文件版本并保留原件，需要重新诊断和验收。' };
    });
  } finally {
    const state = await workbench.store.read();
    for (const id of committed) if (state.fileChanges?.some(c => c.id === id)) await cleanJournal(workbench.root, id);
  }
}

// Preserve the actual displaced file before publishing a replacement. Exclusive
// links refuse a file created by an editor during the swap. There is no global
// transaction with external editors: interruption remains a visible journal.
async function replaceFile(root, change, before, after) {
  const relative = relativePath(change.path);
  await blob(root, before); await blob(root, after);
  const journalDir = await metadataDir(root, '.game-workbench/file-journal');
  const journal = path.join(journalDir, `${change.id}.json`);
  const displacedRelative = `.game-workbench/file-journal/${change.id}.displaced`;
  const displaced = await confined(root, displacedRelative, { mustExist: false });
  const target = await confined(root, relative, { mustExist: false });
  if (identity(await bytesAt(root, relative)) !== change.before) throw fault('FILE_CONFLICT', '文件自读取后发生变化，未覆盖；请重新读取并核对');
  const parentRelative = path.posix.dirname(relative);
  if (after !== null && parentRelative !== '.') await metadataDir(root, parentRelative);
  await durable(journal, JSON.stringify({ ...change, displacedPath: displacedRelative }));
  if (before !== null) {
    await fs.rename(await confined(root, relative), displaced);
    if (identity(await fs.readFile(displaced)) !== change.before) {
      // A concurrent editor won the race. Put its bytes back only if the path
      // is still vacant; never replace a newly-created working copy.
      try { await fs.copyFile(displaced, target, constants.COPYFILE_EXCL); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      throw fault('FILE_RECOVERY_REQUIRED', '移动文件期间检测到并发编辑，双方内容已保留，请核查恢复记录');
    }
  }
  if (after !== null) {
    // Copy to a distinct inode: editing the project must never alter the blob.
    const staged = await confined(root, `.game-workbench/file-journal/${change.id}.staged`, { mustExist: false });
    await durable(staged, after);
    await fs.link(staged, await confined(root, relative, { mustExist: false })).catch(error => { if (error.code === 'EEXIST') throw fault('FILE_RECOVERY_REQUIRED', '文件路径出现新的用户内容，未覆盖；请核查保存的版本'); throw error; });
    await fs.unlink(staged);
  }
  if (identity(await bytesAt(root, relative)) !== change.after) throw fault('FILE_RECOVERY_REQUIRED', '写入期间文件再次变化，已保留版本，请核查恢复记录');
}
async function cleanJournal(root, id) {
  // Called only after the state transaction committed. A crash before this is
  // harmless: committed operation IDs are excluded from pending recovery.
  // Keep the displaced inode: an editor may still hold an old file handle and
  // write to it after the swap. Deleting it would lose that user's bytes.
  for (const suffix of ['.json', '.staged']) {
    const file = await confined(root, `.game-workbench/file-journal/${id}${suffix}`, { mustExist: false });
    await fs.rm(file, { force: true }).catch(() => {});
  }
}
export async function applyFileChange(workbench, { taskId, executionId, path: input, expectedHash, action = 'write', content, encoding = 'utf8' }) {
  const relative = relativePath(input);
  if (!['write', 'delete'].includes(action) || typeof expectedHash !== 'string') throw fault('INVALID_FILE_CHANGE', '需明确 write/delete 和读取文件时得到的 expectedHash（新文件为 missing）');
  let after = null;
  if (action === 'write') {
    if (typeof content !== 'string' || content.length > LIMIT * 1.4 || !['utf8', 'base64'].includes(encoding)) throw fault('INVALID_FILE_CHANGE', '写入需要 utf8/base64 内容，单文件不超过 16 MiB');
    after = Buffer.from(content, encoding);
    if (after.length > LIMIT || (encoding === 'base64' && after.toString('base64') !== content)) throw fault('INVALID_FILE_CHANGE', '文件过大或 base64 格式不规范');
  }
  const result = await workbench.store.transaction(async state => {
    await assertNoFileRecovery(workbench.root, state); requireApproval(state);
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status !== 'running' || !task.execution || task.execution.id !== executionId || task.planHash !== digest(state.plan)) throw fault('STALE_EXECUTION', '只有当前已启动任务的本轮执行可以写入文件');
    const before = await bytesAt(workbench.root, relative);
    if (identity(before) !== expectedHash) throw fault('FILE_CONFLICT', '文件与读取时不同，未修改。请重新读取并核对用户改动');
    const previous = (state.fileChanges ?? []).filter(c => c.executionId === executionId && key(c.path) === key(relative)).at(-1);
    if (previous && previous.after !== expectedHash) throw fault('MIXED_EDITS', '该文件包含本轮受控写入以外的改动，请先停止任务并核对，不能将混合改动归为本任务');
    for (const edit of state.fileChanges ?? []) if (edit.executionId === executionId && key(edit.path) === key(relative) && edit.displacedPath && identity(await bytesAt(workbench.root, edit.displacedPath)) !== edit.before) throw fault('MIXED_EDITS', '编辑器对旧文件版本有迟到写入，内容已保留，请先核对并发版本');
    if (expectedHash === identity(after)) return { unchanged: true, path: relative, hash: expectedHash };
    const change = { id: randomUUID(), at: now(), taskId, executionId, path: relative, before: identity(before), after: identity(after), action, kind: 'edit' };
    if (before !== null) change.displacedPath = `.game-workbench/file-journal/${change.id}.displaced`;
    await replaceFile(workbench.root, change, before, after);
    (state.fileChanges ??= []).push(change); event(state, 'file-changed', change);
    return change;
  });
  if (result.id) await cleanJournal(workbench.root, result.id);
  return result;
}

async function changesFor(root, state, taskId, executionId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) throw fault('UNKNOWN_TASK', '任务不存在');
  const selected = executionId ?? task.execution?.id;
  const edits = (state.fileChanges ?? []).filter(c => c.taskId === taskId && c.executionId === selected && c.kind === 'edit');
  const grouped = new Map();
  for (const edit of edits) {
    let archiveChanged = false;
    if (edit.displacedPath) archiveChanged = identity(await bytesAt(root, edit.displacedPath)) !== edit.before;
    const existing = grouped.get(key(edit.path));
    if (existing) { if (existing.after !== edit.before || archiveChanged) existing.mixed = true; existing.after = edit.after; }
    else grouped.set(key(edit.path), { path: edit.path, before: edit.before, after: edit.after, mixed: archiveChanged });
  }
  const files = [];
  for (const value of grouped.values()) {
    let current;
    try { current = identity(await bytesAt(root, value.path)); }
    catch (error) { current = `unavailable:${error.code ?? 'READ_FAILED'}`; }
    files.push({ ...value, current, state: value.mixed ? 'conflict' : value.before === value.after ? 'unchanged' : current === value.before ? 'restored' : current !== value.after ? 'conflict' : 'ready', operation: value.before === missing ? '删除本轮新建文件' : value.after === missing ? '恢复本轮删除文件' : '恢复本轮修改前版本' });
  }
  const baseline = state.fileBaselines?.[selected];
  const scan = baseline ? await inspectProject(root) : null;
  const untracked = [];
  if (baseline) {
    const old = new Map(baseline.files.map(f => [key(f.path), f])); const current = new Map(scan.files.map(f => [key(f.path), f]));
    for (const name of new Set([...old.keys(), ...current.keys()])) if (!grouped.has(name) && old.get(name)?.hash !== current.get(name)?.hash) untracked.push((current.get(name) ?? old.get(name)).path);
  }
  const executions = [...new Map((state.fileChanges ?? []).filter(c => c.taskId === taskId && c.kind === 'edit').map(c => [c.executionId, { id: c.executionId, at: c.at }])).values()];
  if (task.execution && !executions.some(run => run.id === task.execution.id)) executions.push({ id: task.execution.id, at: task.execution.startedAt });
  return { taskId, executionId: selected ?? null, executions, files, untracked, scanComplete: Boolean(baseline?.complete && scan?.complete), token: digest({ revision: state.revision, taskId, executionId: selected, files }), revision: state.revision, taskStatus: task.status,
    note: '仅列出受控工具记录的修改；普通命令、编辑器未保存内容和玩家存档不包含在此。任务期间也请先保存编辑器内容。' };
}
export async function previewFileChanges(workbench, { taskId, executionId, path: detailPath } = {}) {
  const state = await workbench.store.read();
  const preview = await changesFor(workbench.root, state, taskId, executionId);
  if (detailPath) {
    const file = preview.files.find(file => key(file.path) === key(relativePath(detailPath)));
    if (!file) throw fault('UNKNOWN_FILE_CHANGE', '此文件不在本轮修改记录中');
    preview.detail = { path: file.path, before: contentView(await loadBlob(workbench.root, file.before)), after: contentView(await loadBlob(workbench.root, file.after)), current: contentView(await bytesAt(workbench.root, file.path)) };
    preview.detail.preserved = [];
    for (const entry of state.fileChanges ?? []) if (entry.taskId === taskId && entry.executionId === preview.executionId && key(entry.path) === key(file.path) && entry.displacedPath) {
      const data = await bytesAt(workbench.root, entry.displacedPath);
      if (identity(data) !== entry.before) preview.detail.preserved.push({ path: entry.displacedPath, ...contentView(data) });
    }
  }
  return preview;
}
export async function rollbackFiles(workbench, { taskId, executionId, token, paths, statement }) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 100 || paths.some(p => typeof p !== 'string') || new Set(paths.map(key)).size !== paths.length) throw fault('INVALID_ROLLBACK', '请选择 1 至 100 个不重复的文件');
  if (typeof statement !== 'string' || !statement.trim() || statement.length > 12000) throw fault('INVALID_ROLLBACK', '请说明回退原因');
  const committed = [];
  try {
    return await workbench.store.transaction(async state => {
      await assertNoFileRecovery(workbench.root, state);
      if (state.tasks.some(t => t.status === 'running')) throw fault('TASK_RUNNING', '请先停止执行任务，再检查并回退文件');
      const preview = await changesFor(workbench.root, state, taskId, executionId);
      if (preview.token !== token) throw fault('STALE_ROLLBACK', '文件或任务记录已变化，请重新查看回退预览');
      const chosen = paths.map(p => preview.files.find(f => key(f.path) === key(relativePath(p))));
      if (chosen.some(f => !f || f.state !== 'ready')) throw fault('FILE_CONFLICT', '所选文件存在后续修改或已恢复，未执行回退');
      for (const file of chosen) {
        const before = await bytesAt(workbench.root, file.path); const after = await loadBlob(workbench.root, file.before);
        const change = { id: randomUUID(), at: now(), taskId, executionId: preview.executionId, path: file.path, before: file.current, after: file.before, kind: 'rollback', statement };
        if (before !== null) change.displacedPath = `.game-workbench/file-journal/${change.id}.displaced`;
        await replaceFile(workbench.root, change, before, after);
        (state.fileChanges ??= []).push(change); committed.push(change.id); event(state, 'file-rolled-back', change);
      }
      const affected = new Set([taskId]);
      let grew = true;
      while (grew) { grew = false; for (const task of state.tasks) if (!affected.has(task.id) && task.dependsOn.some(id => affected.has(id))) { affected.add(task.id); grew = true; } }
      for (const task of state.tasks) if (affected.has(task.id) && ['accepted', 'awaiting-review'].includes(task.status)) { task.status = 'failed'; task.updatedAt = now(); task.summary = `文件回退后需要重新验证。${task.summary ?? ''}`; }
      for (const report of state.diagnostics) report.stale = true;
      event(state, 'rollback-completed', { taskId, executionId: preview.executionId, paths, statement, affectedTasks: [...affected], verification: 'not-run' });
      return { restored: chosen.map(f => f.path), verification: 'not-run', message: '指定文件已恢复，相关任务需要重新验证。尚未运行引擎或试玩。' };
    });
  } finally {
    // Only prune journals proven committed in state; partial file operations
    // remain visible and block further writes after a process/disk failure.
    const state = await workbench.store.read();
    for (const id of committed) if (state.fileChanges?.some(c => c.id === id)) await cleanJournal(workbench.root, id);
  }
}
