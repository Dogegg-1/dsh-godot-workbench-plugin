import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { restoreFirstInstall } from './restore-first-install.mjs';

// Used only by the local installer, never registered as an agent tool.
export async function restoreInstallation({ profile, home, install, exe, manager, pending }) {
  if (pending.length === 1 && pending[0].action === 'install' && pending[0].status !== 'unreadable') return restoreFirstInstall({ profile, home, install, exe, archive: pending[0].archive });
  if (pending.length !== 1 || !['upgrade', 'uninstall'].includes(pending[0].action) || pending[0].status === 'unreadable') throw new Error('Recovery cannot safely identify one interrupted upgrade or uninstall. Keep all archives for inspection.');
  const action = pending[0].action;
  const archive = pending[0].archive, packageName = '@xingyou/godot-workbench';
  async function read(file, optional = false) {
    try {
      const st = await fs.lstat(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 16777216) throw new Error('Recovery source is not a regular bounded file.');
      return await fs.readFile(file);
    } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  }
  const oldReceiptBytes = await read(path.join(archive, 'godot-workbench-install.json.before'));
  const oldReceipt = JSON.parse(oldReceiptBytes);
  const oldManifest = JSON.parse(await read(path.join(archive, 'package.json.before')));
  const operation = JSON.parse(await read(path.join(archive, 'operation.json')));
  if (oldReceipt.profile !== profile || oldReceipt.packageName !== packageName || !path.isAbsolute(oldReceipt.release) || operation.action !== action) throw new Error('Recovery archive does not match this installation.');
  const files = ['package.json', 'cordis.patch.yml', 'godot-workbench-install.json', 'game-workbench.settings.json'];
  const before = new Map(await Promise.all(files.map(async name => [name, await read(path.join(profile, name), true)])));
  const originalPatch = await read(path.join(archive, 'cordis.patch.yml.before'));
  const removedPatch = action === 'uninstall' ? await read(path.join(archive, 'patch.expected.yml'), true) : null;
  const patchNeedsRestore = !before.get('cordis.patch.yml')?.equals(originalPatch);
  if (patchNeedsRestore && !before.get('cordis.patch.yml')?.equals(removedPatch)) throw new Error('Configuration changed after the operation; recovery will not overwrite it.');
  const currentReceiptBytes = before.get('godot-workbench-install.json');
  if (currentReceiptBytes && !currentReceiptBytes.equals(oldReceiptBytes)) {
    if (action === 'uninstall') throw new Error('Receipt changed after uninstall; recovery will not overwrite it.');
    const current = JSON.parse(currentReceiptBytes);
    if (current.upgradeArchive !== archive || current.previousRelease !== oldReceipt.release || current.release !== operation.release || JSON.stringify(current.patchRow) !== JSON.stringify(oldReceipt.patchRow)) throw new Error('Receipt changed after the upgrade; recovery will not overwrite it.');
  }
  function checkManifest(bytes) {
    const current = JSON.parse(bytes), a = structuredClone(oldManifest), b = structuredClone(current);
    const spec = current.dependencies?.[packageName];
    const permitted = action === 'uninstall' ? [oldReceipt.dependencySpec, undefined] : [oldReceipt.dependencySpec, `file:${path.join(operation.release, 'bundle').replaceAll('\\', '/')}`];
    if (!permitted.includes(spec)) throw new Error('Recovery found an unexpected workbench dependency.');
    for (const manifest of [a, b]) {
      if (manifest.dependencies) {
        delete manifest.dependencies[packageName];
        if (!Object.keys(manifest.dependencies).length) delete manifest.dependencies;
      }
      if (action === 'uninstall' && Array.isArray(manifest.dsh?.profile?.bundles)) {
        manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== packageName);
      }
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Unrelated configuration changed; recovery stopped.');
    return current;
  }
  checkManifest(before.get('package.json'));
  async function run(args, log) {
    const child = spawn(exe, ['--expose-internals', ...args], { cwd: profile, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' } });
    let output = '', errorOutput = '';
    child.stdout.on('data', bytes => { if (output.length < 1048576) output += bytes; });
    child.stderr.on('data', bytes => { if (errorOutput.length < 1048576) errorOutput += bytes; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    if (log) await fs.writeFile(log, output + errorOutput, { flag: 'wx', mode: 0o600 });
    if (code !== 0) throw new Error('Recovery package operation failed; keep the archive and original configuration.');
    return output;
  }
  const verified = JSON.parse(await run([manager, 'inspect', install, home, oldReceipt.release]));
  if (verified.contentHash !== oldReceipt.contentHash || verified.desktopRunning) throw new Error('Original package unavailable or DSH is running; recovery stopped.');
  const oldIndex = JSON.parse(await read(path.join(oldReceipt.release, 'release.json')));
  const lockFile = path.join(profile, 'lock');
  const lock = await fs.open(lockFile, 'wx'); // Never reclaim an unknown/stale lock.
  const lockBytes = Buffer.from(String(process.pid)); await lock.writeFile(lockBytes);
  const attempt = path.join(archive, 'recovery-' + randomUUID());
  let outcome = 'interrupted';
  async function unchanged(name, expected) {
    const current = await read(path.join(profile, name), true);
    if ((current === null) !== (expected === null) || (current && !current.equals(expected))) throw new Error(`Configuration changed concurrently: ${name}; recovery stopped.`);
  }
  try {
    await fs.mkdir(attempt);
    for (const [name, bytes] of before) { await unchanged(name, bytes); if (bytes) await fs.writeFile(path.join(attempt, name + '.before'), bytes, { flag: 'wx', mode: 0o600 }); }
    await run([path.join(install, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), 'plugin', '--profile', 'desktop', 'add', `file:${path.join(oldReceipt.release, 'bundle')}`, '--offline', '--ignore-scripts', '--config.auto-install-peers=false'], path.join(attempt, 'package-manager.log'));
    const restoredManifest = checkManifest(await read(path.join(profile, 'package.json')));
    if (restoredManifest.dependencies[packageName] !== oldReceipt.dependencySpec) throw new Error('Previous dependency was not restored.');
    if (action === 'uninstall' && JSON.stringify(restoredManifest.dsh?.profile?.bundles) !== JSON.stringify(oldManifest.dsh?.profile?.bundles)) throw new Error('Previous bundle registration was not restored.');
    for (const item of oldIndex.files) {
      const bytes = await read(path.join(profile, 'node_modules', packageName, item.path));
      if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`Restored file verification failed: ${item.path}`);
    }
    for (const name of files.filter(name => name !== 'package.json')) await unchanged(name, before.get(name));
    if (patchNeedsRestore) {
      const staged = path.join(attempt, 'patch.next.yml');
      await fs.writeFile(staged, originalPatch, { flag: 'wx', mode: 0o600 });
      const displaced = path.join(attempt, 'patch.displaced.yml');
      await fs.rename(path.join(profile, 'cordis.patch.yml'), displaced);
      if (!(await read(displaced)).equals(before.get('cordis.patch.yml'))) {
        await fs.link(displaced, path.join(profile, 'cordis.patch.yml')).catch(() => {});
        throw new Error('Concurrent configuration preserved; recovery stopped.');
      }
      await fs.link(staged, path.join(profile, 'cordis.patch.yml'));
    }
    if (!currentReceiptBytes?.equals(oldReceiptBytes)) {
      const staged = path.join(attempt, 'receipt.next.json'); await fs.writeFile(staged, oldReceiptBytes, { flag: 'wx', mode: 0o600 });
      if (currentReceiptBytes) {
        const displaced = path.join(attempt, 'receipt.displaced.json'); await fs.rename(path.join(profile, 'godot-workbench-install.json'), displaced);
        if (!(await read(displaced)).equals(currentReceiptBytes)) { await fs.link(displaced, path.join(profile, 'godot-workbench-install.json')).catch(() => {}); throw new Error('Concurrent receipt preserved; recovery stopped.'); }
      }
      await fs.link(staged, path.join(profile, 'godot-workbench-install.json'));
    }
    const previousResult = await read(path.join(archive, 'result.json'), true);
    if (previousResult) await fs.writeFile(path.join(attempt, 'result.before.json'), previousResult, { flag: 'wx' });
    const stagedResult = path.join(attempt, 'result.next.json');
    await fs.writeFile(stagedResult, JSON.stringify({ action, outcome: 'rolled-back', recoveryAttempt: attempt }));
    await fs.rename(stagedResult, path.join(archive, 'result.json'));
    outcome = 'complete';
    return { ok: true, restoredRelease: oldReceipt.release, archive, attempt, verifiedFiles: oldIndex.files.length, gameFilesModified: false };
  } finally {
    await fs.writeFile(path.join(attempt, 'result.json'), JSON.stringify({ action: 'recover', outcome })).catch(() => {});
    await lock.close();
    if ((await read(lockFile, true))?.equals(lockBytes)) await fs.unlink(lockFile);
  }
}
