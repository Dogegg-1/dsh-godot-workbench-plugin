import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fault } from './storage.mjs';
import { checkGodot, runProcess } from './project.mjs';
import { fetchGodotDownloadOffer, downloadGodotPackage } from './engine-download.mjs';

// Only an explicit local UI action may call this; no model tool is registered.
export async function installGodotEngine({ offer, destination, confirmed = false }, { signal, onProgress = () => {}, fetchImpl = fetch } = {}) {
  if (confirmed !== true) throw fault('CONFIRM_REQUIRED', '请先确认版本、下载大小和安装目录');
  if (!offer?.version) throw fault('INVALID_RELEASE', '请先查询并选择官方版本');
  if (process.platform !== 'win32' || process.arch !== 'x64') throw fault('UNSUPPORTED_PLATFORM', '自动安装目前仅验证 Windows x64');
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || !destination.trim()) throw fault('INVALID_PATH', '安装目录需要完整路径');
  const parent = await fs.realpath(path.dirname(destination));
  destination = path.join(parent, path.basename(destination));
  const existing = await fs.lstat(destination).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (existing) throw fault('INSTALL_EXISTS', '安装目录已存在，请选择新的目录，不会覆盖已有引擎');
  onProgress({ phase: 'checking-release' });
  const current = await fetchGodotDownloadOffer({ version: offer?.version, signal, fetchImpl });
  if (!offer || current.sha256 !== offer.sha256 || current.bytes !== offer.bytes || current.url !== offer.url) throw fault('OFFER_CHANGED', '官方安装包信息已变化，请重新查看并确认');
  const staging = await fs.mkdtemp(path.join(parent, '.godot-install-'));
  let targetCreated = false;
  try {
    const cached = await downloadGodotPackage(current, staging, { confirmed, signal, onProgress, fetchImpl });
    const stem = `Godot_v${current.version}_win64`;
    onProgress({ phase: 'extracting' });
    const extracted = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./extract-godot.ps1', import.meta.url)), '-Archive', cached.filename, '-Destination', staging, '-Stem', stem], { cwd: staging, signal, timeoutMs: 60000 });
    if (extracted.exitCode !== 0 || extracted.timedOut) throw fault('EXTRACT_FAILED', '安装包解压未完成，尚未安装；请重试');
    signal?.throwIfAborted();
    const executable = `${stem}_console.exe`;
    onProgress({ phase: 'verifying-engine' });
    const checked = await checkGodot(path.join(staging, executable), staging, { signal });
    const expected = current.version.replace('-stable', '.stable');
    if (checked.status !== 'available' || !(checked.version === expected || checked.version.startsWith(expected + '.'))) throw fault('ENGINE_VERSION_MISMATCH', '解压后的引擎版本不匹配，未安装');
    signal?.throwIfAborted();
    // Reserve an absent target exclusively. Never replace a pre-existing directory.
    await fs.mkdir(destination); targetCreated = true;
    let copied = 0;
    onProgress({ phase: 'installing', copied, totalFiles: 2 });
    for (const filename of [`${stem}.exe`, executable]) {
      signal?.throwIfAborted();
      await fs.copyFile(path.join(staging, filename), path.join(destination, filename), constants.COPYFILE_EXCL);
      onProgress({ phase: 'installing', copied: ++copied, totalFiles: 2 });
    }
    signal?.throwIfAborted();
    await fs.writeFile(path.join(destination, '_sc_'), '', { flag: 'wx' });
    signal?.throwIfAborted();
    const receipt = { version: checked.version, package: current, installedAt: new Date().toISOString() };
    await fs.writeFile(path.join(destination, 'workbench-install.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    onProgress({ phase: 'installed' });
    return { status: 'installed', enginePath: path.join(destination, executable), version: checked.version, destination, message: 'Godot 已安装。确认项目设置后连接此引擎；尚未自动迁移工程。' };
  } catch (error) {
    if (targetCreated) error.message += `。未完成的安装目录已保留：${destination}；请核对后选择新目录重试，不会覆盖它。`;
    throw error;
  } finally {
    // staging was allocated directly under the resolved installation parent.
    if (path.dirname(staging) !== parent || !path.basename(staging).startsWith('.godot-install-')) throw fault('INVALID_PATH', '暂存目录边界不正确，已保留现场');
    await fs.rm(staging, { recursive: true, force: true });
  }
}
