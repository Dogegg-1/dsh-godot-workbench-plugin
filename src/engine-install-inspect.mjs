import { promises as fs } from 'node:fs';
import path from 'node:path';
import { confined, fault } from './storage.mjs';
import { godotDownloadOffer } from './engine-download.mjs';

// Read-only local UI inspection. A receipt is not executable-integrity proof;
// never run a file or call an old installation successful from this result.
export async function inspectEngineInstallation({ destination } = {}) {
  if (typeof destination !== 'string' || destination.length > 4096 || !path.isAbsolute(destination)) throw fault('INVALID_PATH', '请提供上次安装目录');
  const incomplete = message => ({ status: 'incomplete', destination, message });
  try {
    const directory = await fs.lstat(destination);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return incomplete('安装位置不是普通目录；未读取或运行其中内容。');
    const receiptPath = await confined(destination, 'workbench-install.json');
    const receiptStat = await fs.stat(receiptPath);
    if (!receiptStat.isFile() || receiptStat.size > 65536) return incomplete('安装收据格式不完整，请保留原文件。');
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    const item = receipt.package;
    const offer = godotDownloadOffer({ tag_name: item?.version, assets: [{ name: item?.name, size: item?.bytes, digest: `sha256:${item?.sha256}`, browser_download_url: item?.url }] });
    const expected = offer.version.replace('-stable', '.stable');
    if (typeof receipt.version !== 'string' || !(receipt.version === expected || receipt.version.startsWith(expected + '.'))) return incomplete('收据中的引擎版本与安装包不一致；尚未运行引擎。');
    const stem = `Godot_v${offer.version}_win64`;
    for (const name of [`${stem}.exe`, `${stem}_console.exe`, '_sc_']) {
      const file = await confined(destination, name); const stat = await fs.stat(file);
      if (!stat.isFile() || (name !== '_sc_' && (stat.size === 0 || stat.size > 300_000_000))) return incomplete('引擎文件缺失或不完整，请保留原目录，选择新位置重新安装。');
    }
    return { status: 'files-present', destination, version: receipt.version, enginePath: path.join(destination, `${stem}_console.exe`), message: '找到了安装收据和引擎文件，但尚未验证文件完整性或运行。可填入路径，保存设置时再检查引擎版本。' };
  } catch (error) {
    if (error.code === 'ENOENT') return incomplete('未找到完整的安装收据或引擎文件。原目录未改动，可选择新位置重新安装。');
    if (error instanceof SyntaxError || ['INVALID_RELEASE', 'INVALID_ASSET', 'MISSING_DIGEST', 'SYMLINK_PATH', 'OUTSIDE_PROJECT'].includes(error.code)) return incomplete('安装记录无法核实或路径包含链接。原文件已保留，没有运行引擎。');
    throw error;
  }
}
