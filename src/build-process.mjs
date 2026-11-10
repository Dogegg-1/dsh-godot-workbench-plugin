import { promises as fs } from 'node:fs';
import { runProcess } from './project.mjs';
import { runtimeIssues } from './runtime-observation.mjs';

// Collect file output before interpreting exit status. A failing process often
// leaves its most useful error only in this file, not in stdout or stderr.
export async function collectBuildProcess(executable, args, { cwd, timeoutMs, signal, logFile, run = runProcess, windowed = false } = {}) {
  const result = await run(executable, args, { cwd, timeoutMs, signal, windowed });
  if (logFile) {
    let handle;
    try {
      handle = await fs.open(logFile, 'r');
      const limit = 1_000_000;
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      result.fileLog = buffer.subarray(0, Math.min(length, limit)).toString('utf8');
      result.fileLogTruncated = length > limit;
    } catch (error) {
      result.fileLog = '';
      result.fileLogError = error.code ?? 'READ_FAILED';
    } finally { await handle?.close(); }
  }
  result.issues = runtimeIssues([result.stdout, result.stderr, result.fileLog].filter(Boolean).join('\n'), { isolateRuntime: result.sandbox === 'windows-lpac' });
  return result;
}
