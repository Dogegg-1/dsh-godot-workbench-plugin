import { randomUUID } from 'node:crypto';
import { engineIdentity } from './engine-identity.mjs';
import { recordQa } from './qa.mjs';
import { lifecycleStatus, changeLifecycle, lifecycleAllowsWork, requireLifecycleWork } from './lifecycle.mjs';
import { taskCanStart } from './task-gates.mjs';
import { normalizeDiagnosisPresentation, diagnosisExplanationBounds } from './diagnosis-presentation.mjs';
import { Store, digest, event, fault, now } from './storage.mjs';
import { normalizePlan, assessPlan, approvalValid, requireApproval, recordConfirmation, renderDocuments, acceptanceCoverage, validateAcceptanceItems, milestoneProgress } from './planning.mjs';
import { diagnose, prepareSuggestion, diagnosisContext } from './diagnostics.mjs';
import { gatherContext, searchKnowledge, recordKnowledgeSearch, recordKnowledgeFeedback } from './knowledge.mjs';
import { inspectProject } from './project.mjs';
import { lookupEngineReference } from './engine-reference.mjs';
import { newExecution, executionHealth } from './task-execution.mjs';
import { readProjectFile, applyFileChange, previewFileChanges, rollbackFiles, pendingFileOperations, assertNoFileRecovery, inspectFileRecovery, resolveFileRecovery } from './file-changes.mjs';
import { recordHealth, inspectRecordRecovery, applyRecordRecovery } from './record-recovery.mjs';
import { requestAutomaticCheck, executeAutomaticCheck, submissionHash, checkHealth, registerLiveCheck } from './automatic-checks.mjs';
import { inspectResources } from './project-resources.mjs';
import { projectEconomy } from './project-economy.mjs';
import { saveParameters, assetInfo, importAsset } from './resource-actions.mjs';
import { listTemporaryFixes, changeTemporaryFix } from './temporary-fixes.mjs';
import { captureDevelopmentReport, reportSourceHash, developmentAnalysisSource, recordDevelopmentAnalysis, developmentFollowUp } from './development-reports.mjs';
import { summarizeStages, summarizeMilestones } from './stage-reports.mjs';
import { stageAnalysisSource, recordStageAnalysis } from './stage-analysis.mjs';
import { readReportSource, requireCompleteReportRead } from './report-source-pages.mjs';
import { lessonCandidates, reviewLesson, projectLessonEntries, exportLesson, inspectLessonPackage, importLesson } from './project-lessons.mjs';

const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000) throw fault('INVALID_INPUT', `${label}需要非空文字（不超过 12000 字）`);
  return value.trim();
};
const publicTask = ({ summaryBasis, ...task }) => task;

export class Workbench {
  constructor({ projectRoot, enginePath } = {}) {
    if (!projectRoot) throw fault('MISSING_PROJECT', '请先选择项目目录');
    this.store = new Store(projectRoot);
    this.root = this.store.root;
    this.enginePath = enginePath;
  }
  async initialize() {
    await this.store.transaction(state => { if (!state.events.length) event(state, 'project-created', {}); });
    return this.status();
  }
  async lifecycleEngineIdentity() {
    return engineIdentity(this.enginePath);
  }
  async lifecycleChange(args, { localUser = false, resolveDelivery } = {}) {
    if (!localUser) throw fault('LOCAL_CONFIRMATION_REQUIRED', '阶段决定需要你在工作台确认');
    return this.store.transaction(async state => {
      // Never trust a client/model-provided "verified" delivery object.
      const delivery = args.action === 'advance' && state.lifecycle?.stage === 'release' && resolveDelivery
        ? await resolveDelivery(args.buildId) : undefined;
      const snapshot = await inspectProject(this.root);
      const result = changeLifecycle(state, snapshot, args, { delivery, engineIdentity: await this.lifecycleEngineIdentity() });
      event(state, 'lifecycle-changed', { stage: result.stage, mode: result.mode, iteration: result.iteration });
      return result;
    });
  }
  async qaRecord(args, {localUser=false}={}) {
    if(!localUser) throw fault('LOCAL_CONFIRMATION_REQUIRED','测试结果由你在工作台记录');
    return this.store.transaction(async state=>{
      const snapshot=await inspectProject(this.root);
      const view=lifecycleStatus(state,snapshot,await this.lifecycleEngineIdentity());
      if(view.stage!=='qa'||state.tasks.some(t=>t.status==='running')||state.automaticChecks?.some(c=>c.status==='checking')) throw fault('QA_NOT_READY','请先结束当前制作与检查，进入 QA 后记录测试');
      const result=recordQa(state,view.basis,args);
      event(state,'qa-recorded',{id:result.latest.id,complete:result.complete});return result;
    });
  }
  async status() {
    const state = await this.store.read();
    const fileRecovery = await pendingFileOperations(this.root, state);
    const assessment = assessPlan(state.plan);
    const approved = approvalValid(state);
    const storedDiagnosis = state.diagnostics.at(-1);
    const needsAcceptanceSnapshot = state.tasks.some(task => task.status === 'awaiting-review' || (task.status === 'accepted' && task.review?.coveredAcceptance?.length));
    const snapshot = await inspectProject(this.root);
    const acceptanceSnapshot = needsAcceptanceSnapshot ? snapshot : null;
    // Editor and external file saves do not emit workbench events. Derive freshness
    // on read, without rewriting the historical report or incrementing revisions.
    const latestDiagnosis = storedDiagnosis ? { ...storedDiagnosis, stale: Boolean(storedDiagnosis.stale || !snapshot?.complete || storedDiagnosis.fingerprint !== snapshot.fingerprint || storedDiagnosis.workflowFingerprint !== diagnosisContext(state)) } : null;
    const coverage = acceptanceCoverage(state, acceptanceSnapshot);
    const milestones = milestoneProgress(state, acceptanceSnapshot);
    const currentHash = state.plan ? digest(state.plan) : null;
    const developmentMode = state.approval?.developmentMode ?? 'stepwise';
    const tasks = state.tasks.map(({ summaryBasis, ...t }) => ({ ...t, currentPlan: t.planHash === currentHash, canStart: approved && lifecycleAllowsWork(state) && taskCanStart(t, { tasks: state.tasks, mode: developmentMode, report: latestDiagnosis, planHash: currentHash }) }));
    const current = tasks.filter(t => t.currentPlan);
    const automaticCheck = state.automaticChecks?.at(-1) ?? null;
    const phase = !assessment.ready ? 'intake' : !approved ? 'plan' : automaticCheck?.status === 'checking' ? 'diagnose' : !current.length || current.some(t => ['pending', 'running', 'failed', 'cancelled'].includes(t.status)) ? 'implement' : current.some(t => t.status !== 'accepted') || !coverage.complete || milestones.some(item => !item.complete) ? 'verify' : 'finish';
    const lessons = lessonCandidates(state).filter(item => !item.stale && item.review?.status !== 'revoked');
    const knowledgeGrowth = { total: lessons.length, pending: lessons.filter(item => item.review?.status !== 'approved').length, version: lessons.length ? digest(lessons.map(item => [item.key, item.sourceHash])) : null };
    return { lifecycle: lifecycleStatus(state, snapshot, await this.lifecycleEngineIdentity()), knowledgeGrowth, milestones, acceptanceSnapshot: acceptanceSnapshot ? { fingerprint: acceptanceSnapshot.fingerprint, complete: acceptanceSnapshot.complete } : null, acceptanceCoverage: coverage, projectManager: state.projectManager?.enginePath === (this.enginePath ?? '') ? state.projectManager : null, projectRoot: this.root, enginePath: this.enginePath ?? null, projectId: state.projectId, revision: state.revision, phase, developmentMode, plan: state.plan, planHash: currentHash, assessment, approved, approval: state.approval, tasks, temporaryFixes: state.temporaryFixes ?? [], recovery: state.tasks.map(executionHealth).filter(Boolean), fileRecovery, recordHealth: { ...await recordHealth(this.root), backupWarning: this.store.backupWarning ?? null }, progress: { accepted: current.filter(t => t.status === 'accepted').length, total: current.length, meaning: '当前方案的人工验收任务数，不代表质量百分比' }, automaticCheck: automaticCheck ? { ...automaticCheck, health: checkHealth(automaticCheck) } : null, latestDiagnosis, documents: renderDocuments(state.plan, { tasks, coverage, phase, approved }) };
  }
  async recordRecoveryInspect(options) { return inspectRecordRecovery(this.root, options); }
  async developmentReports() {
    const state = await this.store.read();
    const snapshot = state.tasks.some(task => task.status === 'accepted' && task.review?.coveredAcceptance?.length) ? await inspectProject(this.root) : null;
    return { milestones: summarizeMilestones(state, snapshot).map(stage => { const source = stageAnalysisSource(state, stage.planHash, snapshot, stage); return { ...stage, reportId: source.id, sourceHash: source.sourceHash, analysis: source.analysis, analysisStale: source.analysisStale, analysisHistory: source.analysisHistory }; }), stages: summarizeStages(state, snapshot).map(stage => { const source = stageAnalysisSource(state, stage.planHash, snapshot, stage); return { ...stage, reportId: source.id, sourceHash: source.sourceHash, analysis: source.analysis, analysisStale: source.analysisStale, analysisHistory: source.analysisHistory }; }), reports: (state.developmentReports ?? []).map(report => ({ ...report, sourceHash: reportSourceHash(report), analysisStale: Boolean(report.analysis && report.analysis.sourceHash !== reportSourceHash(report)) })), note: '按执行批次留档；提交不等于阶段完成。记录保留在当前项目，不自动进入共享知识库。' };
  }
  async developmentReportRead({ reportId, sourceCursor } = {}) {
    if (sourceCursor && !reportId) throw fault('INVALID_INPUT', '分段读取必须指定原reportId');
    if (typeof reportId === 'string' && /^(stage|milestone):/.test(reportId)) {
      if (!/^(stage:[a-f0-9]{64}|milestone:[a-f0-9]{64}:[a-zA-Z][a-zA-Z0-9_-]{0,63})$/.test(reportId)) throw fault('UNKNOWN_REPORT', '阶段报告标识不完整，请使用索引返回的ID');
      const state = await this.store.read();
      const snapshot = state.tasks.some(task => task.status === 'accepted' && task.review?.coveredAcceptance?.length) ? await inspectProject(this.root) : null;
      const source = stageAnalysisSource(state, reportId.split(':')[1], snapshot, undefined, reportId.startsWith('milestone:') ? reportId.split(':')[2] : undefined);
      return readReportSource(source, this.root, sourceCursor);
    }
    const state = await this.store.read();
    const reports = state.developmentReports ?? [];
    if (!reportId) return { milestones: summarizeMilestones(state).map(stage => ({id:`milestone:${stage.planHash}:${stage.milestoneId}`,title:stage.title,current:stage.current})), reports: reports.slice(-20).map(r => ({ id: r.id, revision: r.revision, sourceHash: reportSourceHash(r), title: r.facts.title, status: r.facts.status })), stages: summarizeStages(state).map(stage => ({ id: `stage:${stage.planHash}`, title: stage.title, current: stage.current })), total: reports.length };
    const report = reports.find(r => r.id === reportId);
    if (!report) throw fault('UNKNOWN_REPORT', '开发报告不存在');
    return readReportSource(developmentAnalysisSource(report), this.root, sourceCursor);
  }
  async projectLessons() { return { candidates: lessonCandidates(await this.store.read()) }; }
  async projectLessonExport(args) { return exportLesson(await this.store.read(), args); }
  async projectLessonInspect({ package: input }) { return inspectLessonPackage(input); }
  async projectLessonImport(args) {
    return this.store.transaction(state => {
      const result = importLesson(state, args);
      if (!result.duplicate) event(state, 'project-lesson-imported', { key: result.key });
      return result;
    });
  }
  async projectLessonReview(args) {
    return this.store.transaction(state => {
      const result = reviewLesson(state, args);
      event(state, 'project-lesson-reviewed', { key: result.key, status: result.status });
      return result;
    });
  }
  async developmentReportAnalyze(args) {
    return this.store.transaction(async state => {
      if (typeof args.reportId === 'string' && /^(stage|milestone):/.test(args.reportId)) {
        if (!/^(stage:[a-f0-9]{64}|milestone:[a-f0-9]{64}:[a-zA-Z][a-zA-Z0-9_-]{0,63})$/.test(args.reportId)) throw fault('UNKNOWN_REPORT', '阶段报告标识不完整，请使用索引返回的ID');
        const snapshot = state.tasks.some(task => task.status === 'accepted' && task.review?.coveredAcceptance?.length) ? await inspectProject(this.root) : null;
        const source = stageAnalysisSource(state, args.reportId.split(':')[1], snapshot, undefined, args.reportId.startsWith('milestone:') ? args.reportId.split(':')[2] : undefined);
        requireCompleteReportRead(source, this.root, args.sourceReadToken);
        const result = recordStageAnalysis(state, source, args);
        event(state, 'stage-analyzed', { planHash: source.stage.planHash, milestoneId: source.stage.milestoneId ?? null, sourceHash: result.sourceHash });
        return result;
      }
      const report = state.developmentReports?.find(r => r.id === args.reportId);
      if (!report) throw fault('UNKNOWN_REPORT', '开发报告不存在');
      requireCompleteReportRead(developmentAnalysisSource(report), this.root, args.sourceReadToken);
      const result = recordDevelopmentAnalysis(report, args);
      event(state, 'development-report-analyzed', { reportId: report.id, revision: report.revision, sourceHash: result.sourceHash });
      return result;
    });
  }
  async developmentReportNote({ reportId, expectedRevision, note }) {
    note = text(note, '复盘补充');
    return this.store.transaction(state => {
      const report = state.developmentReports?.find(r => r.id === reportId);
      if (!report) throw fault('UNKNOWN_REPORT', '开发报告不存在');
      if (report.revision !== expectedRevision) throw fault('STALE_REPORT', '报告已有更新，请重新查看后补充');
      report.notes.push({ id: randomUUID(), at: now(), actor: 'local-user', text: note });
      report.revision++; report.updatedAt = now();
      event(state, 'development-report-note', { reportId, revision: report.revision });
      return report;
    });
  }
  async recordRecoveryApply(options) { return applyRecordRecovery(this.root, options); }
  async savePlan(input) {
    const plan = normalizePlan(input);
    await this.store.transaction(state => {
      if (state.plan && digest(state.plan) === digest(plan)) return;
      if (state.tasks.some(t => t.status === 'running')) throw fault('TASK_RUNNING', '请先结束或标记当前任务失败，再修改方案');
      event(state, 'plan-revised', { previousPlan: state.plan, previousApproval: state.approval, planHash: digest(plan) });
      state.plan = plan;
      state.approval = null;
    });
    return this.status();
  }
  // Only call from a user action in the local UI/CLI, never register as a model tool.
  async confirmPlan(confirmation) {
    await this.store.transaction(async state => {
      if (state.tasks.some(task => task.status === 'running')) throw fault('TASK_RUNNING', '请先结束当前任务，再确认制作节奏');
      recordConfirmation(state, confirmation); event(state, 'plan-confirmed', state.approval);
      if (confirmation.lifecycleMode !== undefined || state.lifecycle) {
        const snapshot = await inspectProject(this.root), engineIdentity = await this.lifecycleEngineIdentity();
        const apply = args => {
          const view = lifecycleStatus(state,snapshot,engineIdentity);
          return changeLifecycle(state,snapshot,{...args,expectedVersion:view.version,expectedBasis:view.basis,statement:confirmation.statement},{engineIdentity});
        };
        if (confirmation.lifecycleMode !== undefined && confirmation.lifecycleMode !== state.lifecycle?.mode) apply({action:'mode',mode:confirmation.lifecycleMode});
        // The user's existing "confirm and start" action also starts the matching
        // production stage. An incomplete full GDD aborts the entire transaction.
        if (['direction','design'].includes(state.lifecycle?.stage)) apply({action:'advance'});
        requireLifecycleWork(state);
      }
    });
    return this.status();
  }
  async addTask({ title, acceptance, dependsOn = [], acceptanceItems = [], milestoneId, repairRequestId }) {
    title = text(title, '任务标题'); acceptance = text(acceptance, '验收条件');
    if (!Array.isArray(dependsOn) || dependsOn.some(id => typeof id !== 'string') || new Set(dependsOn).size !== dependsOn.length) throw fault('INVALID_DEPENDENCIES', '依赖必须为不重复的任务 ID 列表');
    return this.store.transaction(async state => {
      requireApproval(state);
      requireLifecycleWork(state);
      const planHash = digest(state.plan);
      acceptanceItems = validateAcceptanceItems(state.plan, acceptanceItems);
      const milestones = state.plan.milestones ?? [];
      const milestone = milestones.find(item => item.id === milestoneId);
      if ((milestones.length && !milestone) || (milestoneId !== undefined && !milestone)) throw fault('INVALID_MILESTONE', '请关联当前方案中的有效项目阶段');
      if (milestone && (!acceptanceItems.length || acceptanceItems.some(number => !milestone.acceptanceItems.includes(number)))) throw fault('INVALID_MILESTONE_ACCEPTANCE', '任务验收关联需为所属阶段的非空验收条件子集');
      if (dependsOn.some(id => !state.tasks.some(t => t.id === id && t.planHash === planHash))) throw fault('INVALID_DEPENDENCIES', '依赖任务不存在或属于旧方案');
      const task = { id: randomUUID(), title, acceptance, acceptanceItems, ...(milestone ? { milestoneId } : {}), dependsOn, planHash, status: 'pending', createdAt: now(), evidence: [] };
      if (repairRequestId !== undefined) {
        const request = state.repairRequests?.find(item => item.id === repairRequestId);
        if (!request || request.planHash !== planHash) throw fault('INVALID_REPAIR_REQUEST', '本次修复没有对应的用户请求，请在诊断页请求局部修复。');
        if (request.taskId) return state.tasks.find(item => item.id === request.taskId);
        const snapshot = await inspectProject(this.root);
        if (!snapshot.complete || snapshot.fingerprint !== request.fingerprint) throw fault('STALE_REPAIR_REQUEST', '请求修复后工程已变化，请重新检查问题。');
        task.diagnosisRepair = { ...request, actor: 'local-user' }; request.taskId = task.id;
      }
      state.tasks.push(task); event(state, 'task-created', task);
      return task;
    });
  }
  async updateTask({ taskId, action, summary, evidence = [], executionId, checkMode = 'auto', checkReason = '' }, { sessionId, signal, localUser = false } = {}) {
    if (!['auto', 'static'].includes(checkMode)) throw fault('INVALID_CHECK_MODE', '检查方式必须为 auto 或 static');
    if (checkMode === 'static') checkReason = text(checkReason, '仅做文件检查的原因');
    if (!['start', 'submit', 'fail', 'retry'].includes(action)) throw fault('INVALID_ACTION', '不支持的任务动作');
    if (['submit', 'fail'].includes(action)) summary = text(summary, '变更说明');
    if (!Array.isArray(evidence) || evidence.length > 30 || evidence.some(e => !e || !['file', 'log', 'test', 'screenshot', 'manual'].includes(e.type) || typeof e.detail !== 'string' || !e.detail.trim() || e.detail.length > 12000)) throw fault('INVALID_EVIDENCE', 'evidence 必须是最多 30 条的数组，例如 [{"type":"test","detail":"实际命令、结果与未覆盖项"}]。type 仅支持 file、log、test、screenshot、manual；detail 需要 1 至 12000 字的非空文字。请修正参数，不必查找插件源码。');
    if (action === 'submit' && !evidence.length) throw fault('MISSING_EVIDENCE', '提交验收时必须记录验证证据和未覆盖项');
    const submitting = ['submit', 'fail'].includes(action);
    const requestHash = submitting ? submissionHash({ action, summary, evidence, executionId, checkMode, checkReason }) : null;
    if (submitting) {
      const current = await this.store.read();
      const check = current.automaticChecks?.find(item => item.taskId === taskId && item.executionId === executionId && item.requestHash === requestHash);
      const task = current.tasks.find(item => item.id === taskId);
      if (check && task?.execution?.id === executionId && task.status === (action === 'submit' ? 'awaiting-review' : 'failed')) {
        requireApproval(current);
        if (task.planHash === digest(current.plan)) {
          const stored = current.diagnostics.find(r => r.id === check.reportId);
          const report = stored ? { ...stored, stale: stored.stale || stored.fingerprint !== (await inspectProject(this.root)).fingerprint || stored.workflowFingerprint !== diagnosisContext(current) } : null;
          return { ...publicTask(task), developmentFollowUp: developmentFollowUp(current, task), automaticDiagnosis: { check: { ...check, health: checkHealth(check) }, report, reused: true } };
        }
      }
    }
    const unregister = submitting ? registerLiveCheck(`${executionId}:${action}`) : () => {};
    try {
    const task = await this.store.transaction(async state => {
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) throw fault('UNKNOWN_TASK', '任务不存在');
      requireApproval(state);
      if (task.planHash !== digest(state.plan)) throw fault('STALE_TASK', '此任务属于旧方案，请重新规划当前任务');
      const from = { start: 'pending', submit: 'running', fail: 'running', retry: 'failed' }[action];
      if (task.status !== from && !(action === 'retry' && task.status === 'cancelled')) throw fault('INVALID_TRANSITION', `无法从 ${task.status} 执行 ${action}`);
      if (submitting && !task.execution?.id) throw fault('STALE_EXECUTION', '旧任务没有执行标识，请先核查并恢复中断记录。');
      if (['submit', 'fail'].includes(action) && task.execution && executionId !== task.execution.id) throw fault('STALE_EXECUTION', '本次执行标识不匹配，请读取当前任务；旧执行结果不能写入重试后的任务。submit/fail 请传入 start 返回的 execution.id 作为 executionId。');
      if (submitting) await assertNoFileRecovery(this.root, state);
      if (action === 'retry' && state.approval?.developmentMode === 'continuous') {
        if (!localUser) throw fault('RETRY_CONFIRMATION_REQUIRED', '连续制作已停止。请用户在失败任务上点击重新安排，再进行局部修复。');
        task.continuousRepair = { executionId: task.execution?.id, actor: 'local-user', at: now() };
      }
      if (action === 'start') {
        requireLifecycleWork(state);
        if (state.automaticChecks?.some(check => check.status === 'checking')) throw fault('CHECK_PENDING', '上一批自动检查尚未结束或曾中断，请先核查诊断状态后继续。');
        await assertNoFileRecovery(this.root, state);
        if (state.tasks.some(t => t.status === 'running')) throw fault('TASK_RUNNING', '已有任务执行中');
        if (state.approval?.developmentMode === 'continuous') {
          const snapshot = await inspectProject(this.root), stored = state.diagnostics.at(-1);
          const report = stored ? { ...stored, stale: stored.stale || !snapshot.complete || stored.fingerprint !== snapshot.fingerprint || stored.workflowFingerprint !== diagnosisContext(state) } : null;
          if (task.diagnosisRepair && !task.diagnosisRepair.started && task.diagnosisRepair.fingerprint !== snapshot.fingerprint) throw fault('STALE_REPAIR_REQUEST', '修复开始前工程已变化，请重新检查问题。');
          if (!taskCanStart(task, { tasks: state.tasks, mode: 'continuous', report, planHash: digest(state.plan) })) throw fault('DEPENDENCY_PENDING', '连续制作条件尚未满足：先处理失败任务或更新工程检查；人工试玩状态不会自动通过。');
        } else if (task.dependsOn.some(id => state.tasks.find(t => t.id === id)?.status !== 'accepted')) throw fault('DEPENDENCY_PENDING', '前置任务尚未通过验收');
        delete task.continuousRepair;
        if (task.diagnosisRepair) task.diagnosisRepair.started = true;
        task.execution = newExecution(sessionId);
        task.summary = ''; task.evidence = []; delete task.summaryBasis;
        const baseline = await inspectProject(this.root);
        (state.fileBaselines ??= {})[task.execution.id] = { files: baseline.files.map(({ path, hash }) => ({ path, hash })), complete: baseline.complete, skipped: baseline.skipped };
      }
      task.status = { start: 'running', submit: 'awaiting-review', fail: 'failed', retry: 'pending' }[action];
      task.updatedAt = now();
      if (summary) task.summary = summary;
      if (evidence.length) task.evidence = evidence;
      event(state, `task-${action}`, { taskId, summary, evidence, execution: task.execution });
      if (submitting) await requestAutomaticCheck(this.root, state, task, action, requestHash, { checkMode, checkReason });
      if (submitting) captureDevelopmentReport(state, task, action);
      return task;
    });
    if (!submitting) return publicTask(task);
    let automaticDiagnosis;
    try { automaticDiagnosis = await executeAutomaticCheck(this, `${task.execution.id}:${action}`, signal); }
    catch (error) { automaticDiagnosis = { check: { status: 'incomplete', message: `任务已记录，但自动检查未完成：${error.message}` }, report: null }; }
    return { ...publicTask(task), automaticDiagnosis, developmentFollowUp: developmentFollowUp(await this.store.read(), task) };
    } finally { unregister(); }
  }
  // Explicit local user action. It records a stop; it does not kill host tools
  // or roll back files. The UI must stop the owning DSH session first.
  async recoverTask({ taskId, expectedRevision, statement, stoppedConfirmed }) {
    statement = text(statement, '中断或停止原因');
    if (stoppedConfirmed !== true) throw fault('STOP_NOT_CONFIRMED', '请先停止对应会话，核对已停止后再记录任务');
    return this.store.transaction(state => {
      if (state.revision !== expectedRevision) throw fault('STALE_RECOVERY', '任务记录已变化，请重新查看后再恢复');
      const task = state.tasks.find(t => t.id === taskId);
      if (!task || task.status !== 'running') throw fault('INVALID_TRANSITION', '只有尚未结束的任务需要中断恢复');
      task.status = 'cancelled'; task.updatedAt = now();
      task.recovery = { at: now(), executionId: task.execution?.id, actor: 'local-user', statement, health: executionHealth({ ...task, status: 'running' }) };
      event(state, 'task-cancelled', { taskId, execution: task.execution, recovery: task.recovery });
      captureDevelopmentReport(state, task, 'cancelled');
      for (const report of state.diagnostics) report.stale = true;
      return task;
    });
  }
  // Human acceptance is distinct from an agent's claimed test result.
  async reviewTask({ taskId, accepted, statement, coveredAcceptance = [], problemAcceptance = [], expectedExecutionId, expectedReviewVersion, expectedProjectFingerprint }) {
    if (typeof accepted !== 'boolean') throw fault('INVALID_REVIEW', '需要明确通过或退回');
    statement = text(statement, '试玩意见');
    return this.store.transaction(async state => {
      requireApproval(state);
      const task = state.tasks.find(t => t.id === taskId);
      if (!task || task.planHash !== digest(state.plan)) throw fault('STALE_TASK', '任务不存在或属于旧方案');
      const problems=validateAcceptanceItems(state.plan,problemAcceptance);
      if(accepted&&problems.length)throw fault('INVALID_REVIEW','已勾选问题，请提交问题或取消勾选后再通过');
      if (!['awaiting-review', 'accepted'].includes(task.status)) throw fault('INVALID_TRANSITION', '任务尚未提交验收');
      if (expectedExecutionId !== undefined && task.execution?.id !== expectedExecutionId) throw fault('STALE_EXECUTION', '任务执行已变化，请重新查看后验收');
      const reviewVersion = task.review?.version ?? 0;
      if (expectedReviewVersion !== undefined && expectedReviewVersion !== reviewVersion) throw fault('STALE_REVIEW', '验收记录已有更新，请重新打开核对，不覆盖后续意见');
      const covered = validateAcceptanceItems(state.plan, coveredAcceptance);
      if (!accepted && covered.length) throw fault('INVALID_REVIEW', '退回任务不能同时标记验收条件通过');
      const snapshot = accepted && covered.length ? await inspectProject(this.root) : null;
      if (snapshot && expectedProjectFingerprint !== undefined && expectedProjectFingerprint !== snapshot.fingerprint) throw fault('STALE_REVIEW_FILES', '打开验收窗口后工程文件有变化，请重新打开并核对后再确认');
      if (task.review) (task.reviewHistory ??= []).push(task.review);
      task.status = accepted ? 'accepted' : 'failed';
      task.review = { version: reviewVersion + 1, at: now(), executionId: task.execution?.id, actor: 'local-user', statement, accepted, coveredAcceptance: covered, problemAcceptance: problems, basis: snapshot ? { fingerprint: snapshot.fingerprint, scanComplete: snapshot.complete, planHash: task.planHash } : null };
      event(state, 'task-reviewed', { taskId, ...task.review });
      captureDevelopmentReport(state, task, 'human-review');
      return task;
    });
  }
  async diagnose({ runImport = false, signal } = {}) {
    if (typeof runImport !== 'boolean') throw fault('INVALID_ARGUMENTS', '检查模式必须为快速检查或引擎检查');
    return this.store.transaction(async state => {
      const pending = (state.automaticChecks ?? []).filter(check => check.status === 'checking');
      if (pending.some(check => checkHealth(check)?.state !== 'interrupted')) throw fault('CHECK_PENDING', '自动检查仍在执行或宿主状态不明，请稍后重试；不会同时启动另一轮引擎检查。');
      if (runImport) await assertNoFileRecovery(this.root, state);
      const report = await diagnose(this.root, state, { enginePath: this.enginePath, runImport, signal });
      report.origin = { type: 'manual', mode: runImport ? 'engine' : 'quick' };
      state.diagnostics.push(report);
      for (const check of state.automaticChecks ?? []) if (pending.some(item => item.id === check.id) && check.status === 'checking') { check.status = 'failed'; check.message = '原检查宿主已退出；已由本次手动检查替代。'; }
      event(state, 'diagnosis-created', { reportId: report.id, stale: report.stale });
      return report;
    });
  }
  async context(options) {
    const state = await this.store.read();
    const result = await gatherContext(this.root, state, options);
    const fixes = await listTemporaryFixes(this.root, state, { includeResolved: false });
    return { ...result, temporaryFixes: { total: fixes.items.length, items: fixes.items.slice(0, 8).map(({ id, version, title, paths, limitations, removalCondition, followUp, effectiveStatus }) => ({ id, version, title, paths, limitations, removalCondition, followUp, effectiveStatus })) } };
  }
  async temporaryFixes(options) { return listTemporaryFixes(this.root, await this.store.read(), options); }
  async temporaryFixChange(options) { return changeTemporaryFix(this, options); }
  async fileRead(options) {
    const file = await readProjectFile(this.root, options);
    return { ...file, temporaryFixes: (await this.temporaryFixes({ path: options.path, includeResolved: false })).items };
  }
  async resources(options = {}) {
    const state = await this.store.read();
    const result = await inspectResources(this.root, { state, values: options.values });
    if (options.simulation !== undefined) {
      result.economySimulation = await projectEconomy(this.root, options.simulation, options.values);
      if (result.economySimulation.available && (result.economySimulation.sources['game-workbench.json'] !== result.manifest.hash || result.economySimulation.sources['balance.tres'] !== result.parameters.hash)) throw fault('RESOURCE_CHANGED', '资源视图与模拟读取的版本不同，请重新计算');
    }
    if ((await this.store.read()).revision !== state.revision) throw fault('RESOURCE_CHANGED', '读取期间项目状态变化，请刷新资源视图');
    return result;
  }
  async parametersSave(options) { return saveParameters(this, options); }
  async assetInfo(options) { return assetInfo(this.root, options); }
  async assetImport(options) { return importAsset(this, options); }
  async fileChange(options) { return applyFileChange(this, options); }
  async fileRecoveryInspect(options) { return inspectFileRecovery(this, options); }
  async fileRecoveryResolve(options) {
    const result = await resolveFileRecovery(this, options);
    if ((await pendingFileOperations(this.root, await this.store.read())).length) return result;
    try {
      const report = await this.diagnose({ runImport: true, signal: options?.signal });
      return { ...result, verification: { reportId: report.id, stale: report.stale, coverage: report.coverage }, message: `${result.message} 已生成工程检查，请查看诊断；功能与试玩仍需验收。` };
    } catch (error) { return { ...result, message: `${result.message} 后续检查未完成：${error.message}` }; }
  }
  async fileChanges(options) { return previewFileChanges(this, options); }
  async fileRollback(options) {
    options?.signal?.throwIfAborted();
    const result = await rollbackFiles(this, options);
    try {
      const report = await this.diagnose({ runImport: true, signal: options?.signal });
      return { ...result, verification: { reportId: report.id, stale: report.stale, coverage: report.coverage }, message: `指定文件已恢复。${report.coverage.engineImport === 'passed' && !report.stale ? '引擎导入通过，功能与试玩仍需重新验证。' : '工程检查已记录，仍有未通过或未执行项，请查看项目诊断。'}` };
    } catch (error) {
      return { ...result, verification: { status: 'incomplete', reason: error.message }, message: '指定文件已恢复，但后续检查未完成。请重新诊断，不要据此认定功能已恢复。' };
    }
  }
  async knowledge(options = {}) { return recordKnowledgeSearch(this.root, options, await searchKnowledge(options, projectLessonEntries(await this.store.read())), 'requested'); }
  // User feedback is not a model tool or a claim that a recipe passed runtime tests.
  async knowledgeFeedback(options) { return recordKnowledgeFeedback(this.root, options); }
  async engineReference(options) { return lookupEngineReference(this, options); }
  async suggestion({ reportId, issueId, requestRepair = false }) {
    if (!requestRepair) return prepareSuggestion(this.root, await this.store.read(), reportId, issueId);
    return this.store.transaction(async state => {
      const suggestion = await prepareSuggestion(this.root, state, reportId, issueId);
      if (state.approval?.developmentMode !== 'continuous' || suggestion.module !== 'engineering') return suggestion;
      requireApproval(state);
      const report = state.diagnostics.find(item => item.id === reportId);
      if (!report.issues.some(item => item.severity === 'blocking')) return suggestion;
      const requests = state.repairRequests ??= [];
      let request = requests.find(item => item.reportId === reportId && item.issueId === issueId);
      if (!request) {
        request = { id: randomUUID(), reportId, issueId, planHash: digest(state.plan), fingerprint: report.fingerprint, at: now() };
        requests.push(request); event(state, 'repair-requested', request);
      }
      return { ...suggestion, repairRequestId: request.id, text: suggestion.text + `\n用户已通过诊断页请求本次局部修复。创建修复任务时传 repairRequestId=${request.id}，只处理该问题，不以此推进其他玩法；已有对应任务则复用。读取原始故障证据，修复后重验并保留历史失败，不代用户通过试玩。` };
    });
  }
  async diagnosisPresentation({ reportId, issueId, expectedHash, presentation }) {
    const updating = presentation !== undefined;
    const normalized = updating ? normalizeDiagnosisPresentation(presentation) : undefined;
    const inspect = async state => {
      const report = state.diagnostics.find(r => r.id === reportId);
      if (!report) throw fault('UNKNOWN_REPORT', '诊断报告不存在');
      const snapshot = await inspectProject(this.root);
      if (report.stale || snapshot.fingerprint !== report.fingerprint || report.workflowFingerprint !== diagnosisContext(state)) throw fault('STALE_DIAGNOSIS', '项目或开发状态已变化，请重新检查');
      const issue = [...report.issues, ...(report.aiReview.findings ?? [])].find(item => item.id === issueId);
      if (!issue) throw fault('UNKNOWN_ISSUE', '原问题已不存在，请重新读取当前报告');
      const sourceHash = digest(issue);
      if (!updating) return { reportId, issueId, sourceHash, issue, explanationBounds: diagnosisExplanationBounds(issue), note: '只读来源；仅补充白话说明，不修改判断、建议、证据或验收。' };
      if (expectedHash !== sourceHash) throw fault('PRESENTATION_CONFLICT', '该问题或说明已更新，请重新读取后解释');
      const previous = issue.presentation;
      issue.presentation = normalized;
      event(state, 'diagnosis-presentation-updated', { reportId, issueId, sourceHash, previous, presentation: normalized });
      return { reportId, issueId, presentation: normalized, sourceHash: digest(issue) };
    };
    return updating ? this.store.transaction(inspect) : inspect(await this.store.read());
  }
  async recordAIReview({ reportId, summary, findings = [] }) {
    summary = text(summary, '诊断摘要');
    if (!Array.isArray(findings) || findings.length > 12) throw fault('INVALID_REVIEW', '诊断建议最多 12 条');
    const normalized = findings.map(f => {
      if (f?.module !== undefined && !['design', 'production', 'engineering', 'verification'].includes(f.module)) throw fault('INVALID_REVIEW', '评估模块需为 design、production、engineering 或 verification');
      if (!f || !['confirmed', 'risk', 'hypothesis'].includes(f.category) || !['blocking', 'warning', 'info'].includes(f.severity) || !Array.isArray(f.evidenceIssueIds) || f.evidenceIssueIds.some(id => typeof id !== 'string')) throw fault('INVALID_REVIEW', '每条判断需要类型、严重度和引用问题 ID 列表');
      if (f.category === 'confirmed' && !f.evidenceIssueIds.length) throw fault('UNSUPPORTED_CLAIM', '确定性判断需要引用已有检查证据，尚无证据时请标为假设');
      const presentation = normalizeDiagnosisPresentation(f.presentation);
      return { id: randomUUID(), module: f.module, title: text(f.title, '问题标题'), explanation: text(f.explanation, '问题说明'), suggestion: text(f.suggestion, '修缮建议'), category: f.category, severity: f.severity, evidenceIssueIds: [...new Set(f.evidenceIssueIds)], ...(presentation ? { presentation } : {}) };
    });
    return this.store.transaction(async state => {
      const report = state.diagnostics.find(r => r.id === reportId);
      if (!report) throw fault('UNKNOWN_REPORT', '诊断报告不存在');
      const snapshot = await inspectProject(this.root);
      if (report.stale || snapshot.fingerprint !== report.fingerprint || report.workflowFingerprint !== diagnosisContext(state)) throw fault('STALE_DIAGNOSIS', '分析期间项目或开发状态已变更，请重新诊断');
      for (const finding of normalized) {
        if (finding.evidenceIssueIds.some(id => !report.issues.some(i => i.id === id))) throw fault('INVALID_EVIDENCE', '引用的检查证据不存在');
        finding.module ??= report.issues.find(i => finding.evidenceIssueIds.includes(i.id))?.module;
        finding.evidence = finding.evidenceIssueIds.flatMap(id => report.issues.find(i => i.id === id).evidence);
      }
      const review = { status: 'completed', at: now(), actor: 'model', summary, findings: normalized, note: 'AI 对检查证据的解释，仍需核实；不会改变自动检查或人工试玩状态。' };
      event(state, 'diagnosis-ai-reviewed', { reportId, previousReview: report.aiReview, review });
      report.aiReview = review;
      return report;
    });
  }
}
