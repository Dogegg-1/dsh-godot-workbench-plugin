import { digest } from './storage.mjs';

// File identity can invalidate an old claim, but cannot prove the prose true.
export function summaryBasis(task, snapshot) {
  return { at: new Date().toISOString(), executionId: task.execution?.id ?? null,
    summaryHash: digest(task.summary), planHash: task.planHash,
    fingerprint: snapshot.fingerprint, scanComplete: snapshot.complete,
    files: snapshot.files.map(({path,hash})=>({path,hash})) };
}
export function summaryCurrency(task, snapshot, currentPlanHash) {
  if (!task.summary) return null;
  const basis=task.summaryBasis;
  if (!basis || basis.summaryHash !== digest(task.summary)) return {status:'unverified',reason:'历史摘要没有匹配的文件基线，只能作为待核对的线索。'};
  const before=new Map(basis.files.map(file=>[file.path,file.hash]));
  const after=new Map(snapshot.files.map(file=>[file.path,file.hash]));
  const changed=[...new Set([...before.keys(),...after.keys()])].filter(name=>before.get(name)!==after.get(name)).sort();
  if (basis.planHash !== currentPlanHash || changed.length) return {
    status:'needs-review', reason:basis.planHash!==currentPlanHash?'方案已变化，旧摘要不能当作本期决定。':'摘要形成后项目文件有变化，先读取当前实现；这不证明摘要本身错误。',
    changedPaths:changed.slice(0,20), changedCount:changed.length,
    comparisonComplete:Boolean(basis.scanComplete&&snapshot.complete), at:basis.at,
  };
  if (!basis.scanComplete || !snapshot.complete) return {status:'unverified',reason:'文件扫描范围不完整，无法确认旧摘要与当前实现是否一致。',at:basis.at};
  return {status:'files-unchanged',reason:'支持类型的已扫描文件与提交时相同；不代表摘要结论或试玩已经验证。',at:basis.at};
}
