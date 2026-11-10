import { promises as fs } from 'node:fs';
import { confined } from './storage.mjs';
import { runtimeSourceManifest } from './runtime-observation.mjs';

// Read existing observations only; diagnosis must never silently launch a game.
export async function runtimeHealth(root, enginePath) {
  const result = { failures: [], complete: true };
  if (!enginePath) return result;
  let names;
  try { names = await fs.readdir(await confined(root, '.game-workbench/runtime-history')); }
  catch (error) { if (error.code === 'ENOENT') return result; return { ...result, complete: false }; }
  names = names.filter(name => /^[\w-]+\.json$/.test(name));
  if (!names.length) return result;
  if (names.length > 100) result.complete = false;
  const records = []; let bytes = 0;
  for (const name of names.slice(0, 100)) {
    try {
      const file = await confined(root, `.game-workbench/runtime-history/${name}`);
      const size = (await fs.stat(file)).size;
      if (size > 2_000_000 || bytes + size > 8_000_000) { result.complete = false; continue; }
      bytes += size;
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      if (saved.version !== 1 || saved.root !== root || `${saved.state?.id}.json` !== name) { result.complete = false; continue; }
      if (saved.engine === enginePath && saved.state.status === 'failed' && Array.isArray(saved.result?.sourceManifest)) records.push(saved);
    } catch { result.complete = false; }
  }
  if (!records.length) return result;
  let manifest;
  try { manifest = JSON.stringify(await runtimeSourceManifest(root)); }
  catch { return { ...result, complete: false }; }
  for (const saved of records) {
    if (JSON.stringify(saved.result.sourceManifest) !== manifest) continue;
    for (const phase of ['execution', 'imported']) {
      const exitCode = saved.result[phase]?.exitCode;
      if (Number.isInteger(exitCode) && (exitCode >>> 0) >= 0xc0000000) {
        result.failures.push({ type: 'runtime-history', id: saved.state.id, at: saved.state.startedAt, phase, exitCode });
        break;
      }
    }
  }
  return result;
}
