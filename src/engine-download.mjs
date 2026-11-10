import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fault } from './storage.mjs';

const repository = 'https://github.com/godotengine/godot-builds';
const api = 'https://api.github.com/repos/godotengine/godot-builds/releases';
const maxPackage = 300_000_000;
async function officialFetch(url, options, fetchImpl) {
  try { return await fetchImpl(url, options); }
  catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    throw fault('NETWORK_ERROR', `无法连接官方发布服务（${error.cause?.code ?? error.code ?? '网络错误'}），请重试或选择已有引擎`);
  }
}
export function godotDownloadOffer(release) {
  const tag = release?.tag_name;
  if (!/^4\.\d+(?:\.\d+)?-stable$/.test(tag) || release.draft || release.prerelease) throw fault('INVALID_RELEASE', '只能安装 Godot 4 正式稳定版');
  const name = `Godot_v${tag}_win64.exe.zip`;
  const asset = release.assets?.find(item => item.name === name);
  const expectedUrl = `${repository}/releases/download/${tag}/${name}`;
  if (!asset || asset.browser_download_url !== expectedUrl || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maxPackage) throw fault('INVALID_ASSET', '官方版本缺少可用的 Windows x64 标准版安装包');
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw fault('MISSING_DIGEST', '此版本未提供可用 SHA-256，暂不自动安装，请选择其他版本或已有引擎');
  return { version: tag, platform: 'windows-x64', edition: 'standard', name, bytes: asset.size, sha256: asset.digest.slice(7), url: expectedUrl, releaseUrl: `${repository}/releases/tag/${tag}`, note: '标准版支持 GDScript；不包含 .NET/C# 或导出模板。' };
}

export async function fetchGodotDownloadOffer({ version = 'latest', signal, fetchImpl = fetch } = {}) {
  if (version !== 'latest' && !/^4\.\d+(?:\.\d+)?-stable$/.test(version)) throw fault('INVALID_RELEASE', '请输入稳定版本，例如 4.7.2-stable');
  const response = await officialFetch(`${api}/${version === 'latest' ? 'latest' : `tags/${version}`}`, { signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]), headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DSH-Godot-Workbench' }, redirect: 'error' }, fetchImpl);
  if (!response.ok) throw fault('RELEASE_UNAVAILABLE', `官方版本查询失败（HTTP ${response.status}），请稍后重试或选择已有安装`);
  const bytes = await readBounded(response, 2_000_000);
  const offer = godotDownloadOffer(JSON.parse(bytes.toString('utf8')));
  if (version !== 'latest' && offer.version !== version) throw fault('INVALID_RELEASE', '官方版本响应不匹配');
  return offer;
}

async function readBounded(response, maximum) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > maximum) throw fault('DOWNLOAD_TOO_LARGE', '响应超过允许大小'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

async function* readDownloadStream(response) {
  try {
    yield* response.body;
  } catch {
    throw fault('DOWNLOAD_INTERRUPTED', '下载连接中断，未安装；请检查网络后重试，或选择已有引擎');
  }
}

// Cache a verified package only. Installation is a separate step; never run a partial download.
export async function downloadGodotPackage(offer, directory, { confirmed = false, signal, onProgress = () => {}, fetchImpl = fetch, idleTimeoutMs = 60000, totalTimeoutMs = 3600000 } = {}) {
  if (confirmed !== true) throw fault('CONFIRM_REQUIRED', '请先确认版本、下载大小和安装目录');
  // Validate the entire offer again, even when supplied by our own UI.
  const checked = godotDownloadOffer({ tag_name: offer.version, assets: [{ name: offer.name, size: offer.bytes, digest: `sha256:${offer.sha256}`, browser_download_url: offer.url }] });
  if (!path.isAbsolute(directory)) throw fault('INVALID_PATH', '下载缓存需要绝对路径');
  if (![idleTimeoutMs, totalTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 3600000)) throw fault('INVALID_TIMEOUT', '下载超时配置无效');
  signal?.throwIfAborted();
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, `${randomUUID()}-${checked.name}`);
  const partial = filename + '.partial'; let handle;
  const timeout = new AbortController();
  const activeSignal = AbortSignal.any([timeout.signal, ...(signal ? [signal] : [])]);
  let idleTimer;
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => timeout.abort(fault('DOWNLOAD_STALLED', '下载长时间没有进度，已停止；请检查网络后重试')), idleTimeoutMs); idleTimer.unref?.(); };
  const totalTimer = setTimeout(() => timeout.abort(fault('DOWNLOAD_TIMEOUT', '下载已达到总时限，未安装；请检查网络后重试')), totalTimeoutMs); totalTimer.unref?.();
  resetIdle();
  try {
    const response = await officialFetch(checked.url, { signal: activeSignal, headers: { 'User-Agent': 'DSH-Godot-Workbench' } }, fetchImpl);
    if (!response.ok) throw fault('DOWNLOAD_FAILED', `下载失败（HTTP ${response.status}）`);
    const length = response.headers.get('content-length');
    if (length && Number(length) !== checked.bytes) throw fault('DOWNLOAD_SIZE_MISMATCH', '下载大小与官方记录不同，未安装');
    handle = await fs.open(partial, 'wx');
    const hash = createHash('sha256'); let downloaded = 0;
    onProgress({ phase: 'downloading', downloaded, total: checked.bytes });
    for await (const chunk of readDownloadStream(response)) {
      activeSignal.throwIfAborted();
      if (chunk.length) resetIdle();
      downloaded += chunk.length;
      if (downloaded > checked.bytes) throw fault('DOWNLOAD_SIZE_MISMATCH', '下载超过官方记录大小，未安装');
      hash.update(chunk); await handle.writeFile(chunk);
      onProgress({ phase: 'downloading', downloaded, total: checked.bytes });
    }
    activeSignal.throwIfAborted();
    if (downloaded !== checked.bytes || hash.digest('hex') !== checked.sha256) throw fault('CHECKSUM_MISMATCH', '下载文件校验不通过，未安装，请重试');
    await handle.sync(); await handle.close(); handle = null;
    await fs.rename(partial, filename);
    onProgress({ phase: 'verified', downloaded, total: checked.bytes });
    return { filename, offer: checked, verified: true };
  } catch (error) {
    if (activeSignal.aborted) throw activeSignal.reason;
    throw error;
  } finally {
    clearTimeout(idleTimer); clearTimeout(totalTimer);
    if (handle) await handle.close();
    await fs.rm(partial, { force: true });
  }
}
