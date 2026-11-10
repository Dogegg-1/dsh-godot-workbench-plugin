// Engineering readiness never changes a human acceptance record.
export function taskCanStart(task, { tasks, mode = 'stepwise', report, planHash }) {
  const current = tasks.filter(item => item.planHash === planHash);
  if (task.planHash !== planHash || task.status !== 'pending' || current.some(item => item.status === 'running')) return false;
  const dependencies = (task.dependsOn ?? []).map(id => current.find(item => item.id === id));
  if (dependencies.some(item => !item)) return false;
  if (mode !== 'continuous') return dependencies.every(item => item.status === 'accepted');
  // Only the existing local retry action can reopen a failed task for repair.
  if (task.diagnosisRepair?.actor === 'local-user' && !task.diagnosisRepair.started && task.diagnosisRepair.planHash === planHash) return dependencies.every(item => ['accepted', 'awaiting-review'].includes(item.status));
  if (task.continuousRepair?.actor === 'local-user' && task.execution?.id && task.continuousRepair.executionId === task.execution.id) {
    return dependencies.every(item => item.status === 'accepted' || (item.status === 'awaiting-review' && item.execution?.id && item.evidence?.length));
  }
  if (current.some(item => ['failed', 'cancelled'].includes(item.status))) return false;
  // A known blocker also stops independent tasks; dropping dependencies is not a bypass.
  if (report?.issues?.some(issue => issue.severity === 'blocking' && (!report.stale || report.taskCheckCurrent || issue.code === 'RUNTIME_NATIVE_FAILURE'))) return false;
  const awaiting = current.filter(item => item.status === 'awaiting-review');
  if (awaiting.length && (!report || !(report.taskCheckCurrent ?? !report.stale) || report.coverage?.fileScan !== 'complete' || report.coverage?.engineImport !== 'passed' || report.issues.some(issue => issue.severity === 'blocking'))) return false;
  return dependencies.every(item => item.status === 'accepted' || (item.status === 'awaiting-review' && item.execution?.id && item.evidence?.length));
}
