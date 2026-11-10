import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './project.mjs';
import { fault, readRecord } from './storage.mjs';

const maxLogBytes = 1_000_000;

export async function createIsolatedRuntime({ root, engine, signal, executableName = 'godot.exe', companionFiles = [] }) {
  if (process.platform !== 'win32' || !process.env.SystemRoot) {
    throw fault('RUNTIME_ISOLATION_UNAVAILABLE', '此环境无法启动 Windows 受限运行，未启动游戏');
  }
  if (!/^[a-zA-Z0-9_-]+\.exe$/.test(executableName) || !Array.isArray(companionFiles)) throw fault('RUNTIME_ISOLATION_UNAVAILABLE', '无效的受限程序布局');
  const source = engine.replace(/_console\.exe$/i, '.exe');
  const engineDir = path.join(root, 'engine');
  const executable = path.join(engineDir, executableName);
  try {
    await fs.mkdir(engineDir);
    await fs.copyFile(source, executable, constants.COPYFILE_EXCL);
    const names = new Set([executableName.toLowerCase()]);
    for (const item of companionFiles) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(item.name) || item.name === '.' || item.name === '..' || names.has(item.name.toLowerCase())) throw new Error('Invalid companion name');
      names.add(item.name.toLowerCase());
      const stat = await fs.lstat(item.source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe companion');
      await fs.copyFile(item.source, path.join(engineDir, item.name), constants.COPYFILE_EXCL);
    }
  } catch {
    throw fault('RUNTIME_ISOLATION_UNAVAILABLE', '无法复制 Godot 主程序，请核对引擎目录，未启动游戏');
  }
  signal?.throwIfAborted();
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const launcher = fileURLToPath(new URL('./windows-lpac.ps1', import.meta.url));
  return async (_engine, args, { timeoutMs, signal: phaseSignal, windowed = false }) => {
    phaseSignal?.throwIfAborted();
    const id = randomUUID();
    const log = path.join('game', `engine-${id}.log`);
    const command = path.join(root, `command-${id}.json`);
    await fs.writeFile(command, JSON.stringify(['--log-file', path.join(root, log), ...args]), { flag: 'wx' });
    const launched = await runProcess(shell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher,
      '-Executable', executable, '-SandboxRoot', root, '-ArgumentsFile', command, '-TimeoutMs', String(timeoutMs),
      ...(windowed ? ['-WindowCompatible'] : []),
    ], { cwd: root, signal: phaseSignal, timeoutMs: timeoutMs + 45000, maxOutput: 32000 });
    let result;
    try { result = JSON.parse(launched.stdout.trim().split(/\r?\n/).at(-1)); } catch { /* No verified launcher receipt. */ }
    const expectedSandbox = windowed ? 'windows-appcontainer' : 'windows-lpac';
    if (launched.exitCode !== 0 || launched.timedOut || launched.truncated || result?.sandbox !== expectedSandbox
      || result.isAppContainer !== true || result.lpacRequested !== !windowed || result.capabilityCount !== 0 || result.cleaned !== true
      || !Number.isInteger(result.exitCode) || typeof result.timedOut !== 'boolean') {
      const detail = (launched.stderr || launched.stdout).trim().slice(0, 1000);
      throw fault('RUNTIME_ISOLATION_UNAVAILABLE', `受限运行启动或收尾失败，没有改用普通启动。${detail ? ' ' + detail : ''}`);
    }
    const { raw } = await readRecord(root, log, maxLogBytes);
    return { exitCode: result.exitCode, exitSignal: null, timedOut: result.timedOut, sandbox: result.sandbox,
      stdout: raw?.toString('utf8') ?? '', stderr: '', truncated: false };
  };
}
