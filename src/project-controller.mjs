import { manageProjectLibrary } from './project-library.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workbench } from './workbench.mjs';
import { confined, fault, event } from './storage.mjs';
import { checkGodot } from './project.mjs';
import { registerAndRecordGodotProject } from './godot-project-list.mjs';
import { projectDisplayName } from './project-display-name.mjs';

const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
export const sameProject = (a, b) => typeof a === 'string' && typeof b === 'string' && normalize(a) === normalize(b);
const validPath = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim()) || value.length > 4096) throw fault('INVALID_PATH', `${label}需要完整的绝对路径`);
  return path.resolve(value.trim());
};

// One controller owns the selected project for this DSH profile. Switching is a
// local user action, never a model tool; executions keep a lease on their target.
export class ProjectController {
  constructor(config) {
    this.settingsPath = config.settingsPath ? validPath(config.settingsPath, '工作台设置文件') : null;
    this.selection = { schemaVersion: 1, revision: 0, projectRoot: validPath(config.projectRoot, '项目目录'), enginePath: config.enginePath ?? '', recentProjects: [], projects: [] };
    this.workbench = new Workbench(this.selection);
    this.active = 0; this.switching = false;
    this.ready = this.load();
    this.ready.catch(() => {}); // Surface a load error through the API, not an unhandled rejection.
    this.contextView = new Proxy({}, { get: (_target, property) => {
      if (property === 'root') return this.workbench.root;
      if (property === 'store') return this.workbench.store;
      return (...args) => this.use(wb => wb[property](...args));
    } });
  }
  async load() {
    if (!this.settingsPath) return;
    try {
      const file = await confined(path.dirname(this.settingsPath), path.basename(this.settingsPath));
      if ((await fs.stat(file)).size > 65536) throw fault('INVALID_SETTINGS', '工作台设置文件过大，请保留原文件后修复');
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      if (state.schemaVersion !== 1 || !Number.isInteger(state.revision) || state.revision < 0 || !Array.isArray(state.recentProjects)) throw fault('INVALID_SETTINGS', '工作台设置格式不正确，请保留原文件后修复');
      validPath(state.projectRoot, '保存的项目目录');
      if (state.enginePath) validPath(state.enginePath, '保存的引擎路径');
      for (const entry of state.recentProjects) { validPath(entry.projectRoot, '最近工程'); if (entry.enginePath) validPath(entry.enginePath, '最近工程引擎'); }
      if (state.projects !== undefined && !Array.isArray(state.projects)) throw fault('INVALID_SETTINGS', '项目登记列表格式不正确');
      for (const entry of state.projects ?? []) { validPath(entry.projectRoot, '登记工程'); if (entry.enginePath) validPath(entry.enginePath, '登记工程引擎'); }
      if (state.projectOrder !== undefined && (!Array.isArray(state.projectOrder) || state.projectOrder.some(p => typeof p !== 'string' || !path.isAbsolute(p)))) throw fault('INVALID_SETTINGS', '项目排序格式不正确');
      state.projects ??= state.recentProjects;
      this.selection = state;
      this.workbench = new Workbench(state);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async configuration() {
    await this.ready;
    const selection = this.selection;
    const names = new Map();
    const named = async entry => {
      const key = normalize(entry.projectRoot);
      if (!names.has(key)) names.set(key, projectDisplayName(entry.projectRoot));
      return { ...entry, title: await names.get(key) };
    };
    const [current, projects, recentProjects] = await Promise.all([
      named(selection), Promise.all(selection.projects.map(named)), Promise.all(selection.recentProjects.map(named)),
    ]);
    return { ...current, projects, recentProjects, configurable: Boolean(this.settingsPath), activeOperations: this.active, switching: this.switching };
  }
  async use(action, { expectedProjectRoot, requireBinding = false, directory } = {}) {
    await this.ready;
    if (this.switching || this.intakePreparing) throw fault('PROJECT_BUSY', '正在准备或切换工程，请稍后重试');
    if ((requireBinding || expectedProjectRoot !== undefined) && !sameProject(expectedProjectRoot, this.workbench.root)) throw fault('PROJECT_CHANGED', '当前工程已经改变。请刷新页面后再操作，尚未写入其他工程。');
    if (directory !== undefined && !sameProject(directory, this.workbench.root)) throw fault('SESSION_PROJECT_MISMATCH', '当前会话目录与工作台工程不一致。请切换到对应工程的会话后继续。');
    this.active++;
    const workbench = this.workbench;
    try { return await action(workbench); } finally { this.active--; }
  }
  async status() {
    return this.use(async wb => ({ ...await wb.status(), configuration: await this.configuration() }));
  }
  async recoverRecords(args, { expectedProjectRoot, requireBinding = false } = {}) {
    await this.ready;
    if (this.active || this.switching) throw fault('PROJECT_BUSY', '当前工作台操作尚未结束，请稍后恢复记录');
    if ((requireBinding || expectedProjectRoot !== undefined) && !sameProject(expectedProjectRoot, this.workbench.root)) throw fault('PROJECT_CHANGED', '工程已改变，请重新查看恢复预览');
    this.switching = true;
    try { return await this.workbench.recordRecoveryApply(args); }
    finally { this.switching = false; }
  }
  async manageProjects(args) { return manageProjectLibrary(this, args); }
  async configure({ projectRoot, enginePath = '', expectedRevision, signal, mode = 'connect', title = '' } = {}) {
    await this.ready;
    if (!this.settingsPath) throw fault('SETTINGS_UNAVAILABLE', '当前加载方式没有启用项目配置，请使用工作台 profile');
    if (!Number.isInteger(expectedRevision) || expectedRevision !== this.selection.revision) throw fault('STALE_SETTINGS', '设置已变化，请重新打开项目设置再保存');
    if (this.active || this.switching) throw fault('PROJECT_BUSY', '当前检查或工作台操作尚未结束，请稍后切换工程');
    projectRoot = validPath(projectRoot, '项目目录');
    if (!['connect', 'create', 'import'].includes(mode)) throw fault('INVALID_MODE', '未知工程操作');
    if (mode === 'create' && (typeof title !== 'string' || !title.trim() || title.length > 120 || /[\x00-\x1f]/.test(title))) throw fault('INVALID_TITLE', '请输入 1—120 字的项目名称，不含控制字符');
    if (typeof enginePath !== 'string') throw fault('INVALID_PATH', '引擎路径需要文字');
    enginePath = enginePath.trim() ? validPath(enginePath, 'Godot 路径') : '';
    this.switching = true;
    let lock; let lockPath; let temporary; let created = false;
    try {
      signal?.throwIfAborted();
      let oldState;
      try { oldState = await this.workbench.store.read(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (oldState?.tasks.some(task => task.status === 'running')) throw fault('TASK_RUNNING', '当前工程还有执行中的任务，请先停止执行并记录结果，再切换设置');
      if (mode === 'create') {
        const parent = await fs.realpath(path.dirname(projectRoot)).catch(error => { if (error.code === 'ENOENT') throw fault('PROJECT_NOT_FOUND', '上级目录不存在，请先选择已有的存放目录'); throw error; });
        projectRoot = path.join(parent, path.basename(projectRoot));
        const existing = await fs.lstat(projectRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (existing) throw fault('PROJECT_EXISTS', '目标目录已经存在。新建需使用新的文件夹路径；已有工程请选择导入。');
      } else {
        const rootStat = await fs.stat(projectRoot).catch(error => { if (error.code === 'ENOENT') throw fault('PROJECT_NOT_FOUND', '项目目录不存在，请选择已有的游戏目录或空文件夹'); throw error; });
        if (!rootStat.isDirectory()) throw fault('INVALID_PATH', '请选择项目文件夹，而不是 project.godot 文件');
        projectRoot = await fs.realpath(projectRoot);
        if (mode === 'import') {
          const file = await confined(projectRoot, 'project.godot').catch(error => { if (error.code === 'ENOENT') throw fault('PROJECT_MISSING', '该目录没有 project.godot，不能作为已有 Godot 工程导入'); throw error; });
          if (!(await fs.stat(file)).isFile()) throw fault('PROJECT_MISSING', 'project.godot 必须是文件');
        }
      }
      let engine = { status: 'unavailable', reason: '未配置引擎，可以先整理方案' };
      if (enginePath) {
        engine = await checkGodot(enginePath, mode === 'create' ? path.dirname(projectRoot) : projectRoot, { signal });
        if (engine.status !== 'available') throw fault('INVALID_ENGINE', `Godot 路径未通过验证：${engine.reason}`);
      }
      signal?.throwIfAborted();
      const folder = path.dirname(this.settingsPath);
      await fs.mkdir(folder, { recursive: true });
      const target = await confined(folder, path.basename(this.settingsPath), { mustExist: false });
      lockPath = await confined(folder, path.basename(this.settingsPath) + '.lock', { mustExist: false });
      try { lock = await fs.open(lockPath, 'wx'); }
      catch (error) { if (error.code === 'EEXIST') throw fault('SETTINGS_BUSY', '设置正在保存或上次保存中断，请核对后重试'); throw error; }
      const persisted = await fs.readFile(target, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return { revision: 0 }; throw error; });
      if (persisted.revision !== expectedRevision) throw fault('STALE_SETTINGS', '另一窗口已保存设置，请重新打开工作台后再修改');
      if (mode === 'create') {
        signal?.throwIfAborted();
        // Exclusive directory creation prevents overwriting a concurrently created project.
        await fs.mkdir(projectRoot);
        created = true;
        const name = JSON.stringify(title.trim());
        await fs.writeFile(await confined(projectRoot, 'project.godot', { mustExist: false }), `; Created by DSH Godot Workbench. Gameplay is not implemented yet.\nconfig_version=5\n\n[application]\nconfig/name=${name}\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n`, { flag: 'wx' });
      }
      const next = new Workbench({ projectRoot, enginePath });
      const nextState = await next.store.read();
      if (nextState.tasks.some(task => task.status === 'running') && !sameProject(projectRoot, this.workbench.root)) throw fault('TASK_RUNNING', '目标工程有执行中或中断待核查的任务，请先在原会话核对');
      await next.initialize();
      // Reopening an engineering environment requires fresh diagnosis, even if
      // the source files stayed unchanged. Preserve the old report as history.
      await next.store.transaction(state => {
        for (const report of state.diagnostics) report.stale = true;
        event(state, 'project-configured', { enginePath, engineVersion: engine.version ?? null });
      });
      const recentProjects = [{ projectRoot, enginePath }, ...this.selection.recentProjects, { projectRoot: this.selection.projectRoot, enginePath: this.selection.enginePath }].filter((entry, index, all) => all.findIndex(other => sameProject(entry.projectRoot, other.projectRoot)) === index).slice(0, 8);
      // The registry must not evict projects when the short recents list rotates.
      const projects = [...(this.selection.projects ?? []), ...this.selection.recentProjects, { projectRoot: this.selection.projectRoot, enginePath: this.selection.enginePath }, { projectRoot, enginePath }]
        .filter((entry, index, all) => all.findIndex(other => sameProject(entry.projectRoot, other.projectRoot)) === index)
        .map(entry => sameProject(entry.projectRoot, projectRoot) ? { ...entry, projectRoot, enginePath } : entry);
      const selection = { ...this.selection, schemaVersion: 1, revision: expectedRevision + 1, projectRoot, enginePath, engineVersion: engine.version ?? null, recentProjects, projects };
      const serializedSelection = JSON.stringify(selection, null, 2);
      if (Buffer.byteLength(serializedSelection) > 65536) throw fault('SETTINGS_TOO_LARGE', '项目登记已超过设置容量；本次切换尚未保存，请整理项目记录后重试');
      temporary = await confined(folder, `${path.basename(this.settingsPath)}.${randomUUID()}.tmp`, { mustExist: false });
      await fs.writeFile(temporary, serializedSelection, { flag: 'wx' });
      signal?.throwIfAborted();
      await fs.rename(temporary, target);
      this.selection = selection; this.workbench = next;
      let projectManager;
      if (mode === 'create' || mode === 'import') {
        try { projectManager = await registerAndRecordGodotProject(next, { signal }); }
        catch (error) { projectManager = { status: 'failed', message: `工程已连接，但启动器登记未完成：${error.message}` }; }
      }
      return { ...await next.status(), projectManager, configuration: { ...await this.configuration(), activeOperations: 0, switching: false } };
    } catch (error) {
      if (created) error.message += `。新建目录已保留：${projectRoot}；请核对文件后通过“连接已有目录”重试，尚未自动删除任何内容。`;
      throw error;
    } finally {
      try {
        if (lock) { await lock.close(); await fs.rm(lockPath, { force: true }); }
        if (temporary) await fs.rm(temporary, { force: true });
      } finally { this.switching = false; }
    }
  }
}
