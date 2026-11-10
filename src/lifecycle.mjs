import { digest, fault, now } from './storage.mjs';
import { approvalValid, acceptanceCoverage, milestoneProgress } from './planning.mjs';
import { diagnosisContext } from './diagnostics.mjs';
import { lifecycleStages, gddSections } from './lifecycle-schema.mjs';
import { qaSummary } from './qa.mjs';
export { lifecycleStages, gddSections } from './lifecycle-schema.mjs';

export function lifecycleBasis(state, snapshot, engineIdentity = null) {
  const planHash = state.plan ? digest(state.plan) : null;
  return { iteration: state.lifecycle?.iteration ?? 1, planHash, fingerprint: snapshot?.complete ? snapshot.fingerprint : null, engineIdentity,
    tasksHash: digest(state.tasks.filter(t=>t.planHash===planHash).map(t=>({id:t.id,status:t.status,execution:t.execution?.id,review:t.review}))) };
}
const sameBasis = (a,b) => Boolean(a?.fingerprint && b?.fingerprint && digest(a) === digest(b));
const routes = { prototype: ['direction','prototype','qa','release','delivered'], full: lifecycleStages.map(s=>s.id) };
export function lifecycleAllowsWork(state) {
  return !state.lifecycle || ['prototype','production','polish'].includes(state.lifecycle.stage);
}
export function requireLifecycleWork(state) {
  if (!lifecycleAllowsWork(state)) throw fault('LIFECYCLE_NOT_READY', '请先确认制作阶段；设计阶段先完善方案，QA发现问题后先记录修缮迭代。');
}

export function lifecycleStatus(state, snapshot, engineIdentity = null) {
  const record = state.lifecycle;
  const basis = lifecycleBasis(state, snapshot, engineIdentity);
  const qa = qaSummary(state,basis);
  const mode = record?.mode ?? null;
  const route = routes[mode] ?? routes.full;
  const storedStage = record?.stage ?? 'direction';
  const checkpoint = record?.history?.findLast(item=>item.to===storedStage && item.basis);
  const current = state.tasks.filter(t=>t.planHash===basis.planHash);
  const coverage = acceptanceCoverage(state,snapshot);
  const milestones = milestoneProgress(state,snapshot);
  const report = state.diagnostics.at(-1);
  const engineeringReady = Boolean(engineIdentity && engineIdentity!=='unavailable' && report?.engineIdentity===engineIdentity && snapshot?.complete && report && !report.stale && report.fingerprint===snapshot.fingerprint && report.workflowFingerprint===diagnosisContext(state) && report.coverage?.engineImport==='passed' && report.coverage?.fileScan==='complete' && !report.issues.some(i=>i.severity==='blocking'));
  const stale = ['release','delivered'].includes(storedStage) && (!sameBasis(checkpoint?.basis,basis) || !engineeringReady || !qa.complete || checkpoint?.qaRunId!==qa.latest?.id);
  const stage = stale ? 'qa' : storedStage;
  const accepted = current.length>0 && current.every(t=>t.status==='accepted') && coverage.complete && milestones.every(m=>m.complete);
  const designMissing = Object.keys(gddSections).filter(key=>!state.plan?.gdd?.[key]?.trim());
  if (!state.plan?.milestones?.length) designMissing.push('modules');
  const blockers = [];
  if (!mode) blockers.push('先选择验证原型，还是继续制作完整游戏。');
  if (!approvalValid(state)) blockers.push('当前方案还未确认。');
  if (state.tasks.some(t=>t.status==='running')) blockers.push('先结束正在执行的任务。');
  if (state.automaticChecks?.some(c=>c.status==='checking')) blockers.push('工程检查还在进行。');
  if (stage==='design' && designMissing.length) blockers.push('先完善 GDD 与模块安排，再确认新版计划。');
  if (['prototype','production','polish','qa','release'].includes(stage) && !accepted) blockers.push('当前范围还有未完成或需重新试玩的内容。');
  if (['qa','release'].includes(stage) && !engineeringReady) blockers.push('先完成当前工程检查并解决阻断问题。');
  if (['qa','release'].includes(stage) && !qa.complete) blockers.push('这一版还有未通过或未测试的目标，请记录本轮测试。');
  const nextStage = route[route.indexOf(stage)+1] ?? null;
  const history = record?.history ?? [];
  return { mode, stage, storedStage, stale, iteration: record?.iteration ?? 1, version: record?.version ?? 0,
    stages: route.map(id=>lifecycleStages.find(s=>s.id===id)), nextStage, canAdvance: Boolean(nextStage && !blockers.length), blockers,
    designMissing, engineeringReady, humanScopeAccepted: accepted, basis, qa,
    completed: stage==='delivered' && !stale, history: history.slice(-20), historyCount: history.length,
    note: '阶段确认、工程检查和人工试玩分别记录；原型交付不等于完整游戏交付。' };
}

// Called only by the local UI. Never expose transitions as an Agent approval tool.
export function changeLifecycle(state, snapshot, { action, mode, expectedVersion, expectedBasis, statement, targetStage }, { delivery, engineIdentity = null } = {}) {
  const view = lifecycleStatus(state,snapshot,engineIdentity);
  if (!expectedBasis || expectedVersion !== view.version || digest(expectedBasis) !== digest(view.basis)) throw fault('STALE_LIFECYCLE','工程或阶段记录已变化，请刷新后重新确认');
  if (state.tasks.some(t=>t.status==='running') || state.automaticChecks?.some(c=>c.status==='checking')) throw fault('TASK_RUNNING','先结束当前制作或检查，再调整阶段');
  if (typeof statement !== 'string' || !statement.trim() || statement.length>2000) throw fault('MISSING_STATEMENT','请记录这次决定或试玩结论');
  const record = state.lifecycle ?? { mode:null,stage:'direction',iteration:1,version:0,history:[] };
  let to = view.stage;
  if (action==='mode') {
    if (!routes[mode]) throw fault('INVALID_MODE','请选择原型验证或完整游戏');
    if (record.mode && record.mode!==mode && view.stage!=='direction' && !(record.mode==='prototype' && mode==='full' && ['prototype','qa','release','delivered'].includes(view.stage))) throw fault('INVALID_TRANSITION','已进入正式制作，不能把完整游戏静默降为原型');
    if (record.mode==='prototype' && mode==='full' && view.stage!=='prototype' && view.stage!=='direction') to=view.humanScopeAccepted ? 'design' : 'prototype';
    record.mode=mode;
  } else if (action==='advance') {
    if (!view.canAdvance) throw fault('LIFECYCLE_NOT_READY',view.blockers[0] ?? '当前没有可推进的阶段');
    to=view.nextStage;
    if (to==='delivered' && (!delivery || delivery.status!=='ready' || delivery.sourceState!=='unchanged' || !delivery.exportPassed || !delivery.startupPassed || !delivery.artifactsVerified)) throw fault('DELIVERY_REQUIRED','先生成并核对当前版本的可玩构建，再记录最终验收');
  } else if (action==='iterate') {
    const allowed = record.mode==='prototype' ? ['prototype'] : ['prototype','design','production','polish'];
    if (!record.mode || !allowed.includes(targetStage) || routes[record.mode].indexOf(targetStage)>routes[record.mode].indexOf(view.stage)) throw fault('INVALID_TRANSITION','修缮只能回到当前或较早的制作阶段');
    to=targetStage; record.iteration++;
  } else throw fault('INVALID_ACTION','未知阶段操作');
  record.history.push({ at:now(),actor:'local-user',action,from:view.storedStage,to,mode:record.mode,iteration:record.iteration,statement:statement.trim(),basis:view.basis,...(to==='delivered'?{delivery}:{}),...(view.stale?{previousAcceptanceStale:true}:{}) });
  record.history.at(-1).qaRunId=view.qa.latest?.id??null;
  record.stage=to; record.version++; state.lifecycle=record;
  return lifecycleStatus(state,snapshot,engineIdentity);
}
