import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { confined, fault } from './storage.mjs';
import { registerAndRecordGodotProject } from './godot-project-list.mjs';

const markerName = '.game-workbench/project-intake.json';
async function readJson(file) {
  if ((await fs.stat(file)).size > 65536) throw fault('INVALID_INTAKE', '项目准备记录过大，请保留后核查');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function writeMarker(root, value) {
  const target = await confined(root, markerName, { mustExist: false });
  const temporary = await confined(root, `${markerName}.${randomUUID()}.tmp`, { mustExist: false });
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' }); await fs.rename(temporary, target);
}
export async function inspectProjectIntake(wb) {
  try {
    const value = await readJson(await confined(wb.root, markerName));
    if (value.version !== 1 || value.projectRoot !== await fs.realpath(wb.root) || !['prepared', 'creating', 'created'].includes(value.status)) throw fault('INVALID_INTAKE', '项目准备记录与当前工程不一致');
    // Creation marker records the original attempt. Later registration retries
    // are authoritative in project state; don't replay the stale failure.
    if (value.status === 'created' && wb.store) {
      const state = await wb.store.read();
      if (state.projectManager) return { ...value, projectManager: state.projectManager };
    }
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// User-only operation. Reserve the new directory before binding its fresh session.
export async function prepareProjectIntake(controller, { requestId, expectedRevision, parentDirectory } = {}, { defaultParent = path.join(os.homedir(), 'Godot Projects') } = {}) {
  await controller.ready;
  if (!controller.settingsPath) throw fault('SETTINGS_UNAVAILABLE', '当前加载方式未启用项目创建，请在 DSH 工作台中操作');
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) throw fault('INVALID_REQUEST', '新建请求标识无效');
  if (controller.intakePreparing) throw fault('PROJECT_BUSY', '正在准备新项目，请等待原请求');
  controller.intakePreparing = true;
  try {
    const config = await controller.configuration();
    const registry = path.join(path.dirname(controller.settingsPath), 'project-intakes'); await fs.mkdir(registry, { recursive: true });
    const recordFile = await confined(registry, `${requestId}.json`, { mustExist: false });
    let record = await readJson(recordFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (record && (record.version !== 1 || record.requestId !== requestId || typeof record.projectRoot !== 'string' || !path.isAbsolute(record.projectRoot))) throw fault('INVALID_INTAKE', '新建请求记录异常，请保留后核查');
    if (record && record.parentRequest !== (parentDirectory ?? null)) throw fault('REQUEST_CONFLICT', '同一新建请求的保存位置已改变');
    if (record && path.resolve(config.projectRoot) === path.resolve(record.projectRoot)) return { ...await controller.workbench.status(), configuration: config, intake: await inspectProjectIntake(controller.workbench) };
    if (config.revision !== expectedRevision) throw fault('STALE_SETTINGS', '工程选择已变化，请刷新后再新建');
    if (config.activeOperations || config.switching) throw fault('PROJECT_BUSY', '请先结束当前工程操作，再准备新项目');
    if (!record) {
      if (parentDirectory !== undefined && (typeof parentDirectory !== 'string' || !path.isAbsolute(parentDirectory))) throw fault('INVALID_PATH', '可选保存位置需要已有目录的完整路径');
      if (!parentDirectory) await fs.mkdir(defaultParent, { recursive: true });
      let parent;
      try {
        parent = await fs.realpath(parentDirectory ?? defaultParent);
        if (!(await fs.stat(parent)).isDirectory()) throw fault('INVALID_PARENT_DIRECTORY', '保存位置不是文件夹，请选择已有文件夹。');
      } catch (error) {
        // This code is reserved for validation before the request record exists.
        // Later ENOENT errors may follow creation and must retain request identity.
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw fault('INVALID_PARENT_DIRECTORY', '保存文件夹不存在，请检查位置或选择已有文件夹。');
        throw error;
      }
      const projectRoot = path.join(parent, `新游戏-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${requestId.slice(-8)}`);
      record = { version: 1, projectRoot, originRoot: config.projectRoot, parentRequest: parentDirectory ?? null, requestId };
      await fs.writeFile(recordFile, JSON.stringify(record), { flag: 'wx' });
    }
    try {
      await fs.mkdir(record.projectRoot);
      await fs.mkdir(path.join(record.projectRoot, '.game-workbench'));
      await writeMarker(record.projectRoot, { version: 1, projectRoot: await fs.realpath(record.projectRoot), originRoot: record.originRoot, status: 'prepared', requestId, createdAt: new Date().toISOString() });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const marker = await inspectProjectIntake({ root: record.projectRoot });
      if (!marker || marker.requestId !== requestId) throw fault('PROJECT_EXISTS', '目标目录已存在且不是本次准备目录，未覆盖任何文件');
    }
    const next = await controller.configure({ projectRoot: record.projectRoot, enginePath: config.enginePath, expectedRevision, mode: 'connect' }, { newIntake: true });
    return { ...next, intake: await inspectProjectIntake(controller.workbench) };
  } finally { controller.intakePreparing = false; }
}

// The agent can create only inside a directory explicitly prepared by the user action.
export async function createIntakeGodotProject(wb, { title } = {}, { register = registerAndRecordGodotProject } = {}) {
  if (typeof title !== 'string' || !title.trim() || title.length > 120 || /[\x00-\x1f]/.test(title)) throw fault('INVALID_TITLE', '请先确认 1–120 字的项目名称');
  title = title.trim();
  const marker = await inspectProjectIntake(wb);
  if (!marker) throw fault('INTAKE_REQUIRED', '当前不是新项目准备目录，请使用“让 AI 帮我新建”入口，不能在旧项目创建');
  const lockPath = await confined(wb.root, '.game-workbench/project-intake.lock', { mustExist: false });
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); } catch (error) { if (error.code === 'EEXIST') throw fault('INTAKE_BUSY', '该项目正在创建或上次创建中断，请核对准备记录'); throw error; }
  try {
    const current = await inspectProjectIntake(wb);
    if (current.title && current.title !== title) throw fault('INTAKE_TITLE_CHANGED', '本次工程已经按另一个名称创建，不会覆盖；更名应作为后续明确操作');
    const content = `; Created from a dedicated DSH project preparation conversation.\nconfig_version=5\n\n[application]\nconfig/name=${JSON.stringify(title)}\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n`;
    const projectFile = await confined(wb.root, 'project.godot', { mustExist: false });
    const existing = await fs.readFile(projectFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing !== null) {
      if (!['creating', 'created'].includes(current.status) || current.content !== existing) throw fault('PROJECT_EXISTS', '目录已有工程或工程被修改，未覆盖任何内容');
      if (current.status === 'created') return { projectRoot: wb.root, title, created: true, projectManager: current.projectManager, gameplayImplemented: false };
    } else {
      if (current.status === 'created') throw fault('PROJECT_MISSING', '已创建的工程文件丢失，请先核对，不自动重建');
      await writeMarker(wb.root, { ...current, status: 'creating', title, content });
      await fs.writeFile(projectFile, content, { flag: 'wx' });
    }
    let projectManager;
    try { projectManager = await register(wb); } catch (error) { projectManager = { status: 'failed', message: error.message }; }
    await writeMarker(wb.root, { ...current, status: 'created', title, content, projectManager });
    return { projectRoot: wb.root, title, created: true, projectManager, gameplayImplemented: false, next: '工程已准备好。继续讨论玩法与范围，方案确认后再制作。' };
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
