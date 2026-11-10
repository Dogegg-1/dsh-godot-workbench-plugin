import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

// Local installer only. Roll back our first-install changes, never game files.
export async function restoreFirstInstall({ profile, home, install, exe, archive }) {
  const name = '@xingyou/godot-workbench';
  async function read(file, optional = false) {
    try { const s = await fs.lstat(file); if (!s.isFile() || s.isSymbolicLink() || s.size > 16_777_216) throw Error('Invalid recovery evidence'); return await fs.readFile(file); }
    catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
  }
  const op = JSON.parse(await read(path.join(archive, 'operation.json')));
  const original = JSON.parse(await read(path.join(archive, 'package.json.before')));
  if (op.action !== 'install' || op.profile !== profile || !path.isAbsolute(op.release) || original.dependencies?.[name] || await read(path.join(archive, 'godot-workbench-install.json.before'), true)) throw Error('First-install ownership cannot be verified');
  const files = ['package.json', 'cordis.patch.yml', 'godot-workbench-install.json', 'game-workbench.settings.json'];
  const current = new Map(await Promise.all(files.map(async f => [f, await read(path.join(profile, f), true)])));
  const receipt = current.get('godot-workbench-install.json');
  if (receipt) {
    const r = JSON.parse(receipt);
    if (r.archive !== archive || r.profile !== profile || r.packageName !== name || r.release !== op.release || r.contentHash !== op.contentHash) throw Error('Receipt changed after install; recovery stopped');
  }
  const originalPatch = await read(path.join(archive, 'cordis.patch.yml.before'));
  const expectedPatch = await read(path.join(archive, 'patch.expected.yml'), true);
  const patchChanged = !current.get('cordis.patch.yml')?.equals(originalPatch);
  if (patchChanged && (!expectedPatch || !current.get('cordis.patch.yml')?.equals(expectedPatch))) throw Error('Configuration changed after install; recovery will not overwrite it');
  function validateManifest(bytes, removed = false) {
    const value = JSON.parse(bytes), spec = value.dependencies?.[name];
    if (spec !== undefined && (removed || spec !== `file:${path.join(op.release, 'bundle').replaceAll('\\', '/')}`)) throw Error('Unexpected workbench dependency; recovery stopped');
    const clean = x => {
      const r = structuredClone(x);
      if (r.dependencies) { delete r.dependencies[name]; if (!Object.keys(r.dependencies).length) delete r.dependencies; }
      if (Array.isArray(r.dsh?.profile?.bundles)) r.dsh.profile.bundles = r.dsh.profile.bundles.filter(b => b !== name);
      return r;
    };
    if (!isDeepStrictEqual(clean(value), clean(original))) throw Error('Unrelated configuration changed; recovery stopped');
    if (removed && value.dsh?.profile?.bundles?.includes(name)) throw Error('Workbench registration still present');
    return value;
  }
  const manifest = validateManifest(current.get('package.json'));
  const lockPath = path.join(profile, 'lock'), lock = await fs.open(lockPath, 'wx');
  const lockBytes = Buffer.from(String(process.pid)), attempt = path.join(archive, 'recovery-' + randomUUID());
  let outcome = 'interrupted';
  async function unchanged(file, bytes) {
    const actual = await read(path.join(profile, file), true);
    if ((actual === null) !== (bytes === null) || (actual && !actual.equals(bytes))) throw Error(`Configuration changed concurrently: ${file}`);
  }
  try {
    await lock.writeFile(lockBytes); await fs.mkdir(attempt);
    for (const [file, bytes] of current) { await unchanged(file, bytes); if (bytes) await fs.writeFile(path.join(attempt, file + '.before'), bytes, { flag: 'wx' }); }
    if (manifest.dependencies?.[name] || manifest.dsh?.profile?.bundles?.includes(name)) {
      const args = ['--expose-internals', path.join(install, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), 'plugin', '--profile', 'desktop', 'remove', name, '--config.offline=true', '--config.ignore-scripts=true', '--config.auto-install-peers=false'];
      const child = spawn(exe, args, { cwd: profile, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' } });
      let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { if (output.length < 1_048_576) output += b; });
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      await fs.writeFile(path.join(attempt, 'package-manager.log'), output, { flag: 'wx' });
      if (code !== 0) throw Error('Recovery package removal failed; keep archive');
    }
    validateManifest(await read(path.join(profile, 'package.json')), true);
    for (const file of files.filter(f => f !== 'package.json')) await unchanged(file, current.get(file));
    if (patchChanged) {
      const staged = path.join(attempt, 'patch.next.yml'), displaced = path.join(attempt, 'patch.displaced.yml');
      await fs.writeFile(staged, originalPatch, { flag: 'wx' }); await fs.rename(path.join(profile, 'cordis.patch.yml'), displaced);
      if (!(await read(displaced)).equals(current.get('cordis.patch.yml'))) { await fs.link(displaced, path.join(profile, 'cordis.patch.yml')).catch(() => {}); throw Error('Concurrent configuration preserved; recovery stopped'); }
      await fs.link(staged, path.join(profile, 'cordis.patch.yml'));
    }
    if (receipt) {
      const displaced = path.join(attempt, 'receipt.removed.json'); await fs.rename(path.join(profile, 'godot-workbench-install.json'), displaced);
      if (!(await read(displaced)).equals(receipt)) { await fs.link(displaced, path.join(profile, 'godot-workbench-install.json')).catch(() => {}); throw Error('Concurrent receipt preserved; recovery stopped'); }
    }
    const oldResult = await read(path.join(archive, 'result.json'), true);
    if (oldResult) await fs.writeFile(path.join(attempt, 'result.before.json'), oldResult, { flag: 'wx' });
    const staged = path.join(attempt, 'result.next.json');
    await fs.writeFile(staged, JSON.stringify({ action: 'install', outcome: 'rolled-back', recoveryAttempt: attempt }));
    await fs.rename(staged, path.join(archive, 'result.json')); outcome = 'complete';
    return { ok: true, action: 'install', installationRemoved: true, archive, attempt, gameFilesModified: false, accountConfigurationModified: false };
  } finally {
    await fs.writeFile(path.join(attempt, 'result.json'), JSON.stringify({ action: 'recover', outcome })).catch(() => {});
    await lock.close(); if ((await read(lockPath, true))?.equals(lockBytes)) await fs.unlink(lockPath);
  }
}
