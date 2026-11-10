import { randomUUID } from 'node:crypto';
import { now, digest, fault } from './storage.mjs';
import { assessPlan, approvalValid } from './planning.mjs';
import { inspectProject, checkGodot } from './project.mjs';
import { inspectResources } from './project-resources.mjs';
import { listTemporaryFixes } from './temporary-fixes.mjs';
import { inspectExportReadiness } from './export-readiness.mjs';
import { runtimeHealth } from './runtime-health.mjs';
import { engineIdentity as identifyEngine } from './engine-identity.mjs';

export const diagnosisContext = state => digest({ plan: state.plan, approval: state.approval, tasks: state.tasks.map(({summaryBasis, ...task})=>task), temporaryFixes: state.temporaryFixes ?? [] });

export async function diagnose(root, state, { enginePath, runImport = false, skipEngineReason, signal, checkEngine = checkGodot } = {}) {
  const engineIdentity = await identifyEngine(enginePath);
  const snapshot = await inspectProject(root);
  const issues = [];
  const add = (code, title, explanation, suggestion, evidence, category = 'confirmed', severity = 'blocking') => issues.push({ id: randomUUID(), code, module: code.startsWith('PLAN_') || code.startsWith('TASK_') ? 'production' : code === 'PROJECT_CHANGED' ? 'verification' : 'engineering', title, explanation, suggestion, evidence, category, severity });
  const runtime = await runtimeHealth(root, enginePath);
  if (runtime.failures.length) add('RUNTIME_NATIVE_FAILURE', '这版游戏曾异常退出', '已有相同工程文件和引擎路径的异常退出记录。后来检查通过不能证明故障已解决，具体原因仍需核实。', '先核对异常退出的运行记录与环境，确定修复或兼容方案，再验证；不要反复重试直到通过。', runtime.failures);
  if (!runtime.complete) add('RUNTIME_HISTORY_INCOMPLETE', '部分运行记录未能核对', '历史记录不完整、无法读取或超过本次核对范围，不能据此排除已有运行故障。', '保留原记录并核对读取问题，再评估运行稳定性。', [{ type: 'runtime-history-coverage', complete: false }], 'confirmed', 'warning');
  if (!snapshot.complete) {
    add('SCAN_INCOMPLETE', '部分文件尚未检查', '本次读取跳过了部分内容，不能确认这些内容及相关引用是否正常。', '先查看跳过原因，核对涉及的玩法文件；不要为通过检查删除文件、改名绕过保护或发送凭据。', [{ type: 'scan-coverage', skipped: snapshot.skipped, scope: '仅本次配置范围内的文件读取；不等同引擎检查或人工试玩' }], 'confirmed', 'warning');
    issues.at(-1).module = 'verification';
  }
  const resources = await inspectResources(root, { state, snapshot });
  const fixes = await listTemporaryFixes(root, state, { includeResolved: false });
  for (const item of fixes.items) add('TEMPORARY_FIX', item.effectiveStatus === 'needs-review' ? `临时修复需要重验：${item.title}` : `临时方案仍在使用：${item.title}`, `原因：${item.reason}。适用范围：${item.scope}。限制：${item.limitations}。`, `先核对移除条件：${item.removalCondition}。后续工作：${item.followUp}。不满足条件时保留记录，不自动扩大范围。`, [{ type: 'temporary-fix', id: item.id, version: item.version }, ...item.paths.map(path => ({ type: 'file', path }))], 'risk', 'warning');
  for (const issue of resources.issues.slice(0, 40)) add(issue.code, issue.code === 'RESOURCE_REFERENCE_MISSING' ? '资源引用需要核对' : '项目参数或资源说明需要修正', issue.message, '在项目资源中核对当前值和引用位置，修正后重新检查；不要删除未发现引用的文件。', [{ type: 'file', path: issue.path, line: issue.line }], issue.category, issue.category === 'risk' ? 'warning' : 'blocking');
  const planAssessment = assessPlan(state.plan);
  if (!planAssessment.ready) add('PLAN_INCOMPLETE', '开发方案还缺少关键决定', planAssessment.questions.join(' '), '先补齐核心体验、当前范围与验收条件，再展示方案请我确认。', [{ type: 'plan', missing: planAssessment.missing }]);
  else if (!approvalValid(state)) add('PLAN_NOT_CONFIRMED', '当前方案还没有确认', '方案内容已整理，但没有匹配当前版本的用户确认。', '展示当前 GDD 和开发计划，说明范围与验收方式，请我确认后再开发。', [{ type: 'plan', hash: digest(state.plan) }]);
  const currentTasks = state.tasks.filter(task => task.planHash === (state.plan ? digest(state.plan) : null));
  const failed = currentTasks.filter(task => task.status === 'failed');
  if (failed.length) add('TASK_FAILED', '本阶段有未解决的失败任务', `${failed.length} 项任务标记失败，请先核对卡点和依赖再继续排期。`, '查看失败任务的记录和证据，区分设计决策、技术障碍与验证不足，再讨论最小下一步。', failed.map(task => ({ type: 'task', id: task.id, title: task.title, status: task.status })), 'confirmed', 'warning');
  const project = snapshot.files.find(f => f.path === 'project.godot');
  if (!project) add('NO_GODOT_PROJECT', '还没有可运行的 Godot 工程', '当前目录未发现 project.godot。', '在当前方案确认后建立最小 Godot 工程和入口场景，先验证能启动。', [{ type: 'file-absence', path: 'project.godot' }], 'confirmed', approvalValid(state) ? 'blocking' : 'info');
  else {
    const main = project.text.match(/^run\/main_scene\s*=\s*"([^"]+)"/m)?.[1];
    if (!main) add('NO_MAIN_SCENE', '游戏还没有设置启动入口', 'project.godot 中没有可识别的主场景配置。', '设置正确的主场景，并从正常启动入口运行验证。', [{ type: 'file', path: 'project.godot' }]);
    else if (main.startsWith('res://') && !snapshot.files.some(f => f.path === main.slice(6))) {
      add('MAIN_SCENE_NOT_FOUND', '启动场景未在本次扫描中找到', `配置引用 ${main}，请检查路径是否存在或是否超出扫描范围。`, '核实入口场景路径，修复失效引用，并从项目入口运行验证。', [{ type: 'reference', path: 'project.godot', target: main }], 'risk');
    }
  }
  const engine = skipEngineReason
    ? { status: 'not-checked', reason: `本次仅检查文件，未启动引擎：${skipEngineReason}`, checks: [] }
    : await checkEngine(enginePath, root, { runImport: runImport && Boolean(project), signal });
  const exportReadiness = await inspectExportReadiness(snapshot, enginePath, engine.version);
  if (engine.status !== 'available' && !skipEngineReason) add('ENGINE_UNAVAILABLE', '暂时无法做引擎运行检查', engine.reason, '先配置可用的 Godot 4 路径，再重新诊断；不要把未运行的检查标成通过。', [{ type: 'engine', status: engine.status }], 'confirmed', 'warning');
  for (const check of engine.checks) if (check.status !== 'passed') {
    const locations = check.locations.slice(0, 3).map(location => `${location.path}:${location.line}`).join('、');
    const explanation = locations
      ? `Godot 检查没有通过，日志指向 ${locations}。先检查这些位置，原始错误保留在“查看依据”中。`
      : 'Godot 检查没有完成或报告了错误。需要先核对运行环境和日志，目前不能确认工程可运行。';
    add('ENGINE_CHECK_FAILED', '引擎检查发现问题或未完成', explanation, '根据本次引擎日志定位问题，做最小修复后重新检查，保留已确认的玩法和数值。', [{ type: 'engine-log', check: check.name, status: check.status, errors: check.errors }, ...check.locations.map(location => ({ type: 'file', ...location }))]);
  }
  const after = await inspectProject(root);
  const changedDuringCheck = after.fingerprint !== snapshot.fingerprint;
  if (changedDuringCheck) add('PROJECT_CHANGED', '检查过程中项目内容发生了变化', '本次报告无法证明最新文件版本全部通过。', '读取最新变更后重新检查受影响部分。', [{ type: 'fingerprint', before: snapshot.fingerprint, after: after.fingerprint }], 'confirmed', 'warning');
  return {
    id: randomUUID(), at: now(), planHash: state.plan ? digest(state.plan) : null, workflowFingerprint: diagnosisContext(state), fingerprint: after.fingerprint,
    stale: changedDuringCheck || engineIdentity !== await identifyEngine(enginePath), issues, engine, engineIdentity, exportReadiness,
    producerFacts: { scopeItems: state.plan?.inScope.length ?? 0, tasks: { total: currentTasks.length, failed: failed.length, awaitingReview: currentTasks.filter(t => t.status === 'awaiting-review').length }, note: '任务统计不代表质量或整体完成度' },
    coverage: { fileScan: snapshot.complete ? 'complete' : 'partial', fileScanScope: '配置支持的文本及素材类型；排除缓存、隐藏目录、敏感文件名与常见疑似凭据内容；最多 1000 文件、总计 6 MB、单文件 1 MB', scannedFiles: snapshot.files.length, skipped: snapshot.skipped, engineImport: engine.checks[0]?.status ?? 'not-run', functionalInput: 'not-run', visualReview: 'not-run', humanPlaytest: 'not-run' },
    resources: { assetCount: resources.inventory.assets.length, scanComplete: resources.inventory.complete, parameterSource: resources.parameters.path ?? null, parameterIssues: resources.parameters.issues.length, note: resources.inventory.note },
    aiReview: { status: 'pending', instruction: '基于这些证据用简短中文解释问题与建议。证据以外的推断标为假设，不要把静态或导入检查说成完整功能、画面或试玩通过。' },
  };
}

const legacyModule = issue => issue?.module ?? (issue?.code?.startsWith('PLAN_') || issue?.code?.startsWith('TASK_') ? 'production' : issue?.code === 'PROJECT_CHANGED' ? 'verification' : undefined);
export function suggestionText(issue) {
  const discussion = ['design', 'production', 'verification'].includes(legacyModule(issue));
  const next = discussion ? '本次先讨论设计、计划或验证方案，给出可选路线、代价和推荐；不要据此直接改代码或代我确认方案。' : '修复后验证原问题及直接受影响的功能，说明实际变更与未验证项。';
  return `请处理项目诊断问题：${issue.title}\n\n已知情况：${issue.explanation}\n\n建议：${issue.suggestion}\n\n请先核实最新项目与证据，保持已确认的玩法和范围。${next}若需要改变设计或扩大范围，请先给方案让我确认。`;
}

export async function prepareSuggestion(root, state, reportId, issueId) {
  const report = state.diagnostics.find(r => r.id === reportId);
  const issue = report && [...report.issues, ...(report.aiReview.findings ?? [])].find(i => i.id === issueId);
  if (!issue) throw fault('UNKNOWN_ISSUE', '诊断问题不存在');
  const current = await inspectProject(root);
  if (report.stale || current.fingerprint !== report.fingerprint || report.workflowFingerprint !== diagnosisContext(state)) throw fault('STALE_DIAGNOSIS', '项目、方案确认或任务状态已变化，请重新诊断后发送建议');
  const module = legacyModule(issue) ?? legacyModule(report.issues.find(item => issue.evidenceIssueIds?.includes(item.id)));
  return { reportId, issueId, module, text: suggestionText({ ...issue, module }), idempotencyKey: `${reportId}:${issueId}` };
}
