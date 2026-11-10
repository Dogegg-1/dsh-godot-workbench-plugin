import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { confined, fault } from './storage.mjs';
import { Workbench } from './workbench.mjs';

const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
export function registeredProjects(selection) {
  return [selection, ...(selection.projects ?? []), ...selection.recentProjects].filter((p, i, all) => all.findIndex(other => key(other.projectRoot) === key(p.projectRoot)) === i).map(({ projectRoot, enginePath }) => ({ projectRoot, enginePath }));
}

// Local list management only: never delete directories, Godot registrations or sessions.
export async function manageProjectLibrary(controller, { action, projectRoot, order, expectedRevision }) {
  await controller.ready;
  if (!controller.settingsPath) throw fault('SETTINGS_UNAVAILABLE', '此工作台尚未启用项目列表管理');
  if (controller.active || controller.switching || controller.intakePreparing) throw fault('PROJECT_BUSY', '当前操作尚未结束，请稍后整理项目');
  if (!Number.isInteger(expectedRevision) || controller.selection.revision !== expectedRevision) throw fault('STALE_SETTINGS', '项目列表已变化，请刷新后重试');
  const registered = registeredProjects(controller.selection);
  const known = new Map(registered.map(p => [key(p.projectRoot), p]));
  let removed;
  if (action === 'remove') {
    if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) || !known.has(key(projectRoot))) throw fault('UNKNOWN_PROJECT', '项目已不在列表中');
    if (key(projectRoot) === key(controller.selection.projectRoot)) throw fault('CURRENT_PROJECT', '请先切换到其他项目，再移除此项目；工程文件会保留');
    removed = key(projectRoot);
  } else if (action === 'reorder') {
    if (!Array.isArray(order) || order.length !== known.size || order.some(p => typeof p !== 'string' || !path.isAbsolute(p) || !known.has(key(p))) || new Set(order.map(key)).size !== known.size) throw fault('INVALID_PROJECT_ORDER', '排序需要包含当前列表中的每个项目且不能重复，请刷新后重试');
  } else throw fault('INVALID_ACTION', '不支持的项目列表操作');
  controller.switching = true;
  let lock, lockPath, temporary;
  try {
    if (removed) {
      const state = await new Workbench({ projectRoot }).store.read();
      if (state.tasks.some(t => t.status === 'running')) throw fault('TASK_RUNNING', '此项目还有未结束的任务，请先在原对话核对');
    }
    const folder = path.dirname(controller.settingsPath);
    await fs.mkdir(folder, { recursive: true });
    const target = await confined(folder, path.basename(controller.settingsPath), { mustExist: false });
    lockPath = await confined(folder, path.basename(controller.settingsPath) + '.lock', { mustExist: false });
    try { lock = await fs.open(lockPath, 'wx'); } catch (e) { if (e.code === 'EEXIST') throw fault('SETTINGS_BUSY', '项目设置正在保存，请稍后重试'); throw e; }
    const stored = await fs.readFile(target, 'utf8').then(JSON.parse, e => { if (e.code === 'ENOENT') return { revision: 0 }; throw e; });
    if (stored.revision !== expectedRevision) throw fault('STALE_SETTINGS', '另一窗口已修改项目列表，请重新打开工作台');
    const previous = controller.selection;
    const next = { ...previous, revision: expectedRevision + 1,
      projects: registered.filter(p => key(p.projectRoot) !== removed),
      recentProjects: previous.recentProjects.filter(p => key(p.projectRoot) !== removed),
      projectOrder: action === 'reorder' ? order.map(p => known.get(key(p)).projectRoot) : (previous.projectOrder ?? []).filter(p => key(p) !== removed),
    };
    const serialized = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(serialized) > 65536) throw fault('SETTINGS_TOO_LARGE', '项目列表超过容量，尚未保存');
    temporary = await confined(folder, `${path.basename(target)}.${randomUUID()}.tmp`, { mustExist: false });
    await fs.writeFile(temporary, serialized, { flag: 'wx' });
    await fs.rename(temporary, target); temporary = null;
    controller.selection = next;
    return { revision: next.revision, message: action === 'remove' ? '已从列表移除。工程文件和对话保留，可重新导入。' : '项目顺序已保存。' };
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    if (lock) { await lock.close(); await fs.unlink(lockPath).catch(() => {}); }
    controller.switching = false;
  }
}
