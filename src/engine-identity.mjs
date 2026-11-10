import { promises as fs } from 'node:fs';
import { digest } from './storage.mjs';
export async function engineIdentity(enginePath) {
  if (!enginePath) return null;
  try { const stat=await fs.stat(enginePath);return digest({path:enginePath,size:stat.size,modified:stat.mtimeMs,changed:stat.ctimeMs}); }
  catch { return 'unavailable'; }
}
