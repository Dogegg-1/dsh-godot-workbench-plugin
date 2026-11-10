import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.nlink !== 1) { skipped.push({ path: rel, reason: 'non-independent-file' }); continue; }
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

export async function checkGodot(executable, root, { signal, runImport = false, run = runProcess, isolateRuntime = false, isolatedFactory } = {}) {
  if (!executable) return { status: 'unavailable', reason: '尚未配置 Godot 可执行文件', checks: [] };
  if (!path.isAbsolute(executable)) throw fault('INVALID_ENGINE', 'Godot 路径必须为绝对路径');
  if (isolateRuntime) return checkIsolatedGodot(executable, root, { signal, runImport, isolatedFactory });
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

async function checkIsolatedGodot(executable, root, { signal, runImport, isolatedFactory }) {
  try {
    // Deferred imports avoid top-level initialization cycles: the runtime launcher
    // uses runProcess from this module. No ordinary runner is used in this branch.
    const createRunner = isolatedFactory ?? (await import('./windows-runtime-isolation.mjs')).createIsolatedRuntime;
    const { runtimeIssues } = await import('./runtime-observation.mjs');
    return await withImportCopy(root, async (game, layout) => {
      const run = await createRunner({ root: layout.root, engine: executable, signal });
      const probe = path.join(game, `dsh_version_${randomUUID().replaceAll('-', '')}`);
      await fs.mkdir(probe);
      await fs.writeFile(path.join(probe, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Version probe"\n', { flag: 'wx' });
      await fs.writeFile(path.join(probe, 'version.gd'), 'extends SceneTree\nfunc _init():\n\tprint("DSH_ENGINE_VERSION=" + str(Engine.get_version_info().string))\n\tquit()\n', { flag: 'wx' });
      // Separate empty project: original autoloads/tool scripts are never loaded
      // for version discovery. --version itself may not create a Godot log file.
      const versionResult = await run(executable, ['--headless', '--path', probe, '--script', 'res://version.gd'], { cwd: probe, signal, timeoutMs: 15000 });
      if (versionResult.sandbox !== 'windows-lpac') throw fault('RUNTIME_ISOLATION_UNAVAILABLE', '版本探针没有有效的 LPAC 收据，未执行工程检查');
      const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`;
      const banner = versionOutput.match(/^Godot Engine v(4\.\d+(?:\.\d+)?\.[\w.-]+)\b/m)?.[1];
      const marker = versionOutput.match(/^DSH_ENGINE_VERSION=(4\.\d+(?:\.\d+)?)[.-]([\w-]+)(?=[.\s]|$)/m);
      const version = marker && banner?.startsWith(`${marker[1]}.${marker[2]}.`) ? banner : null;
      const probeIssues = runtimeIssues(versionOutput, { isolateRuntime: true });
      if (!version || versionResult.exitCode !== 0 || versionResult.timedOut || versionResult.truncated || probeIssues.some(issue => issue.severity === 'error')) {
        return { status: 'failed', reason: '受限版本检查未完成，未执行工程导入，也未改用普通启动。', versionResult, checks: [], sandbox: 'windows-lpac' };
      }
      // Only the freshly generated probe directory is removed, never source files.
      await fs.rm(probe, { recursive: true, force: true });
      const checks = [];
      if (runImport) {
        await confined(game, 'project.godot');
        const result = await run(executable, ['--headless', '--path', game, '--editor', '--import'], { cwd: game, signal, timeoutMs: 45000 });
        if (result.sandbox !== 'windows-lpac') throw fault('RUNTIME_ISOLATION_UNAVAILABLE', '导入没有有效的 LPAC 收据，未认可检查结果');
        const output = `${result.stdout}\n${result.stderr}`;
        const issues = runtimeIssues(output, { isolateRuntime: true });
        // The existing parser only downgrades exact build-specific, bounded LPAC
        // messages. Unknown errors and standalone Parse Error lines remain failures.
        const lines = output.split(/\r?\n/);
        const errors = issues.filter(issue => issue.severity === 'error').flatMap(issue => [issue.message, ...issue.stack.map(line => line.trim())]);
        for (const line of lines) {
          if (/Parse Error/.test(line) && !errors.includes(line)) errors.push(line);
        }
        const locations = [...new Map(lines.flatMap(line => {
          const found = line.match(/\(res:\/\/(.+):(\d+)\)/);
          return found ? [[`${found[1]}:${found[2]}`, { path: found[1], line: Number(found[2]) }]] : [];
        })).values()];
        checks.push({ ...result, name: 'godot-import', status: result.timedOut ? 'timeout' : result.exitCode !== 0 || errors.length ? 'failed' : result.truncated ? 'incomplete' : 'passed', errors: errors.slice(0, 30), locations, issues });
      }
      return { status: 'available', version, checks, sandbox: 'windows-lpac' };
    }, { signal, isolatedLayout: true });
  } catch (error) {
    if (error.code === 'ABORTED' || signal?.aborted) throw error;
    return { status: 'unavailable', reason: `受限引擎检查无法执行，未改用普通启动：${error.message}`, checks: [], isolationRequested: true };
  }
}
