import { promises as fs } from 'node:fs';
import path from 'node:path';

const marker = 'DSH Godot Workbench initial space v1\n';
async function verifySpace(root) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('工作台起始目录不是普通文件夹，请保留现场并检查安装。');
  const file = path.join(root, '.workbench-initial-space');
  if ((await fs.lstat(file)).isSymbolicLink() || await fs.readFile(file, 'utf8') !== marker) throw new Error('工作台起始目录已有其他内容，尚未接管。');
}

// Native bundle installation supplies no game config. Use the actual host profile,
// never process.cwd(), the daily home fallback, or another conversation's game.
export async function resolvePluginStartup(config = {}, { profileDir, settingsPath } = {}) {
  const explicit = { ...config, settingsPath: config.settingsPath ?? (settingsPath || undefined) };
  if (config.projectRoot) return explicit;
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir)) throw new Error('无法确定当前 DSH 配置目录，请从 DSH 插件页面启动工作台，或配置项目目录。');
  const profile = await fs.lstat(profileDir);
  if (!profile.isDirectory() || profile.isSymbolicLink()) throw new Error('DSH 配置目录不可用，未创建工作台起始空间。');
  const root = path.join(profileDir, 'game-workbench-start');
  const existing = await fs.lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) await verifySpace(root);
  else {
    const staged = await fs.mkdtemp(path.join(profileDir, '.workbench-start-'));
    await fs.writeFile(path.join(staged, '.workbench-initial-space'), marker, { flag: 'wx' });
    try { await fs.rename(staged, root); }
    catch (error) {
      // Another startup may have won publication; never merge with arbitrary data.
      await verifySpace(root).catch(() => { throw error; });
      await fs.unlink(path.join(staged, '.workbench-initial-space'));
      await fs.rmdir(staged);
    }
  }
  return { ...explicit, projectRoot: root, enginePath: config.enginePath ?? '', settingsPath: explicit.settingsPath ?? path.join(profileDir, 'game-workbench.settings.json') };
}
