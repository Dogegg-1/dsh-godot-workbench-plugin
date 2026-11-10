import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProcess } from './project.mjs';
import { fault } from './storage.mjs';

// MainLoop deliberately avoids SceneTree: game scenes and autoloads must not run
// merely to discover where user:// actually resolves on this engine/platform.
export async function createSaveDirectoryProbe(project) {
  const directory = 'dsh_save_probe_' + randomUUID().replaceAll('-', '');
  await fs.mkdir(path.join(project, directory));
  await fs.writeFile(path.join(project, directory, 'probe.gd'), `extends MainLoop
func _initialize() -> void:
    print("WORKBENCH_USER_DIRECTORY:" + JSON.stringify({"actual": OS.get_user_data_dir(), "configured": ProjectSettings.get_setting("application/config/custom_user_dir_name", ""), "custom": ProjectSettings.get_setting("application/config/use_custom_user_dir", false)}))
func _process(_delta: float) -> bool:
    return true
`);
  return `res://${directory}/probe.gd`;
}
export async function verifySaveDirectory({ executable, project, script, expected, pack, signal }) {
  // Release templates may silently ignore --script. Probe the actual PCK using
  // the matching editor binary, whose MainLoop script support was verified.
  const result = await runProcess(executable, ['--headless', '--path', project, ...(pack ? ['--main-pack', pack] : []), '--script', script], { cwd: project, timeoutMs: 30000, signal });
  const line = result.stdout.split(/\r?\n/).find(line => line.startsWith('WORKBENCH_USER_DIRECTORY:'));
  let observed;
  try { observed = line && JSON.parse(line.slice('WORKBENCH_USER_DIRECTORY:'.length)); } catch { /* Invalid output is not proof. */ }
  const normalize = value => String(value ?? '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  const verified = result.exitCode === 0 && !result.timedOut && !result.truncated && observed?.custom === true && normalize(observed.configured) === normalize(expected) && normalize(observed.actual).endsWith('/' + normalize(expected));
  if (!verified) {
    const error = fault('SAVE_DIRECTORY_UNVERIFIED', '尚未确认独立存档目录，已停止启动游戏，避免改动原有进度。');
    error.evidence = { ...result, observed: observed ?? null, expected, verified: false };
    throw error;
  }
  return { ...observed, expected, verified: true, exitCode: 0, stdout: JSON.stringify(observed), stderr: '' };
}
