import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { confined, fault } from './storage.mjs';
import { checkGodot } from './project.mjs';
import { inspectExportReadiness } from './export-readiness.mjs';
import { runtimeSourceManifest } from './runtime-observation.mjs';
import { collectBuildProcess } from './build-process.mjs';
import { createSaveDirectoryProbe, verifySaveDirectory } from './save-directory.mjs';
import { createIsolatedRuntime } from './windows-runtime-isolation.mjs';
import { nativeOpenGlStartupFailed } from './build-failure.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
function compatibilityRenderingSection(config) {
  const sections = config.split(/(?=^\s*\[)/m);
  const rendering = sections.filter(section => /^\s*\[rendering\]/.test(section));
  if (rendering.length !== 1) throw fault('ANGLE_UNSUPPORTED', '兼容构建需要明确的 Compatibility 渲染配置，未修改工程');
  const section = rendering[0];
  const method = section.match(/^\s*renderer\/rendering_method\.windows\s*=\s*"([^"]+)"/m)?.[1] ?? section.match(/^\s*renderer\/rendering_method\s*=\s*"([^"]+)"/m)?.[1];
  if (method !== 'gl_compatibility' || /^\s*(?:renderer\/rendering_method|gl_compatibility\/driver)\.(?!windows\s*=|mobile\s*=)[\w.]+\s*=/m.test(section)) throw fault('ANGLE_UNSUPPORTED', '本次兼容方式只支持普通 Compatibility 工程，不会替你切换渲染器或覆盖特殊平台设置');
  return section;
}
export function applyBuildGraphics(config, graphics = 'project') {
  if (graphics === 'project') return config;
  if (graphics !== 'angle') throw fault('INVALID_GRAPHICS', '未知试玩图形设置');
  const section = compatibilityRenderingSection(config);
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
export async function buildPlayable({ projectRoot, engine, outputParent, graphics = 'project', signal, isolateRuntime = false, onProgress = () => {} }) {
  if (process.platform !== 'win32') throw fault('UNSUPPORTED_PLATFORM', '本版试玩构建仅支持 Windows');
  signal?.throwIfAborted();
  const source = await fs.realpath(projectRoot); const parent = await fs.realpath(outputParent);
  const relative = path.relative(source, parent);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw fault('INVALID_OUTPUT', '构建输出须放在源工程外');
  onProgress({ phase: 'checking' });
  const checked = await checkGodot(engine, source, { signal, isolateRuntime });
  if (checked.status !== 'available') throw fault('ENGINE_REQUIRED', checked.reason);
  const readiness = await inspectExportReadiness({ files: [], complete: true }, engine, checked.version);
  if (readiness.windowsTemplates.find(item => item.name === 'windows_release_x86_64.exe')?.status !== 'present-unverified') throw fault('TEMPLATES_REQUIRED', `缺少当前引擎版本的 Windows 导出模板。请在 Godot 导出模板管理器安装 ${checked.version} 对应模板后重试。`);
  const sourceManifest = await runtimeSourceManifest(source);
  if (sourceManifest.some(item => /\.(?:cs|csproj|gdextension)$/i.test(item.path))) throw fault('UNSUPPORTED_PROJECT', '本版试玩构建尚不支持 C# 或原生扩展工程');
  if (sourceManifest.some(item => item.path === 'override.cfg')) throw fault('OVERRIDE_UNSUPPORTED', '工程使用 override.cfg，需先核对导出覆盖设置；本次不会替换它');
  const root = await fs.mkdtemp(path.join(parent, 'playable-build-'));
  const writable = path.join(root, 'game');
  // res:// must not include the launcher's APPDATA or export output.
  const project = isolateRuntime ? path.join(writable, 'project') : path.join(root, 'project');
  const output = path.join(root, 'playable'); await fs.mkdir(project, { recursive: true });
  if (!isolateRuntime) await fs.mkdir(output);
  const report = { root, output, sourceRoot: source, engineVersion: checked.version, sourceManifest, status: 'preparing', exportPassed: false, startupPassed: false, humanPlaytest: false, profile: 'windows-x86_64-gdscript-playtest', limitations: ['未签名的试玩包，不能直接当成正式发行包', '使用工作台试玩预设，不沿用工程的发行预设', '试玩存档使用本次构建独立目录', '启动检查不代替输入、画面或人工试玩'], checks: {} };
  let projectConfig;
  let isolatedRun;
  let startupRun;
  async function run(label, executable, args, cwd, timeoutMs) {
    signal?.throwIfAborted(); onProgress({ phase: label });
    const result = await collectBuildProcess(executable, args, { cwd, timeoutMs, signal, ...(isolateRuntime ? { run: label === 'startup' ? startupRun : isolatedRun, windowed: label === 'startup' } : { logFile: label === 'startup' ? path.join(root, 'startup.log') : undefined }) });
    report.checks[label] = result;
    if (isolateRuntime && result.exitCode === 0 && !result.stdout?.trim()) throw fault('BUILD_CHECK_FAILED', '受限构建未生成引擎日志，无法核对结果');
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
    projectConfig = await fs.readFile(config, 'utf8');
    await fs.writeFile(config, applyBuildGraphics(isolateBuildSaves(projectConfig, saveId), graphics));
    if (isolateRuntime) {
      const templateSource = path.join(readiness.templateDirectory, 'windows_release_x86_64.exe');
      isolatedRun = await createIsolatedRuntime({ root, engine, signal, companionFiles: [{ source: templateSource, name: 'release.exe' }] });
      const templateBytes = await fs.readFile(path.join(root, 'engine', 'release.exe'));
      report.template = { name: 'windows_release_x86_64.exe', engineVersion: checked.version, sha256: hash(templateBytes), bytes: templateBytes.length };
      report.isolation = { editor: 'windows-lpac', startup: 'windows-appcontainer', capabilities: 0 };
    }
    // A trusted MainLoop script can inspect both project and PCK settings from
    // an absolute path. Keep it outside res:// so it never ships in the pack.
    const probeRoot = isolateRuntime ? writable : project;
    const resourceProbe = await createSaveDirectoryProbe(probeRoot);
    const saveProbe = isolateRuntime ? path.join(probeRoot, resourceProbe.slice('res://'.length)) : resourceProbe;
    report.checks.saveDirectory = await verifySaveDirectory({ executable: engine, project, script: saveProbe, expected: expectedSaveDirectory, signal, ...(isolateRuntime ? { run: isolatedRun, containedIn: writable } : {}) });
    await fs.writeFile(await confined(root, path.relative(root, path.join(project, 'export_presets.cfg')), { mustExist: false }), isolateRuntime ? previewPreset.replace('custom_template/release=""', `custom_template/release=${JSON.stringify(path.join(root, 'engine', 'release.exe').replaceAll('\\', '/'))}`) : previewPreset);
    await run('import', engine, ['--headless', '--path', project, '--editor', '--import'], project, 60000);
    const exportDirectory = isolateRuntime ? path.join(writable, 'dsh_export_' + randomUUID().replaceAll('-', '')) : output;
    if (isolateRuntime) await fs.mkdir(exportDirectory);
    const executable = path.join(exportDirectory, 'game.exe');
    await run('export', engine, ['--headless', '--path', project, '--export-release', 'DSH Windows Playtest', executable], project, 120000);
    report.artifacts = [];
    for (const filename of ['game.exe', 'game.pck']) {
      const file = await confined(root, path.relative(root, path.join(exportDirectory, filename)));
      if (isolateRuntime) {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.nlink !== 1) throw fault('UNTRUSTED_BUILD', '试玩产物必须是独立常规文件');
      }
      const bytes = await fs.readFile(file);
      if (!bytes.length) throw fault('EMPTY_BUILD', '生成的试玩文件为空');
      if (isolateRuntime && filename === 'game.exe' && hash(bytes) !== report.template.sha256) throw fault('UNTRUSTED_BUILD', '导出程序与已暂存的发布模板不一致，未启动或发布');
      report.artifacts.push({ name: filename, bytes: bytes.length, sha256: hash(bytes) });
    }
    report.checks.packedSaveDirectory = await verifySaveDirectory({ executable: engine, project: exportDirectory, script: saveProbe, expected: expectedSaveDirectory, pack: path.join(exportDirectory, 'game.pck'), signal, ...(isolateRuntime ? { run: isolatedRun, containedIn: writable } : {}) });
    report.exportPassed = true;
    // Launch the actual exported program without --path or the editor executable.
    // Match ordinary double-click startup; do not override the packed renderer.
    if (isolateRuntime) {
      const startupRoot = path.join(root, 'startup-sandbox');
      await fs.mkdir(path.join(startupRoot, 'game'), { recursive: true });
      startupRun = await createIsolatedRuntime({ root: startupRoot, engine: executable, executableName: 'game.exe', companionFiles: [{ name: 'game.pck', source: path.join(exportDirectory, 'game.pck') }], signal });
      for (const artifact of report.artifacts) {
        if (hash(await fs.readFile(await confined(startupRoot, 'engine/' + artifact.name))) !== artifact.sha256) throw fault('BUILD_CHANGED', '启动前试玩文件已变化');
      }
      await run('startup', executable, ['--quit-after', '60'], exportDirectory, 30000);
    } else await run('startup', executable, ['--quit-after', '60', '--log-file', path.join(root, 'startup.log')], output, 30000);
    if (graphics === 'angle' && !/Using Device.*ANGLE.*Direct3D11/i.test(report.checks.startup.fileLog ?? report.checks.startup.stdout ?? '')) throw fault('GRAPHICS_UNVERIFIED', '未能确认兼容图形方式实际启用，请保留日志排查');
    let publish = output;
    if (isolateRuntime) {
      publish = await fs.mkdtemp(path.join(root, 'publish-'));
      for (const artifact of report.artifacts) {
        const bytes = await fs.readFile(await confined(root, path.relative(root, path.join(exportDirectory, artifact.name))));
        if (hash(bytes) !== artifact.sha256) throw fault('BUILD_CHANGED', '验证期间试玩文件已变化，未发布');
        await fs.writeFile(path.join(publish, artifact.name), bytes, { flag: 'wx' });
      }
    }
    report.sourceState = JSON.stringify(await runtimeSourceManifest(source)) === JSON.stringify(sourceManifest) ? 'unchanged' : 'changed';
    await fs.writeFile(path.join(publish, '试玩说明.txt'), '双击 game.exe 开始试玩。发送给别人时请连同 game.pck 一起发送。\n这是未签名的 Windows x64 试玩包；自动启动检查不代表游戏体验已验收。\n存档与开发工程隔离，保存在本次构建专属的用户目录。\n');
    if (isolateRuntime) await fs.rename(publish, output);
    report.startupPassed = true; report.status = 'ready';
  } catch (error) {
    report.status = signal?.aborted ? 'cancelled' : 'failed'; report.error = { code: error.code ?? 'BUILD_FAILED', message: error.message, ...(error.evidence ? { evidence: error.evidence } : {}) };
    if (nativeOpenGlStartupFailed(report)) {
      try { compatibilityRenderingSection(projectConfig); report.compatibilityRetry = true; }
      catch (configurationError) { if (configurationError.code !== 'ANGLE_UNSUPPORTED') throw configurationError; }
    }
  }
  await fs.writeFile(path.join(root, 'build-report.json'), JSON.stringify(report, null, 2));
  return report;
}
