import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { confined, fault } from './storage.mjs';
import { checkGodot } from './project.mjs';

// User action only. Starting an editor is not evidence of a working game.
export async function openGodotEditor({ root, enginePath }, { signal } = {}) {
  if (!enginePath) throw fault('ENGINE_MISSING', '尚未配置 Godot，请在“项目与引擎”中选择已有安装，或展开下载选项。');
  const project = await confined(root, 'project.godot').catch(error => {
    if (error.code === 'ENOENT') throw fault('PROJECT_MISSING', '这个目录还没有 project.godot，请先创建或导入 Godot 工程。');
    throw error;
  });
  if (!(await fs.stat(project)).isFile()) throw fault('PROJECT_MISSING', 'project.godot 必须是工程文件');
  const engine = await checkGodot(enginePath, root, { signal });
  if (engine.status !== 'available') throw fault('INVALID_ENGINE', engine.reason);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(enginePath, ['--editor', '--path', root], { cwd: root, shell: false, detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', error => reject(fault('EDITOR_START_FAILED', `编辑器未能启动：${error.code ?? error.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve({ status: 'started', pid: child.pid, projectRoot: root, engineVersion: engine.version, message: '已向 Godot 发出打开此工程的请求，请在编辑器窗口核对。此操作不代表游戏验证通过。' });
    });
  });
}
