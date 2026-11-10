import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { confined, fault } from './storage.mjs';
import { checkGodot } from './project.mjs';
import { inspectExportReadiness } from './export-readiness.mjs';
import { runtimeSourceManifest } from './runtime-observation.mjs';
import { collectBuildProcess } from './build-process.mjs';
import { createSaveDirectoryProbe, verifySaveDirectory } from './save-directory.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
export function applyBuildGraphics(config, graphics = 'project') {
  if (graphics === 'project') return config;
  if (graphics !== 'angle') throw fault('INVALID_GRAPHICS', '未知试玩图形设置');
  const sections = config.split(/(?=^\s*\[)/m);
  const rendering = sections.filter(section => /^\s*\[rendering\]/.test(section));
  if (rendering.length !== 1) throw fault('ANGLE_UNSUPPORTED', '兼容构建需要明确的 Compatibility 渲染配置，未修改工程');
  const section = rendering[0];
  const method = section.match(/^\s*renderer\/rendering_method\.windows\s*=\s*"([^"]+)"/m)?.[1] ?? section.match(/^\s*renderer\/rendering_method\s*=\s*"([^"]+)"/m)?.[1];
  if (method !== 'gl_compatibility' || /^\s*(?:renderer\/rendering_method|gl_compatibility\/driver)\.(?!windows\s*=|mobile\s*=)[\w.]+\s*=/m.test(section)) throw fault('ANGLE_UNSUPPORTED', '本次兼容方式只支持普通 Compatibility 工程，不会替你切换渲染器或覆盖特殊平台设置');
  return config.replace(section, section.replace(/^\s*gl_compatibility\/driver\.windows\s*=.*$/gm, '').replace('[rendering]', '[rendering]\ngl_compatibility/driver.windows="opengl3_angle"'));
}
export const previewPreset = `[preset.0]
name="DSH Windows Playtest"
platform="Windows Desktop"
runnable=true
export_filter="all_resources"
include_filter=""
exclude_filter="verify.gd,game-workbench.json"
export_path=""
script_export_mode=2

[preset.0.options]
custom_template/debug=""
custom_template/release=""
binary_format/architecture="x86_64"
binary_format/embed_pck=false
application/modify_resources=false
codesign/enable=false
`;

export function isolateBuildSaves(config, id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw fault('INVALID_BUILD_ID', '构建标识无效');
  const lines = config.split(/\r?\n/); const result = []; let application = false, found = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      application = section[1] === 'application'; result.push(line);
      if (application) {
        if (found) throw fault('INVALID_PROJECT', '工程存在重复 application 配置，请先整理');
        found = true;
        result.push('config/use_custom_user_dir=true', `config/custom_user_dir_name="dsh-playtest-builds/${id}"`);
      }
    } else if (!application || !/^\s*config\/(?:use_custom_user_dir|custom_user_dir(?:_name)?)(?:\.[\w.]+)?\s*=/.test(line)) result.push(line);
  }
  if (!found) throw fault('INVALID_PROJECT', '工程缺少 application 配置');
  return result.join('\n');
}

// Deliberately a Windows GDScript playtest preset, not a signed production release.
export async function buildPlayable({ projectRoot, engine, outputParent, graphics = 'project', signal, onProgress = () => {} }) {
  if (process.platform !== 'win32') throw fault('UNSUPPORTED_PLATFORM', '本版试玩构建仅支持 Windows');
  signal?.throwIfAborted();
  const source = await fs.realpath(projectRoot); const parent = await fs.realpath(outputParent);
  const relative = path.relative(source, parent);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw fault('INVALID_OUTPUT', '构建输出须放在源工程外');
  onProgress({ phase: 'checking' });
  const checked = await checkGodot(engine, source, { signal });
  if (checked.status !== 'available') throw fault('ENGINE_REQUIRED', checked.reason);
  const readiness = await inspectExportReadiness({ files: [], complete: true }, engine, checked.version);
  if (readiness.windowsTemplates.find(item => item.name === 'windows_release_x86_64.exe')?.status !== 'present-unverified') throw fault('TEMPLATES_REQUIRED', `缺少当前引擎版本的 Windows 导出模板。请在 Godot 导出模板管理器安装 ${checked.version} 对应模板后重试。`);
  const sourceManifest = await runtimeSourceManifest(source);
  if (sourceManifest.some(item => /\.(?:cs|csproj|gdextension)$/i.test(item.path))) throw fault('UNSUPPORTED_PROJECT', '本版试玩构建尚不支持 C# 或原生扩展工程');
  if (sourceManifest.some(item => item.path === 'override.cfg')) throw fault('OVERRIDE_UNSUPPORTED', '工程使用 override.cfg，需先核对导出覆盖设置；本次不会替换它');
  const root = await fs.mkdtemp(path.join(parent, 'playable-build-'));
  const project = path.join(root, 'project'); const output = path.join(root, 'playable'); await fs.mkdir(project); await fs.mkdir(output);
  const report = { root, output, sourceRoot: source, engineVersion: checked.version, sourceManifest, status: 'preparing', exportPassed: false, startupPassed: false, humanPlaytest: false, profile: 'windows-x86_64-gdscript-playtest', limitations: ['未签名的试玩包，不能直接当成正式发行包', '使用工作台试玩预设，不沿用工程的发行预设', '试玩存档使用本次构建独立目录', '启动检查不代替输入、画面或人工试玩'], checks: {} };
  async function run(label, executable, args, cwd, timeoutMs) {
    signal?.throwIfAborted(); onProgress({ phase: label });
    const result = await collectBuildProcess(executable, args, { cwd, timeoutMs, signal, logFile: label === 'startup' ? path.join(root, 'startup.log') : undefined });
    report.checks[label] = result;
    if (result.exitCode !== 0 || result.timedOut || result.truncated || result.fileLogTruncated || result.fileLogError || result.issues.some(issue => issue.severity === 'error')) {
      const reason = result.timedOut ? '运行超时' : result.exitCode !== 0 ? `程序退出码 ${result.exitCode}${result.exitCode > 0xffff ? `（0x${result.exitCode.toString(16).toUpperCase()}）` : ''}` : result.truncated || result.fileLogTruncated || result.fileLogError ? '日志不完整或无法读取' : '引擎报告错误';
      throw fault('BUILD_CHECK_FAILED', `${label === 'export' ? '导出' : label === 'startup' ? '试玩程序启动' : '工程导入'}未通过：${reason}，请查看依据日志`);
    }
  }
  try {
    onProgress({ phase: 'copying' });
    for (const item of sourceManifest) {
      signal?.throwIfAborted();
      const data = await fs.readFile(await confined(source, item.path));
      if (hash(data) !== item.hash) throw fault('SOURCE_CHANGED', '复制期间工程已变化，请等编辑完成后重试');
      const destination = path.join(project, item.path); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, data, { flag: 'wx' });
    }
    const config = path.join(project, 'project.godot');
    const saveId = randomUUID(), expectedSaveDirectory = `dsh-playtest-builds/${saveId}`;
    report.graphics = graphics;
    await fs.writeFile(config, applyBuildGraphics(isolateBuildSaves(await fs.readFile(config, 'utf8'), saveId), graphics));
    const saveProbe = await createSaveDirectoryProbe(project);
    report.checks.saveDirectory = await verifySaveDirectory({ executable: engine, project, script: saveProbe, expected: expectedSaveDirectory, signal });
    await fs.writeFile(path.join(project, 'export_presets.cfg'), previewPreset);
    await run('import', engine, ['--headless', '--path', project, '--editor', '--import'], project, 60000);
    const executable = path.join(output, 'game.exe');
    await run('export', engine, ['--headless', '--path', project, '--export-release', 'DSH Windows Playtest', executable], project, 120000);
    report.artifacts = [];
    for (const filename of ['game.exe', 'game.pck']) {
      const file = await confined(output, filename); const bytes = await fs.readFile(file);
      if (!bytes.length) throw fault('EMPTY_BUILD', '生成的试玩文件为空');
      report.artifacts.push({ name: filename, bytes: bytes.length, sha256: hash(bytes) });
    }
    report.checks.packedSaveDirectory = await verifySaveDirectory({ executable: engine, project: output, script: saveProbe, expected: expectedSaveDirectory, pack: path.join(output, 'game.pck'), signal });
    report.exportPassed = true;
    // Launch the actual exported program without --path or the editor executable.
    // Match ordinary double-click startup; do not override the packed renderer.
    await run('startup', executable, ['--quit-after', '60', '--log-file', path.join(root, 'startup.log')], output, 30000);
    if (graphics === 'angle' && !/Using Device.*ANGLE.*Direct3D11/i.test(report.checks.startup.fileLog ?? '')) throw fault('GRAPHICS_UNVERIFIED', '未能确认兼容图形方式实际启用，请保留日志排查');
    report.startupPassed = true; report.status = 'ready';
    report.sourceState = JSON.stringify(await runtimeSourceManifest(source)) === JSON.stringify(sourceManifest) ? 'unchanged' : 'changed';
    await fs.writeFile(path.join(output, '试玩说明.txt'), '双击 game.exe 开始试玩。发送给别人时请连同 game.pck 一起发送。\n这是未签名的 Windows x64 试玩包；自动启动检查不代表游戏体验已验收。\n存档与开发工程隔离，保存在本次构建专属的用户目录。\n');
  } catch (error) {
    report.status = signal?.aborted ? 'cancelled' : 'failed'; report.error = { code: error.code ?? 'BUILD_FAILED', message: error.message, ...(error.evidence ? { evidence: error.evidence } : {}) };
  }
  await fs.writeFile(path.join(root, 'build-report.json'), JSON.stringify(report, null, 2));
  return report;
}
