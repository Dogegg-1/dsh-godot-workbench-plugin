import { digest } from './storage.mjs';
import { acceptanceCoverage, milestoneProgress } from './planning.mjs';

export function summarizeMilestones(state, snapshot) {
  const plans = new Map();
  for (const entry of state.events) if (entry.type === 'plan-revised' && entry.data?.previousPlan) plans.set(digest(entry.data.previousPlan), entry.data.previousPlan);
  if (state.plan) plans.set(digest(state.plan), state.plan);
  const currentHash = state.plan ? digest(state.plan) : null;
  const result = [];
  for (const [planHash, plan] of plans) {
    const current = planHash === currentHash;
    const scoped = { ...state, plan, approval: current ? state.approval : null };
    for (const progress of milestoneProgress(scoped, current ? snapshot : undefined)) {
      const taskIds = new Set(progress.taskIds);
      const tasks = state.tasks.filter(task => taskIds.has(task.id));
      const reports = (state.developmentReports ?? []).filter(report => report.facts.planHash === planHash && taskIds.has(report.facts.taskId));
      const summary = summarizeStages({ ...scoped, tasks, developmentReports: reports }, current ? snapshot : undefined).find(item => item.planHash === planHash);
      const items = progress.acceptance;
      const planTasks = new Map(state.tasks.filter(task=>task.planHash===planHash).map(task=>[task.id,task]));
      const unfinished = tasks.filter(task=>task.status!=='accepted').map(task=>({id:task.id,title:task.title,status:task.status,dependencies:task.dependsOn.filter(id=>planTasks.get(id)?.status!=='accepted').map(id=>({id,title:planTasks.get(id)?.title??'依赖记录缺失'}))}));
      result.push({ ...summary, current, milestoneId: progress.id, title: progress.title, goal: progress.goal, deliverable: progress.deliverable, milestoneStatus: progress.status,
        unfinished,
        scope: [progress.goal, progress.deliverable], scopeChanges: null,
        acceptanceCoverage: { items, total: items.length, reviewed: items.filter(item=>item.status==='reviewed').length, current: items.filter(item=>item.current).length, needsReview: items.filter(item=>item.status==='reviewed'&&!item.current).length, complete: progress.complete, note: '仅核对本阶段关联任务与验收；历史记录不代表当前文件有效。' },
        note: '按方案版本与项目阶段共同隔离，只汇总本阶段任务的执行记录；跨阶段依赖需查看原任务，不将其他阶段证据当成本阶段结果。',
      });
    }
  }
  return result;
}

// A plan version is the existing scope boundary, not a new milestone or a quality score.
export function summarizeStages(state, snapshot) {
  const plans = new Map();
  const predecessors = new Map();
  for (const entry of state.events) {
    const previous = entry.type === 'plan-revised' && entry.data?.previousPlan;
    if (previous) plans.set(digest(previous), previous);
    if (entry.type === 'plan-revised') predecessors.set(entry.data.planHash, previous || null);
  }
  const currentHash = state.plan ? digest(state.plan) : null;
  if (state.plan) plans.set(currentHash, state.plan);
  const hashes = new Set([...plans.keys(), ...state.tasks.map(task => task.planHash), ...(state.developmentReports ?? []).map(report => report.facts.planHash)]);
  return [...hashes].map(planHash => {
    const plan = plans.get(planHash);
    const previousPlan = predecessors.get(planHash);
    const tasks = state.tasks.filter(task => task.planHash === planHash);
    const reports = (state.developmentReports ?? []).filter(report => report.facts.planHash === planHash);
    const taskMap = new Map(tasks.map(task => [task.id, task]));
    const unfinished = tasks.filter(task => task.status !== 'accepted').map(task => ({
      id: task.id, title: task.title, status: task.status,
      dependencies: task.dependsOn.filter(id => taskMap.get(id)?.status !== 'accepted').map(id => ({ id, title: taskMap.get(id)?.title ?? '依赖记录缺失' })),
    }));
    const scopeChanges = plan && previousPlan ? {
      added: plan.inScope.filter(item => !previousPlan.inScope.includes(item)),
      removed: previousPlan.inScope.filter(item => !plan.inScope.includes(item)),
      excludedAdded: plan.outOfScope.filter(item => !previousPlan.outOfScope.includes(item)),
      excludedRemoved: previousPlan.outOfScope.filter(item => !plan.outOfScope.includes(item)),
    } : null;
    return {
      planHash, current: planHash === currentHash, title: plan?.title ?? reports[0]?.facts.planTitle ?? '历史方案',
      scope: plan?.inScope ?? null, excluded: plan?.outOfScope ?? null, scopeChanges,
      acceptanceCoverage: plan ? acceptanceCoverage({ plan, tasks }, planHash === currentHash ? snapshot : undefined) : null,
      confirmed: planHash === currentHash && state.approval?.planHash === planHash,
      taskCount: tasks.length, acceptedCount: tasks.length - unfinished.length, unfinished,
      executionCount: reports.length,
      failedExecutionCount: reports.filter(report => [report.facts, ...report.history.map(item => item.facts)].some(facts => ['failed', 'cancelled'].includes(facts.status))).length,
      retryCount: [...new Set(reports.map(report => report.facts.taskId))].reduce((sum, id) => sum + Math.max(0, reports.filter(report => report.facts.taskId === id).length - 1), 0),
      reportIds: reports.map(report => report.id),
      changedPaths: [...new Set(reports.flatMap(report => report.facts.changes.paths))],
      scanIncomplete: reports.some(report => !report.facts.changes.scanComplete),
      note: '按方案版本汇总；任务人工通过数不是质量百分比，也不自动证明全部方案验收项已覆盖。历史失败保留，不等于当前仍失败。',
    };
  });
}
