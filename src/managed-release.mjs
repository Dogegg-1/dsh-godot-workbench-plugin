import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function regularDirectory(dir) {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed release directory must not be a link.');
}
async function verify(root, index) {
  await regularDirectory(root);
  const expected = new Map(index.files.map(file => [file.path, file]));
  if (expected.size !== index.files.length) throw new Error('Duplicate release file.');
  async function walk(dir, prefix = '') {
    await regularDirectory(dir);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Release contains a link.');
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative + '/');
      else {
        const file = expected.get(relative);
        if (!entry.isFile() || !file) throw new Error('Unexpected release file.');
        const bytes = await fs.readFile(path.join(dir, entry.name));
        if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Managed release file differs.');
        expected.delete(relative);
      }
    }
  }
  await walk(path.join(root, 'bundle'));
  if (expected.size) throw new Error('Managed release is incomplete.');
  const metadata = path.join(root, 'release.json');
  if ((await fs.lstat(metadata)).isSymbolicLink()) throw new Error('Release index must not be a link.');
  if (JSON.stringify(JSON.parse(await fs.readFile(metadata, 'utf8'))) !== JSON.stringify(index)) throw new Error('Managed release index differs.');
}

// Called under the profile installation lock. Keep old versions for rollback.
// No existing package is overwritten or cleaned up automatically.
export async function stageManagedRelease({ source, home, index }) {
  if (!/^[a-f0-9]{64}$/.test(index.contentHash) || hash(JSON.stringify(index.files)) !== index.contentHash) throw new Error('Release index is damaged.');
  for (const file of index.files) {
    if (!file.path || path.isAbsolute(file.path) || file.path.includes(':') || file.path.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error('Invalid release file path.');
  }
  await verify(source, index);
  await regularDirectory(home);
  const store = path.join(home, 'workbench-releases');
  await fs.mkdir(store).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await regularDirectory(store);
  const destination = path.join(store, index.contentHash);
  const existing = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) { await verify(destination, index); return destination; }
  // A failed partial copy remains separate and is never activated.
  const staging = path.join(store, '.partial-' + randomUUID());
  await fs.mkdir(staging);
  for (const file of index.files) {
    const output = path.join(staging, 'bundle', file.path);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.copyFile(path.join(source, 'bundle', file.path), output, 1);
  }
  await fs.writeFile(path.join(staging, 'release.json'), JSON.stringify(index), { flag: 'wx' });
  await verify(staging, index);
  await fs.rename(staging, destination);
  return destination;
}
