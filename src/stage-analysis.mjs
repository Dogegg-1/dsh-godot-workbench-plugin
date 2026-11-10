import { digest, fault, now } from './storage.mjs';
import { summarizeStages, summarizeMilestones } from './stage-reports.mjs';
import { reportSourceHash, validateAnalysis, verificationInterpretation } from './development-reports.mjs';

export function stageAnalysisSource(state, planHash, snapshot, preparedStage, milestoneId) {
  const stage = preparedStage ?? (milestoneId ? summarizeMilestones(state, snapshot) : summarizeStages(state, snapshot)).find(item => item.planHash === planHash && (!milestoneId || item.milestoneId === milestoneId));
  if (!stage) throw fault('UNKNOWN_REPORT', '方案阶段不存在，请重新读取汇总');
  if (stage.planHash !== planHash) throw fault('UNKNOWN_REPORT', '阶段汇总与所读方案不一致');
  const reports = (state.developmentReports ?? []).filter(report => report.facts.planHash === planHash && (!stage.milestoneId || stage.reportIds.includes(report.id))).map(report => ({
    id: report.id, revision: report.revision, facts: report.facts, notes: report.notes, history: report.history,
    verificationInterpretation: verificationInterpretation(report.facts),
    analysis: report.analysis ?? null, analysisStale: Boolean(report.analysis && report.analysis.sourceHash !== reportSourceHash(report)),
  }));
  const sourceHash = digest({ stage, reports });
  const stored = state.stageAnalyses?.find(item => item.planHash === planHash && item.milestoneId === stage.milestoneId);
  return { id: stage.milestoneId ? `milestone:${planHash}:${stage.milestoneId}` : `stage:${planHash}`, revision: stored?.revision ?? 0, sourceHash, stage, reports,
    evidenceRefs: ['stage', ...reports.map(report => `report:${report.id}`)],
    analysis: stored?.analysis ?? null, analysisStale: Boolean(stored && stored.analysis.sourceHash !== sourceHash),
    analysisHistory: stored?.history ?? [],
    note: `${stage.milestoneId ? '本报告仅限指定项目阶段。' : '整阶段按方案版本定义。'}报告是当时记录，不代替当前环境核查。not-run是验证缺口，不是停止原因；逐批区分设计决策、工程障碍和未验证，不凭相同覆盖状态归并根因。批次AI解释不是独立事实，过期分析不能作为当前结论。优先关联已有任务，不机械为每条验收另建任务。经验建议需回到具体来源批次核对后再审核入库。`,
  };
}
export function recordStageAnalysis(state, source, { expectedRevision, sourceHash, summary, findings }) {
  if (source.revision !== expectedRevision || source.sourceHash !== sourceHash) throw fault('STALE_REPORT', '阶段任务或报告已有变化，请重新读取；旧分析保留');
  const normalized = validateAnalysis(summary, findings, source.evidenceRefs);
  const records = state.stageAnalyses ??= [];
  let record = records.find(item => item.planHash === source.stage.planHash && item.milestoneId === source.stage.milestoneId);
  if (!record) { record = { planHash: source.stage.planHash, ...(source.stage.milestoneId ? {milestoneId:source.stage.milestoneId} : {}), revision: 0, history: [] }; records.push(record); }
  if (record.analysis) record.history.push(record.analysis);
  record.analysis = { at: now(), actor: 'model', sourceHash, summary: summary.trim(), findings: normalized, note: source.note };
  record.revision++;
  return record.analysis;
}
