import { promises as fs } from 'node:fs';
import path from 'node:path';
import { godotProjectListPath } from './godot-project-list.mjs';

// Presence checks only: does not parse presets, execute export or infer release quality.
export async function inspectExportReadiness(snapshot, enginePath, engineVersion, { platform = process.platform, appData = process.env.APPDATA } = {}) {
  const preset = snapshot.files.find(file => file.path === 'export_presets.cfg');
  const result = {
    presets: preset ? (preset.text?.trim() ? 'present-unverified' : 'empty') : snapshot.complete ? 'missing' : 'unverified',
    templates: 'unverified', templateDirectory: null, windowsTemplates: [], exportRun: 'not-run',
    note: '只检查配置与标准模板文件是否存在，不验证预设语法、目标平台、自定义模板、签名或安装包。没有模板不妨碍原型运行；正式发布需另做实际导出和独立运行验证。',
  };
  const version = engineVersion?.match(/^(4\.\d+(?:\.\d+)?)\.stable(?:\.|$)/)?.[1];
  if (!enginePath || !version || platform !== 'win32') return result;
  try {
    const config = await godotProjectListPath(enginePath, { platform, appData });
    result.templateDirectory = path.join(path.dirname(config), 'export_templates', `${version}.stable`);
    for (const name of ['windows_debug_x86_64.exe', 'windows_release_x86_64.exe']) {
      const stat = await fs.stat(path.join(result.templateDirectory, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      result.windowsTemplates.push({ name, status: stat?.isFile() && stat.size > 0 ? 'present-unverified' : 'missing' });
    }
    result.templates = result.windowsTemplates.every(item => item.status === 'present-unverified') ? 'present-unverified' : 'missing';
  } catch (error) { result.reason = `模板目录未能检查：${error.code ?? 'unknown'}`; }
  return result;
}
