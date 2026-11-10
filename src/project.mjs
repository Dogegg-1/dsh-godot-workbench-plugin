import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { confined, digest, fault } from './storage.mjs';
import { withImportCopy } from './import-copy.mjs';

const excluded = new Set(['.git', '.godot', '.game-workbench', 'node_modules', '.env', 'logs', 'tmp', 'export', 'build']);
const textExtensions = new Set(['.gd', '.cs', '.tscn', '.tres', '.godot', '.md', '.cfg', '.json', '.csv', '.gdshader', '.uid']);
const assetExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ogg', '.wav', '.ttf', '.glb']);
const gameSourceExtensions = new Set(['.gd', '.cs', '.tscn', '.tres', '.gdshader']);
const credentialContent = /\b(?:sk|gh[pousr]|github_pat)[_-][\w-]{8,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bBearer\s+[\w.~+/-]{8,}|\b(?:api[_-]?key|(?:(?:access|refresh|auth|api|session)[_-]?)?token|(?:(?:api|client)[_-]?)?secret|password)\b["']?\s*(?::\s*(?:String|string)\s*)?(?:=|:)\s*["'][^"'\r\n]+["']/i;
export async function inspectProject(root, { maxFiles = 1000, maxBytes = 6_000_000 } = {}) {
  const files = []; const skipped = []; let bytes = 0; let limited = false;
  async function walk(relative) {
    const dir = await confined(root, relative);
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (excluded.has(entry.name) || entry.name.startsWith('.')) continue;
      const rel = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
      const ext = path.extname(entry.name).toLowerCase();
      // token/secret are also gameplay terms. Only relax those ambiguous names
      // for engine source files; explicit credential names and directories stay
      // excluded. Content screening below is heuristic, not a secrecy guarantee.
      const explicitCredential = /credential|password|(?:access|refresh|auth|api|session)[_. -]?token|(?:api|client)[_. -]?secret/i.test(entry.name);
      if (explicitCredential || (/secret|token/i.test(entry.name) && !(entry.isFile() && gameSourceExtensions.has(ext)))) { skipped.push({ path: rel, reason: 'sensitive-name-filter' }); continue; }
      if (entry.isSymbolicLink()) { skipped.push({ path: rel, reason: 'symbolic-link' }); continue; }
      if (files.length >= maxFiles || bytes >= maxBytes) { limited = true; break; }
      if (entry.isDirectory()) { await walk(rel); continue; }
      if (!textExtensions.has(ext) && !assetExtensions.has(ext)) continue;
      const file = await confined(root, rel);
      const stat = await fs.stat(file);
      if (stat.size > 1_000_000 || bytes + stat.size > maxBytes) { skipped.push({ path: rel, reason: 'size-limit' }); limited = true; continue; }
      const data = await fs.readFile(file);
      bytes += data.length;
      const text = textExtensions.has(ext) ? data.toString('utf8') : undefined;
      if (text !== undefined && credentialContent.test(text)) { skipped.push({ path: rel, reason: 'credential-content-filter' }); continue; }
      files.push({ path: rel, bytes: data.length, hash: digest(data.toString('base64')), text });
    }
  }
  await walk('');
  return { files, fingerprint: digest(files.map(({ path, hash }) => ({ path, hash }))), complete: !limited && skipped.length === 0, skipped, bytes };
}

export function runProcess(executable, args, { cwd, signal, timeoutMs = 30000, maxOutput = 1_000_000 } = {}) {
  if (signal?.aborted) return Promise.reject(fault('ABORTED', '已取消'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // Decode across chunk boundaries, not each Buffer independently: a UTF-8
    // path or diagnostic character may arrive in several writes.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', truncated = false, ended = false, timedOut = false, aborted = false;
    const append = (kind, data) => {
      const text = data.toString();
      const room = Math.max(0, maxOutput - stdout.length - stderr.length);
      if (text.length > room) truncated = true;
      if (kind === 'stdout') stdout += text.slice(0, room); else stderr += text.slice(0, room);
    };
    child.stdout.on('data', data => append('stdout', data));
    child.stderr.on('data', data => append('stderr', data));
    const cancel = () => { aborted = true; child.kill(); };
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    child.on('error', error => { if (!ended) { ended = true; cleanup(); reject(error); } });
    child.on('close', (exitCode, exitSignal) => {
      if (ended) return; ended = true; cleanup();
      if (aborted) reject(fault('ABORTED', '已取消本次引擎进程'));
      else resolve({ exitCode, exitSignal, stdout, stderr, truncated, timedOut });
    });
  });
}

export async function checkGodot(executable, root, { signal, runImport = false, run = runProcess } = {}) {
  if (!executable) return { status: 'unavailable', reason: '尚未配置 Godot 可执行文件', checks: [] };
  if (!path.isAbsolute(executable)) throw fault('INVALID_ENGINE', 'Godot 路径必须为绝对路径');
  let version;
  try { version = await run(executable, ['--version'], { cwd: root, signal, timeoutMs: 10000 }); }
  catch (error) {
    if (error.code === 'ABORTED') throw error;
    return { status: 'unavailable', reason: `无法启动配置的 Godot：${error.code ?? error.message}`, checks: [] };
  }
  const match = `${version.stdout}\n${version.stderr}`.match(/\b4\.\d+(?:\.\d+)?\.[\w.-]+/);
  if (!match || version.exitCode !== 0 || version.timedOut) return { status: 'failed', reason: `Godot 版本检查未完成（退出码 ${version.exitCode ?? '无'}${version.timedOut ? '，已超时' : ''}）。本次没有执行工程检查；Windows 自动化可配置 console 入口后重试。`, versionResult: version, checks: [] };
  const checks = [];
  if (runImport) {
    await confined(root, 'project.godot');
    const result = await withImportCopy(root, copy => run(executable, ['--headless', '--path', copy, '--editor', '--import'], { cwd: copy, signal, timeoutMs: 45000 }), { signal });
    const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/);
    const errors = lines.flatMap((line, index) => /(?:SCRIPT ERROR|Parse Error|^ERROR:)/.test(line) ? [line, ...(lines[index + 1]?.trim().startsWith('at:') ? [lines[index + 1].trim()] : [])] : []);
    const locations = [...new Map(lines.flatMap(line => {
      const match = line.match(/\(res:\/\/(.+):(\d+)\)/);
      return match ? [[`${match[1]}:${match[2]}`, { path: match[1], line: Number(match[2]) }]] : [];
    })).values()];
    checks.push({ name: 'godot-import', status: result.timedOut ? 'timeout' : result.exitCode !== 0 || errors.length ? 'failed' : result.truncated ? 'incomplete' : 'passed', errors: errors.slice(0, 30), locations, ...result });
  }
  return { status: 'available', version: match[0], checks };
}
