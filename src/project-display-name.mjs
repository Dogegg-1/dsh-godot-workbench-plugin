import { promises as fs } from 'node:fs';
import path from 'node:path';
import { confined } from './storage.mjs';

// Display metadata only: never run the engine or create/alter a plan to name a project.
export async function projectDisplayName(root) {
  const fallback = path.basename(root) || root;
  let handle;
  try {
    const file = await confined(root, 'project.godot');
    handle = await fs.open(file, 'r');
    if (!(await handle.stat()).isFile()) return fallback;
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const source = buffer.subarray(0, bytesRead).toString('utf8');
    let application = false;
    for (const line of source.split(/\r?\n/)) {
      const section = line.trim().match(/^\[([^\]]+)\]\s*(?:;.*)?$/);
      if (section) { application = section[1] === 'application'; continue; }
      if (!application) continue;
      const match = line.match(/^\s*config\/name\s*=\s*("(?:[^"\\\r\n]|\\.)*")\s*(?:;.*)?$/);
      if (!match) continue;
      const title = JSON.parse(match[1]);
      if (title.trim() && title.length <= 240 && !/[\x00-\x1f\x7f]/.test(title)) return title.trim();
      return fallback;
    }
  } catch (error) {
    // Only our marked, not-yet-created space gets a friendly name. A real
    // project (even one with invalid metadata) must retain its own identity.
    if (error.code === 'ENOENT') {
      try {
        const marker = await confined(root, '.workbench-initial-space');
        const expected = 'DSH Godot Workbench initial space v1\n';
        if ((await fs.stat(marker)).size === Buffer.byteLength(expected) && await fs.readFile(marker, 'utf8') === expected) return '开始创作';
      } catch { /* Missing or inaccessible marker: retain the directory name. */ }
    }
  }
  finally { await handle?.close(); }
  return fallback;
}
