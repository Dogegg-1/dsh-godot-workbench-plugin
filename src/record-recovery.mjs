import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { confined, fault, digest, now, readRecord, durableRecord, validateState, saveStateSnapshot, STATE_LIMIT } from './storage.mjs';
import { renderDocuments } from './planning.mjs';

function owner(record) {
  if (!record.raw) return { state: 'absent' };
  let data;
  try { data = JSON.parse(record.raw.toString('utf8')); } catch { return { state: 'unknown', reason: '旧锁没有可读的进程记录' }; }
  if (!Number.isSafeInteger(data.pid) || data.pid <= 0) return { state: 'unknown', reason: '旧锁没有有效的进程编号' };
  try { process.kill(data.pid, 0); return { state: 'alive', pid: data.pid, at: data.at, reason: '进程编号仍存在，不能确认写入已停止' }; }
  catch (error) { return { state: error.code === 'ESRCH' ? 'exited' : 'unknown', pid: data.pid, at: data.at, reason: error.code === 'ESRCH' ? '锁记录的进程已退出' : '无法确认进程是否退出' }; }
}
const snapshotPattern = /^\d+-[a-f0-9]{64}\.json$/;
function parseState(raw) { return validateState(JSON.parse(raw.toString('utf8'))); }
export async function recordHealth(root) {
  const lock = await readRecord(root, '.game-workbench/write.lock', 16384);
  const gate = await readRecord(root, '.game-workbench/record-recovery.lock', 16384);
  return { writeLock: owner(lock), recoveryLock: owner(gate) };
}
async function inspect(root, detailId) {
  const current = await readRecord(root, '.game-workbench/state.json');
  const lock = await readRecord(root, '.game-workbench/write.lock', 16384);
  const gate = await readRecord(root, '.game-workbench/record-recovery.lock', 16384);
  let currentState; let currentError;
  if (current.raw) { try { currentState = parseState(current.raw); } catch (error) { currentError = error.message; } }
  const dir = await confined(root, '.game-workbench/state-history', { mustExist: false });
  const names = (await fs.readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).filter(name => snapshotPattern.test(name)).sort((a, b) => Number(b.split('-')[0]) - Number(a.split('-')[0]) || a.localeCompare(b));
  const candidates = []; const invalid = []; let readBytes = 0; let inspected = 0;
  for (const name of names.slice(0, 100)) {
    try {
      const filename = await confined(root, `.game-workbench/state-history/${name}`);
      const size = (await fs.stat(filename)).size;
      if (size > STATE_LIMIT) { inspected++; throw fault('INVALID_SNAPSHOT', '单份快照超过 16 MiB'); }
      if (readBytes + size > 32 * 1024 * 1024) break;
      readBytes += size; inspected++;
      const record = await readRecord(root, `.game-workbench/state-history/${name}`);
      if (!record.raw || !name.endsWith(`-${record.hash}.json`)) throw fault('INVALID_SNAPSHOT', '快照校验值不匹配');
      const state = parseState(record.raw);
      if (String(state.revision) !== name.split('-')[0]) throw fault('INVALID_SNAPSHOT', '快照版本号不匹配');
      candidates.push({ id: name, hash: record.hash, revision: state.revision, at: state.updatedAt ?? null, title: state.plan?.title ?? '未整理方案', tasks: state.tasks.length, accepted: state.tasks.filter(task => task.status === 'accepted').length, ...(detailId === name ? { documents: renderDocuments(state.plan), taskPreview: state.tasks.map(task => ({ title: task.title, status: task.status })).slice(-20) } : {}) });
    } catch (error) { invalid.push({ id: name, reason: error.message }); }
  }
  const state = { status: currentState ? 'healthy' : current.raw ? 'damaged' : 'missing', revision: currentState?.revision, hash: current.hash, reason: currentError };
  const writeLock = { ...owner(lock), hash: lock.hash };
  const recoveryLock = owner(gate);
  return { projectRoot: path.resolve(root), state, writeLock, recoveryLock, candidates, invalid, truncated: names.length > inspected,
    token: digest({ state, lock: lock.hash, candidates: candidates.map(({ id, hash }) => ({ id, hash })), invalid }),
    note: '快照只恢复工作台方案、任务与记录，不修改游戏文件或玩家存档。恢复后撤销确认、停止旧执行记录并要求重新验收；未完成文件操作仍需另外核查。' };
}
export async function inspectRecordRecovery(root, { snapshotId } = {}) {
  if (snapshotId !== undefined && (typeof snapshotId !== 'string' || !snapshotPattern.test(snapshotId))) throw fault('INVALID_SNAPSHOT', '快照标识不正确');
  return inspect(root, snapshotId);
}

// This is a human maintenance action, deliberately absent from model tools.
// The coordination gate blocks normal Store transactions before and after their
// write-lock acquisition. If recovery itself crashes, preserve its gate and
// archive for inspection instead of guessing or replaying the operation.
export async function applyRecordRecovery(root, { action, token, snapshotId, statement, stoppedConfirmed } = {}) {
  if (!['unlock', 'restore'].includes(action) || typeof token !== 'string' || typeof statement !== 'string' || !statement.trim() || statement.length > 4000 || stoppedConfirmed !== true) throw fault('INVALID_RECOVERY', '请核对预览，说明恢复原因，并确认 Agent 已停止、编辑器已保存、其他工作台已关闭');
  const dir = await confined(root, '.game-workbench', { mustExist: false }); await fs.mkdir(dir, { recursive: true });
  const gate = await confined(root, '.game-workbench/record-recovery.lock', { mustExist: false });
  let handle;
  try { handle = await fs.open(gate, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw fault('RECORD_RECOVERY_BUSY', '另一次记录恢复正在执行或曾中断，请保留 record-recovery.lock 与 recovery-archives 现场后核查'); throw error; }
  let changed = false; let committed = false; let archive;
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: now(), id: randomUUID() })); await handle.sync();
    const preview = await inspect(root);
    if (preview.token !== token) throw fault('STALE_RECOVERY', '记录、锁或快照已变化，请重新查看恢复预览');
    if (preview.writeLock.state === 'alive') throw fault('RECOVERY_OWNER_ALIVE', '写锁对应的进程仍存在，不能解除或恢复；请先结束原工作台写入');
    if (action === 'unlock' && preview.writeLock.state === 'absent') throw fault('NO_LOCK', '当前没有需要解除的写锁');
    if (action === 'restore' && preview.state.status === 'healthy') throw fault('HEALTHY_STATE', '当前记录可正常读取，不使用故障恢复覆盖有效进度');
    const selected = action === 'restore' ? preview.candidates.find(item => item.id === snapshotId) : null;
    if (action === 'restore' && !selected) throw fault('INVALID_SNAPSHOT', '请选择已通过校验的记录快照');
    const archiveRelative = `.game-workbench/recovery-archives/${randomUUID()}`;
    archive = await confined(root, archiveRelative, { mustExist: false }); await fs.mkdir(archive, { recursive: true });
    await durableRecord(path.join(archive, 'intent.json'), JSON.stringify({ action, at: now(), statement: statement.trim(), stoppedConfirmed: true, token, snapshotId: selected?.id ?? null, stateHash: preview.state.hash, lockHash: preview.writeLock.hash }, null, 2));
    let next; let serialized;
    if (selected) {
      const candidate = await readRecord(root, `.game-workbench/state-history/${selected.id}`);
      if (candidate.hash !== selected.hash) throw fault('STALE_RECOVERY', '选择的快照在恢复前发生变化');
      next = parseState(candidate.raw);
      const oldApproval = next.approval;
      next.approval = null;
      for (const task of next.tasks) {
        if (['running', 'accepted', 'awaiting-review'].includes(task.status)) {
          const previousStatus = task.status;
          task.status = previousStatus === 'running' ? 'cancelled' : 'failed';
          task.updatedAt = now(); task.summary = `恢复记录后需要重新核对。${task.summary ?? ''}`;
          task.recordRecovery = { previousStatus, at: now(), statement: statement.trim() };
        }
      }
      for (const report of next.diagnostics) report.stale = true;
      for (const check of next.automaticChecks ?? []) if (check.status === 'checking') { check.status = 'failed'; check.message = '记录恢复后，原自动检查需重新执行。'; }
      next.revision++; next.updatedAt = now();
      next.events.push({ id: randomUUID(), at: now(), type: 'records-restored', data: { snapshotId: selected.id, previousApproval: oldApproval, statement: statement.trim(), archive: archiveRelative, verification: 'not-run' } });
      validateState(next); serialized = Buffer.from(JSON.stringify(next, null, 2));
      await durableRecord(path.join(archive, 'state.prepared.json'), serialized);
    }
    // Recheck after staging, before touching the current metadata. The gate is
    // not a lock on external text editors; a new file at the target is refused.
    const fresh = await inspect(root);
    if (fresh.token !== token || fresh.writeLock.state === 'alive') throw fault('STALE_RECOVERY', '准备恢复期间记录变化，未覆盖，请重新查看');
    if (fresh.writeLock.state !== 'absent') {
      await fs.rename(await confined(root, '.game-workbench/write.lock'), path.join(archive, 'write.lock')); changed = true;
      if ((await readRecord(root, `${archiveRelative}/write.lock`, 16384)).hash !== fresh.writeLock.hash) throw fault('RECOVERY_CHANGED', '归档期间写锁发生变化，已保留现场，未继续恢复');
    }
    if (selected) {
      if (fresh.state.hash !== 'missing') {
        await fs.rename(await confined(root, '.game-workbench/state.json'), path.join(archive, 'state.original.json')); changed = true;
        if ((await readRecord(root, `${archiveRelative}/state.original.json`)).hash !== fresh.state.hash) throw fault('RECOVERY_CHANGED', '归档期间原记录发生变化，已保留现场，未安装旧快照');
      }
      const target = await confined(root, '.game-workbench/state.json', { mustExist: false });
      await fs.link(path.join(archive, 'state.prepared.json'), target); changed = true;
      await fs.unlink(path.join(archive, 'state.prepared.json'));
      if ((await readRecord(root, '.game-workbench/state.json')).hash !== digest(serialized.toString('utf8'))) throw fault('RECOVERY_CHANGED', '恢复期间记录再次变化，已保留原始现场');
      await saveStateSnapshot(root, serialized);
    }
    await durableRecord(path.join(archive, 'result.json'), JSON.stringify({ completedAt: now(), action, snapshotId: selected?.id ?? null, revision: next?.revision, gameFilesChanged: false, verification: 'not-run' }, null, 2));
    committed = true;
    return { action, archive: archiveRelative, message: action === 'unlock' ? '写锁已归档，游戏文件未修改。若记录仍损坏，请继续选择快照恢复。' : '工作台记录已恢复，原件和旧锁已归档。请重新确认方案并检查现有游戏；旧验收未沿用。' };
  } catch (error) {
    if (changed) throw fault('RECORD_RECOVERY_INTERRUPTED', `恢复中途未完成，现场保留于 ${archive}，请先核查，不要重复执行。原因：${error.message}`);
    throw error;
  } finally {
    await handle.close();
    if (!changed || committed) await fs.rm(gate, { force: true });
  }
}
