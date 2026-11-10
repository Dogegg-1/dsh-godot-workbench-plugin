import path from 'node:path';
import { digest, event, now } from './storage.mjs';
import { inspectProject } from './project.mjs';
import { diagnose } from './diagnostics.mjs';
import { newExecution, executionHealth } from './task-execution.mjs';
import { summaryBasis } from './summary-currency.mjs';
import { captureDevelopmentReport } from './development-reports.mjs';

const live = globalThis[Symbol.for('xingyou.workbench.automatic-check-handlers')] ??= new Map();
export function registerLiveCheck(id) { live.set(id, (live.get(id) ?? 0) + 1); return () => { const count = live.get(id) ?? 0; if (count > 1) live.set(id, count - 1); else live.delete(id); }; }
export const checkHealth = check => {
  if (check?.status !== 'checking') return null;
  const health = executionHealth({ id: check.id, status: 'running', execution: check.owner });
  return health.state === 'host-alive' && !live.has(check.id) ? { ...health, state: 'interrupted', message: '本宿主的检查操作已经结束，但记录没有完成；可重新检查。' } : health;
};

export async function requestAutomaticCheck(root, state, task, action, requestHash, { checkMode = 'auto', checkReason = '' } = {}) {
  const snapshot = await inspectProject(root);
  task.summaryBasis = summaryBasis(task, snapshot);
  const baseline = state.fileBaselines?.[task.execution?.id];
  const before = new Map((baseline?.files ?? []).map(file => [file.path, file.hash]));
  const after = new Map(snapshot.files.map(file => [file.path, file.hash]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].filter(name => before.get(name) !== after.get(name)).sort();
  const complete = Boolean(baseline?.complete && snapshot.complete);
  const phaseEnd = action === 'submit' && !state.tasks.some(other => other.planHash === task.planHash && ['pending', 'running', 'failed', 'cancelled'].includes(other.status));
  // Any non-document change is conservatively treated as affecting engine import.
  const runImport = phaseEnd || action === 'fail' || !complete || paths.some(name => path.extname(name).toLowerCase() !== '.md');
  const check = {
    id: `${task.execution.id}:${action}`, taskId: task.id, executionId: task.execution.id, requestHash,
    at: now(), status: 'checking', owner: newExecution(task.execution.sessionId),
    trigger: phaseEnd ? 'phase-submitted' : action === 'fail' ? 'task-failed' : 'task-submitted',
    mode: checkMode === 'static' ? 'static' : runImport ? 'engine' : 'quick', paths, scanComplete: complete,
    ...(checkMode === 'static' ? { engineSkippedReason: checkReason } : {}),
    scope: '任务期间检测到的已保存变化；可能包含编辑器或其他工具的修改，不据此归属 Agent。',
  };
  (state.automaticChecks ??= []).push(check);
  event(state, 'automatic-check-requested', { checkId: check.id, taskId: task.id, trigger: check.trigger, mode: check.mode, paths });
  return check;
}

export async function executeAutomaticCheck(workbench, checkId, signal) {
  // A bounded engine check holds the project write lease. Readers remain available;
  // another task cannot begin writing while Godot imports the previous batch.
  return workbench.store.transaction(async state => {
    const check = state.automaticChecks?.find(item => item.id === checkId);
    if (!check || check.status !== 'checking') return { check: check ?? null, report: state.diagnostics.find(r => r.id === check?.reportId) ?? null };
    try {
      signal?.throwIfAborted();
      const report = await diagnose(workbench.root, state, { enginePath: workbench.enginePath, runImport: check.mode === 'engine', skipEngineReason: check.mode === 'static' ? check.engineSkippedReason : undefined, signal });
      report.origin = { type: 'automatic', checkId, taskId: check.taskId, trigger: check.trigger, paths: check.paths, mode: check.mode };
      state.diagnostics.push(report);
      check.status = 'completed'; check.reportId = report.id; check.finishedAt = now();
      event(state, 'diagnosis-created', { reportId: report.id, stale: report.stale, checkId });
      event(state, 'automatic-check-completed', { checkId, reportId: report.id });
      captureDevelopmentReport(state, state.tasks.find(t => t.id === check.taskId), 'automatic-check-completed');
      return { check, report };
    } catch (error) {
      check.status = 'failed'; check.finishedAt = now(); check.message = signal?.aborted ? '自动检查已取消，任务提交和已有改动已保留。请重新检查。' : `自动检查未完成：${error.message}`;
      event(state, 'automatic-check-failed', { checkId, message: check.message });
      captureDevelopmentReport(state, state.tasks.find(t => t.id === check.taskId), 'automatic-check-failed');
      return { check, report: null };
    }
  });
}

export const submissionHash = ({ action, summary, evidence, executionId, checkMode = 'auto', checkReason = '' }) => digest({ action, summary, evidence, executionId, ...(checkMode === 'static' ? { checkMode, checkReason } : {}) });
