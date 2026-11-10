import { promises as fs } from 'node:fs';
import path from 'node:path';

// Read-only journal inspection. Missing evidence never means successful recovery.
export async function pendingInstallOperations(profile) {
  const folder = path.join(profile, '.godot-workbench-install');
  const stat = await fs.lstat(folder).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) return [{ id: 'archive', status: 'unreadable', action: 'unknown' }];
  const pending = [];
  async function read(file) {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1048576) throw new Error('Invalid journal file');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const archive = path.join(folder, entry.name);
    try {
      if (entry.isSymbolicLink()) throw new Error('Linked archive');
      const operation = await read(path.join(archive, 'operation.json'));
      if (!['install', 'uninstall', 'upgrade'].includes(operation.action)) throw new Error('Unknown operation');
      const result = await read(path.join(archive, 'result.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (result && result.action !== operation.action) throw new Error('Mismatched journal');
      if (result && ['complete', 'rolled-back'].includes(result.outcome)) continue;
      pending.push({ id: entry.name, action: operation.action, status: result?.outcome === 'recovery-required' ? 'recovery-required' : 'not-finished', archive });
    } catch {
      pending.push({ id: entry.name, action: 'unknown', status: 'unreadable', archive });
    }
  }
  return pending;
}
