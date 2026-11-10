import { randomUUID } from 'node:crypto';
import { digest, event, fault, now } from './storage.mjs';
import { requireApproval } from './planning.mjs';
import { readProjectFile } from './file-changes.mjs';

const fields = ['title', 'reason', 'scope', 'limitations', 'removalCondition', 'followUp'];
const clean = (value, label, limit = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw fault('INVALID_FIX', `${label}需要 1 至 ${limit} 字的说明`);
  return value.trim();
};
const key = value => value.replaceAll('\\', '/').toLowerCase();
async function sources(root, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 10 || paths.some(p => typeof p !== 'string') || new Set(paths.map(key)).size !== paths.length) throw fault('INVALID_FIX', '请关联 1 至 10 个不重复的工程文件路径');
  const result = {};
  for (const name of paths) { const file = await readProjectFile(root, { path: name }); result[name] = file.hash; }
  return result;
}

export async function listTemporaryFixes(root, state, { path, includeResolved = true } = {}) {
  const records = (state.temporaryFixes ?? []).filter(item => !path || item.paths.some(p => key(p) === key(path)));
  const items = [];
  for (const item of records) {
    let changed = false;
    if (item.status === 'resolved') {
      try { const current = await sources(root, item.paths); changed = item.paths.some(p => current[p] !== item.resolution.hashes[p]); }
      catch { changed = true; }
    }
    const effectiveStatus = changed ? 'needs-review' : item.status;
    if (includeResolved || effectiveStatus !== 'resolved') items.push({ ...item, effectiveStatus, verificationMeaning: '解决说明由操作者登记，文件一致不代表独立测试或人工验收通过' });
  }
  return { items, activeCount: items.filter(item => item.effectiveStatus !== 'resolved').length, revision: state.revision };
}

export async function changeTemporaryFix(workbench, args = {}) {
  const { action, id, expectedVersion, taskId } = args;
  if (!['add', 'edit', 'resolve', 'reopen'].includes(action)) throw fault('INVALID_FIX', '记录操作仅支持 add、edit、resolve、reopen');
  return workbench.store.transaction(async state => {
    requireApproval(state);
    const task = state.tasks.find(t => t.id === taskId && t.planHash === digest(state.plan));
    if (!task || !['running', 'awaiting-review', 'accepted'].includes(task.status)) throw fault('FIX_TASK_REQUIRED', '需要关联当前方案下已开始的任务；先登记并启动实际修复任务');
    const records = state.temporaryFixes ??= [];
    let record = records.find(item => item.id === id);
    if (action !== 'add' && (!record || record.version !== expectedVersion)) throw fault('STALE_FIX', '临时修复记录已变化，请刷新后再操作');
    const previous = record ? structuredClone(record) : null;
    if (action === 'add' || action === 'edit') {
      const detail = Object.fromEntries(fields.map(field => [field, clean(args[field], field, field === 'title' ? 160 : 2000)]));
      const hashes = await sources(workbench.root, args.paths);
      if (Object.values(hashes).some(hash => hash === 'missing')) throw fault('FIX_SOURCE_MISSING', '关联文件尚不存在，请保存实际实现后再登记');
      if (action === 'add') {
        if (records.length >= 100) throw fault('FIX_LIMIT', '临时修复记录已达 100 条，请先整理项目记录');
        record = { id: randomUUID(), version: 0, createdAt: now() }; records.push(record);
      }
      Object.assign(record, detail, { paths: [...args.paths], status: 'open', resolution: null, sourceHashes: hashes });
    } else if (action === 'resolve') {
      if (record.status === 'resolved') throw fault('INVALID_FIX', '此记录已登记解决；若实现变化，先重新打开并核查');
      record.resolution = { at: now(), taskId, verification: clean(args.verification, '解决与验证说明', 4000), hashes: await sources(workbench.root, record.paths) };
      record.status = 'resolved';
    } else {
      record.status = 'open'; record.reopenReason = clean(args.verification, '重新打开的原因'); record.resolution = null;
    }
    record.taskId = taskId; record.version++; record.updatedAt = now();
    event(state, 'temporary-fix-changed', { action, previous, record: structuredClone(record) });
    return record;
  });
}
