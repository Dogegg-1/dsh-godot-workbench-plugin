import { digest, fault, now } from './storage.mjs';

export function qaSummary(state, basis) {
  const runs=state.qaRuns??[], latest=runs.at(-1)??null;
  const current=Boolean(latest && basis.fingerprint && digest(latest.basis)===digest(basis));
  const complete=current && (state.plan?.acceptance.length??0)>0 && state.plan.acceptance.every((_,i)=>latest.results.some(r=>r.number===i+1&&r.outcome==='passed'));
  return {version:runs.length,current,complete:Boolean(complete),latest,history:runs.slice(-5),total:runs.length};
}
export function recordQa(state,basis,{expectedVersion,expectedBasis,results}) {
  const current=qaSummary(state,basis);
  if(expectedVersion!==current.version||!expectedBasis||digest(expectedBasis)!==digest(basis)||!basis.fingerprint) throw fault('STALE_QA','工程或测试记录已变化，请刷新后重新核对');
  const count=state.plan?.acceptance.length??0;
  if(!count||!Array.isArray(results)||results.length!==count||new Set(results.map(r=>r?.number)).size!==count||results.some(r=>!r||!Number.isInteger(r.number)||r.number<1||r.number>count||!['passed','failed','not-tested'].includes(r.outcome)||typeof r.note!=='string'||r.note.length>2000||(r.outcome!=='not-tested'&&!r.note.trim()))) throw fault('INVALID_QA','每个测试目标需记录结果；通过或失败需简述实际观察');
  const run={id:`qa-${current.version+1}`,at:now(),actor:'local-user',basis,results:results.map(r=>({number:r.number,target:state.plan.acceptance[r.number-1],outcome:r.outcome,note:r.note.trim()}))};
  (state.qaRuns??=[]).push(run);
  return qaSummary(state,basis);
}
