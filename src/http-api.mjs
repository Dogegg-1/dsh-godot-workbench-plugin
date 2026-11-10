import { ProjectController, sameProject } from './project-controller.mjs';
import { openGodotEditor } from './editor-launch.mjs';
import { registerAndRecordGodotProject } from './godot-project-list.mjs';
import { EngineInstallJobs } from './engine-install-jobs.mjs';
import { inspectEngineInstallation } from './engine-install-inspect.mjs';
import { runtimeJobs } from './runtime-jobs.mjs';
import { buildJobs } from './build-jobs.mjs';
import { prepareProjectIntake, inspectProjectIntake } from './project-intake.mjs';

const methods = { temporaryFixes: 'temporaryFixes', temporaryFixChange: 'temporaryFixChange', resources: 'resources', parametersSave: 'parametersSave', assetInfo: 'assetInfo', assetImport: 'assetImport', status: 'status', draft: 'savePlan', confirm: 'confirmPlan', taskAdd: 'addTask', taskUpdate: 'updateTask', taskReview: 'reviewTask', taskRecover: 'recoverTask', fileChanges: 'fileChanges', fileRollback: 'fileRollback', recordRecoveryInspect: 'recordRecoveryInspect', recordRecoveryApply: 'recordRecoveryApply', diagnose: 'diagnose', knowledge: 'knowledge', knowledgeFeedback: 'knowledgeFeedback', engineReference: 'engineReference', context: 'context', suggestion: 'suggestion' };
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
Object.assign(methods, { fileRecoveryInspect: 'fileRecoveryInspect', fileRecoveryResolve: 'fileRecoveryResolve' });
Object.assign(methods, { developmentReports: 'developmentReports', developmentReportNote: 'developmentReportNote' });
Object.assign(methods, { projectLessons: 'projectLessons', projectLessonReview: 'projectLessonReview' });
Object.assign(methods, { lifecycleChange: 'lifecycleChange' });
Object.assign(methods, { qaRecord: 'qaRecord' });
Object.assign(methods, { projectLessonExport: 'projectLessonExport', projectLessonInspect: 'projectLessonInspect', projectLessonImport: 'projectLessonImport' });
const installers = new WeakMap();

// DSH supplies authentication/owner checks. Local preview supplies Host/Origin checks.
export function createWorkbenchHandler(config, controller = new ProjectController(config), installer) {
  if (installer) installers.set(controller, installer);
  else {
    installer = installers.get(controller);
    if (!installer) { installer = new EngineInstallJobs(); installers.set(controller, installer); }
  }
  return async request => {
    try {
      if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED', message: '请使用 POST' }, 405);
      if (request.headers.get('x-game-workbench') !== '1' || !request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'INVALID_REQUEST', message: '请求格式不正确' }, 400);
      const raw = await request.text();
      if (raw.length > 22500000) return json({ error: 'TOO_LARGE', message: '请求过长，请拆分内容' }, 413);
      const body = JSON.parse(raw);
      if (!body || (!Object.hasOwn(methods, body.action) && !['projectManage', 'projectPrepare', 'buildStart', 'buildStatus', 'buildCancel', 'buildEvidence', 'buildOpenFolder', 'runtimeImage', 'runtimeStart', 'runtimeStatus', 'runtimeCancel', 'runtimeEvidence', 'configuration', 'configure', 'editorOpen', 'projectRegister', 'engineOffer', 'engineInstallStart', 'engineInstallStatus', 'engineInstallCancel', 'engineInstallInspect'].includes(body.action))) return json({ error: 'UNKNOWN_ACTION', message: '未知工作台操作' }, 400);
      if (body.action !== 'assetImport' && raw.length > 128000) return json({ error: 'TOO_LARGE', message: '请求过长，请拆分内容' }, 413);
      const args = body.args ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) return json({ error: 'INVALID_ARGUMENTS', message: '参数必须是对象' }, 400);
      request.signal.throwIfAborted();
      let value;
      if (body.action === 'configuration') value = await controller.configuration();
      else if (body.action === 'projectPrepare') {
        const config = await controller.configuration();
        if (!sameProject(body.expectedProjectRoot, config.projectRoot)) {
          const intake = await inspectProjectIntake(controller.workbench);
          if (!intake || intake.requestId !== args.requestId || !sameProject(body.expectedProjectRoot, intake.originRoot)) return json({ error: 'PROJECT_CHANGED', message: '当前工程已变化，请刷新后再新建。' }, 400);
        }
        value = await prepareProjectIntake(controller, args);
      }
      else if (body.action === 'projectManage') value = await controller.manageProjects(args);
      else if (body.action === 'configure') value = await controller.configure({ ...args, signal: request.signal });
      else if (body.action === 'status') value = await controller.status();
      else if (body.action === 'qaRecord') value = await controller.use(wb=>wb.qaRecord(args,{localUser:true}),{expectedProjectRoot:body.expectedProjectRoot,requireBinding:true});
      else if (body.action === 'lifecycleChange') value = await controller.use(wb => wb.lifecycleChange(args, {
        localUser: true, resolveDelivery: id => buildJobs(controller).verifyDelivery(wb.root, id),
      }), { expectedProjectRoot: body.expectedProjectRoot, requireBinding: true });
      else if (body.action.startsWith('build')) value = await controller.use(wb => {
        const jobs = buildJobs(controller);
        if (body.action === 'buildStart') return jobs.start(wb, args);
        if (body.action === 'buildCancel') return jobs.cancel(wb.root, args.id);
        if (body.action === 'buildEvidence') return jobs.evidence(wb.root, args.id);
        if (body.action === 'buildOpenFolder') return jobs.openFolder(wb.root, args.id, { currentVersion: args.currentVersion === true });
        return jobs.status(wb.root, args.id);
      }, { expectedProjectRoot: body.expectedProjectRoot, requireBinding: true });
      else if (body.action.startsWith('runtime')) value = await controller.use(async wb => {
        const jobs = runtimeJobs(controller);
        await jobs.restore(wb.root);
        if (body.action === 'runtimeStart') return jobs.start(wb, args);
        if (body.action === 'runtimeCancel') return jobs.cancel(wb.root, args.id);
        if (body.action === 'runtimeEvidence') return jobs.currentEvidence(wb.root, args.id);
        if (body.action === 'runtimeImage') return jobs.image(wb.root, args.id, args.stepIndex);
        return jobs.status(wb.root, args.id);
      }, { expectedProjectRoot: body.expectedProjectRoot, requireBinding: true });
      else if (body.action.startsWith('engineInstall') || body.action === 'engineOffer') value = await controller.use(wb => {
        if (body.action === 'engineInstallInspect') return inspectEngineInstallation(args);
        if (body.action === 'engineOffer') return installer.offer(wb.root, args.version, request.signal);
        if (body.action === 'engineInstallStart') return installer.start(wb.root, args);
        if (body.action === 'engineInstallCancel') return installer.cancel(wb.root, args.id);
        return installer.status(wb.root, args.id);
      }, { expectedProjectRoot: body.expectedProjectRoot, requireBinding: true });
      else if (body.action === 'editorOpen') value = await controller.use(wb => openGodotEditor(wb, { signal: request.signal }), { expectedProjectRoot: body.expectedProjectRoot, requireBinding: true });
      else if (body.action === 'projectRegister') value = await controller.use(wb => registerAndRecordGodotProject(wb, { signal: request.signal }), { expectedProjectRoot: body.expectedProjectRoot, requireBinding: true });
      else if (body.action === 'recordRecoveryApply') value = await controller.recoverRecords(args, { expectedProjectRoot: body.expectedProjectRoot, requireBinding: Boolean(controller.settingsPath) });
      else value = await controller.use(wb => body.action === 'taskUpdate' ? wb.updateTask(args, { signal: request.signal, localUser: args.action === 'retry' }) : wb[methods[body.action]](['diagnose', 'engineReference', 'fileRollback', 'parametersSave', 'assetImport'].includes(body.action) ? { ...args, signal: request.signal } : args), { expectedProjectRoot: body.expectedProjectRoot, requireBinding: Boolean(controller.settingsPath) && body.action !== 'recordRecoveryInspect' });
      return json({ data: value, capabilities: { projectRoot: controller.workbench.root, engineConfigured: Boolean(controller.workbench.enginePath), chat: false } });
    } catch (error) {
      return json({ error: error.code ?? 'REQUEST_FAILED', message: error instanceof SyntaxError ? '无法读取请求内容' : error.message }, error.code === 'PROJECT_BUSY' ? 409 : 400);
    }
  };
}
