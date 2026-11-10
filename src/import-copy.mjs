import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confined, fault } from './storage.mjs';

const excluded = new Set(['.git', '.godot', '.game-workbench', 'node_modules', '.env']);
const isolatedExcluded = new Set(['logs', 'tmp', 'build', 'export', 'saves', 'savegames']);

// Preserve source/import settings, including .gdignore and .import sidecars.
// This is not an OS sandbox for project tool scripts or native extensions.
export async function withImportCopy(source, operation, { signal, maxFiles = 10000, maxBytes = 256_000_000, isolatedLayout = false } = {}) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(source);
  const within = path.relative(root, parent);
  if (!within || (!within.startsWith('..') && !path.isAbsolute(within))) throw fault('INVALID_OUTPUT', '无法在原工程外建立引擎检查副本。');
  const copy = await fs.mkdtemp(path.join(parent, 'dsh-import-'));
  const game = isolatedLayout ? path.join(copy, 'game') : copy;
  let files = 0, bytes = 0;
  try {
    if (isolatedLayout) await fs.mkdir(game);
    async function walk(relative = '') {
      signal?.throwIfAborted();
      for (const entry of await fs.readdir(await confined(root, relative), { withFileTypes: true })) {
        if (excluded.has(entry.name)) continue;
        if (isolatedLayout && (isolatedExcluded.has(entry.name.toLowerCase()) || (entry.name.startsWith('.') && entry.name !== '.gdignore') || /credential|password/i.test(entry.name))) continue;
        signal?.throwIfAborted();
        const name = path.join(relative, entry.name);
        const from = await confined(root, name);
        const to = path.join(game, name);
        if (entry.isDirectory()) { await fs.mkdir(to); await walk(name); }
        else {
          if (!entry.isFile()) throw fault('UNSUPPORTED_FILE', '引擎检查副本不支持链接或特殊文件。');
          const stat = await fs.stat(from);
          if (isolatedLayout && stat.nlink !== 1) throw fault('UNSUPPORTED_FILE', '引擎检查副本不读取共享硬链接。');
          if (++files > maxFiles || bytes + stat.size > maxBytes) throw fault('IMPORT_COPY_LIMIT', '工程超过本版独立检查容量（10000文件、256MB），本次未执行引擎检查。');
          const data = await fs.readFile(from); bytes += data.length;
          if (bytes > maxBytes) throw fault('IMPORT_COPY_LIMIT', '复制期间工程超过独立检查容量，本次未执行引擎检查。');
          await fs.writeFile(to, data, { flag: 'wx' });
        }
      }
    }
    await walk();
    signal?.throwIfAborted();
    return await operation(game, { root: copy });
  } finally {
    // Validate the generated target before recursive removal on Windows.
    const relative = path.relative(parent, copy);
    if (path.dirname(copy) !== parent || !/^dsh-import-[\w-]+$/.test(relative)) throw fault('INVALID_OUTPUT', '检查副本清理路径不符合预期，已保留。');
    await fs.rm(copy, { recursive: true, force: true, maxRetries: 2 });
  }
}
