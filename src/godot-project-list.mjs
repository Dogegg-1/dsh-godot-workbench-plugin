import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { confined, fault } from './storage.mjs';
import { checkGodot, runProcess } from './project.mjs';

export async function registerAndRecordGodotProject(workbench, options = {}) {
  let result;
  try { result = await registerGodotProject(workbench, options); }
  catch (error) { result = { status: 'failed', message: `启动器登记未完成：${error.message}` }; }
  const record = { ...result, enginePath: workbench.enginePath ?? '', checkedAt: new Date().toISOString() };
  await workbench.store.transaction(state => { state.projectManager = record; });
  return record;
}

export async function godotProjectListPath(enginePath, { platform = process.platform, appData = process.env.APPDATA } = {}) {
  if (platform !== 'win32') throw fault('UNSUPPORTED_PLATFORM', '项目管理器登记目前仅验证 Windows');
  const folder = path.dirname(await fs.realpath(enginePath));
  for (const marker of ['._sc_', '_sc_']) {
    const stat = await fs.stat(path.join(folder, marker)).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (stat?.isFile()) return path.join(folder, 'editor_data', 'projects.cfg');
  }
  if (!appData || !path.isAbsolute(appData)) throw fault('MISSING_APPDATA', '无法确定 Godot 用户数据目录');
  return path.join(appData, 'Godot', 'projects.cfg');
}

// ConfigFile parsing/serialization is performed by the selected engine itself.
// The workbench lock coordinates our writes; an external manager does not honor it.
export async function registerGodotProject({ root, enginePath, restrictedProduction }, { signal, run = runProcess, checkEngine = checkGodot } = {}) {
  if (restrictedProduction) return { status: 'unavailable', message: '工程已保留，受控制作配置暂不登记到启动器。' };
  if (!enginePath) return { status: 'unavailable', message: '工程已保留；选择 Godot 后可登记到项目管理器。' };
  const file = await confined(root, 'project.godot');
  if (!(await fs.stat(file)).isFile()) throw fault('PROJECT_MISSING', 'project.godot 必须是文件');
  const engine = await checkEngine(enginePath, root, { signal });
  if (engine.status !== 'available') throw fault('INVALID_ENGINE', engine.reason);
  const listPath = await godotProjectListPath(enginePath);
  const folder = path.dirname(listPath);
  await fs.mkdir(folder, { recursive: true });
  await confined(folder, 'projects.cfg', { mustExist: false });
  const lockPath = await confined(folder, 'projects.cfg.workbench.lock', { mustExist: false });
  let lock; let tempDir; let pending;
  try {
    try { lock = await fs.open(lockPath, 'wx'); } catch (e) { if (e.code === 'EEXIST') throw fault('REGISTRY_BUSY', '项目列表正在登记或遗留写锁，请核对后重试'); throw e; }
    const original = await fs.readFile(listPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (original?.length > 4_000_000) throw fault('REGISTRY_TOO_LARGE', '项目列表过大，尚未修改');
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'godot-register-'));
    await fs.writeFile(path.join(tempDir, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Workbench Registry Helper"\n');
    await fs.writeFile(path.join(tempDir, 'original.cfg'), original ?? '');
    await fs.copyFile(fileURLToPath(new URL('./godot-register.gd', import.meta.url)), path.join(tempDir, 'register.gd'));
    const output = path.join(tempDir, 'updated.cfg');
    const result = await run(enginePath, ['--headless', '--path', tempDir, '--script', path.join(tempDir, 'register.gd'), '--', path.join(tempDir, 'original.cfg'), output, (await fs.realpath(root)).replaceAll('\\', '/')], { cwd: tempDir, signal, timeoutMs: 15000 });
    if (result.exitCode !== 0 || result.timedOut || result.truncated || !result.stdout.includes('WORKBENCH_REGISTER_OK')) throw fault('REGISTRY_INVALID', 'Godot 未能校验项目列表；原列表未修改，请保留文件核查');
    signal?.throwIfAborted();
    const current = await fs.readFile(listPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if ((original === null) !== (current === null) || (original && !original.equals(current))) throw fault('REGISTRY_CHANGED', 'Godot 项目列表被其他窗口修改，请关闭项目管理器后重试');
    if (result.stdout.includes('WORKBENCH_ALREADY_PRESENT')) return { status: 'registered', listPath, message: '此工程已在 Godot 项目列表中。' };
    const updated = await fs.readFile(output);
    pending = await confined(folder, `projects.cfg.${randomUUID()}.tmp`, { mustExist: false });
    await fs.writeFile(pending, updated, { flag: 'wx' });
    signal?.throwIfAborted();
    const latest = await fs.readFile(listPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if ((original === null) !== (latest === null) || (original && !original.equals(latest))) throw fault('REGISTRY_CHANGED', 'Godot 项目列表被其他窗口修改，请关闭项目管理器后重试');
    let backup;
    if (original) {
      backup = path.join(folder, `projects.cfg.workbench-backup-${randomUUID()}`);
      await fs.writeFile(backup, original, { flag: 'wx' });
      await fs.rename(pending, listPath);
    } else {
      await fs.copyFile(pending, listPath, constants.COPYFILE_EXCL);
    }
    return { status: 'registered', listPath, backup, message: '已登记到 Godot 项目列表；若项目管理器已打开，请重新打开查看。' };
  } finally {
    if (pending) await fs.rm(pending, { force: true });
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    if (lock) { await lock.close(); await fs.rm(lockPath, { force: true }); }
  }
}
