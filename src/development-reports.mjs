import { randomUUID } from 'node:crypto';
import { digest, now, fault } from './storage.mjs';

export const reportSourceHash = report => digest({ facts: report.facts, notes: report.notes });
export function verificationInterpretation(facts) {
  const coverage = facts.diagnosis?.coverage;
  return {
    unperformedChecks: Object.entries(coverage ?? {}).filter(([, status]) => status === 'not-run').map(([name]) => name),
    coverageAvailable: Boolean(coverage),
    meaning: 'not-run只表示这项验证未运行，不编码原因。引擎导入、功能输入、画面和人工试玩分别判断；引擎未配置可解释导入不可用，不能据此归因其他检查未运行或任务停止。',
    causeEvidence: '停止原因只能转述任务摘要、执行证据或用户补充明确记录的因果；没有记录则保留未知。存在多个未运行项不证明它们有共同原因。',
  };
}
export function developmentAnalysisSource(report) {
  const sourceHash = reportSourceHash(report);
  return { id: report.id, revision: report.revision, sourceHash, facts: report.facts, notes: report.notes,
    verificationInterpretation: verificationInterpretation(report.facts), evidenceRefs: reportReferences(report),
    analysisStale: Boolean(report.analysis && report.analysis.sourceHash !== sourceHash) };
}
export function developmentFollowUp(state, task) {
  const report = state.developmentReports?.find(item => item.key === `${task.id}:${task.execution?.id}`);
  if (!report) return null;
  const sourceHash = reportSourceHash(report);
  const current = report.analysis?.sourceHash === sourceHash;
  return { reportId: report.id, sourceHash, status: current ? 'current' : 'needs-analysis', readTool: 'gamedev_development_reports', readArguments: { reportId: report.id }, nextAction: current ? '本批来源未变且已有复盘，不重复生成。' : '读取本批报告后，用 gamedev_development_analyze 保存简短复盘；只分析已记录的难点、尝试、假设和下一步，不编造根因，不改代码或验收，不自动批准经验。' };
}
export function reportReferences(report) {
  return ['task', ...(report.facts.automaticCheck ? ['check'] : []),
    ...report.facts.reportedEvidence.map((_, i) => `evidence:${i}`),
    ...report.facts.changes.paths.map(file => `change:${file}`),
    ...(report.facts.diagnosis?.issues ?? []).map(issue => `diagnosis:${issue.id}`),
    ...(report.facts.humanReview ? ['human-review'] : []), ...report.notes.map(note => `note:${note.id}`)];
}
export function recordDevelopmentAnalysis(report, { expectedRevision, sourceHash, summary, findings }) {
  if (report.revision !== expectedRevision || reportSourceHash(report) !== sourceHash) throw fault('STALE_REPORT', '复盘来源已变化，请重新读取报告，不覆盖旧分析');
  const normalized = validateAnalysis(summary, findings, reportReferences(report));
  if (report.analysis) (report.analysisHistory ??= []).push(report.analysis);
  report.analysis = { at: now(), actor: 'model', sourceHash, baseRevision: expectedRevision, summary: summary.trim(), findings: normalized, note: 'AI 对报告的解释；引用存在不等于根因已证实，不自动成为通用知识。' };
  report.revision++; report.updatedAt = now();
  return report.analysis;
}
export function validateAnalysis(summary, findings, allowedReferences) {
  const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  if (!text(summary, 400) || !Array.isArray(findings) || findings.length > 8) throw fault('INVALID_ANALYSIS', '复盘摘要需为 1—400 字，分析最多 8 项');
  const references = new Set(allowedReferences);
  const normalized = findings.map(f => {
    if (!f || !['difficulty', 'attempt', 'cause', 'next', 'lesson'].includes(f.kind) || !['reported', 'hypothesis', 'supported'].includes(f.certainty) || !text(f.title, 80) || !text(f.detail, 1200) || !Array.isArray(f.evidenceRefs) || f.evidenceRefs.some(ref => !references.has(ref))) throw fault('INVALID_ANALYSIS', '分析类型、文字长度或来源引用不符合要求');
    if (f.certainty !== 'hypothesis' && !f.evidenceRefs.length) throw fault('UNSUPPORTED_CLAIM', '转述或有依据的判断必须引用报告来源；无来源请标为假设');
    return { id: randomUUID(), kind: f.kind, certainty: f.certainty, title: f.title.trim(), detail: f.detail.trim(), evidenceRefs: [...new Set(f.evidenceRefs)] };
  });
  return normalized;
}

// One report per execution batch. Submission is not stage completion or acceptance.
export function captureDevelopmentReport(state, task, trigger) {
  if (!task?.execution?.id) return null;
  const key = `${task.id}:${task.execution.id}`;
  const check = state.automaticChecks?.filter(c => c.executionId === task.execution.id).at(-1);
  const diagnosis = state.diagnostics.find(d => d.id === check?.reportId);
  const plans = [state.plan, ...(state.events ?? []).filter(entry => entry.type === 'plan-revised').map(entry => entry.data?.previousPlan).reverse()];
  const plan = plans.find(candidate => candidate && digest(candidate) === task.planHash);
  const facts = {
    taskId: task.id, executionId: task.execution.id, title: task.title, status: task.status,
    planHash: task.planHash, planTitle: plan?.title ?? '', planSource: plan ? 'matched-hash' : 'unavailable', acceptance: task.acceptance,
    scope: plan?.inScope ?? [], excluded: plan?.outOfScope ?? [],
    reportedSummary: task.summary ?? '', reportedEvidence: task.evidence ?? [],
    changes: { paths: check?.paths ?? [], scanComplete: check?.scanComplete ?? false, note: '检测到的已保存变化，不据此归属 Agent；未覆盖文件不能视为没有变更。' },
    automaticCheck: check ? { id: check.id, status: check.status, trigger: check.trigger, message: check.message ?? null } : null,
    diagnosis: diagnosis ? { id: diagnosis.id, stale: diagnosis.stale, coverage: diagnosis.coverage, issues: diagnosis.issues.map(({ id, title, category, severity }) => ({ id, title, category, severity })) } : null,
    humanReview: task.review?.executionId === task.execution.id ? task.review : null,
    recovery: task.recovery?.executionId === task.execution.id ? task.recovery : null,
    unresolved: [...(!plan ? ['未找到与任务版本一致的历史方案；未用当前方案补填旧任务范围。'] : []), '失败根因、尝试路线和可复用经验需要复盘，不能从任务状态自动推断。'],
  };
  const fingerprint = digest(facts);
  const reports = state.developmentReports ??= [];
  let report = reports.find(r => r.key === key);
  if (report?.fingerprint === fingerprint) return report;
  if (!report) { report = { id: randomUUID(), key, createdAt: now(), revision: 0, history: [], notes: [] }; reports.push(report); }
  if (report.facts) report.history.push({ revision: report.revision, at: report.updatedAt, trigger: report.trigger, facts: report.facts });
  report.revision++; report.updatedAt = now(); report.trigger = trigger; report.facts = structuredClone(facts); report.fingerprint = fingerprint;
  return report;
}
