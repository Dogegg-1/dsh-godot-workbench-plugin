import { promises as fs } from 'node:fs';
import path from 'node:path';
import { confined, digest, fault } from './storage.mjs';
import { checkGodot, runProcess } from './project.mjs';

const inFlight = new Map();
const sections = ['methods', 'properties', 'members', 'signals', 'constants', 'enums', 'constructors', 'operators'];
const identifier = (value, label, optional = false) => {
  if (optional && (value === '' || value === undefined)) return '';
  if (typeof value !== 'string' || !/^@?[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw fault('INVALID_API_QUERY', `${label}需要类或成员标识符，例如 NavigationPathQueryParameters3D、simplify_path`);
  return value;
};

export function queryEngineReference(data, { className, member = '' }, source) {
  className = identifier(className, '类名'); member = identifier(member, '成员名', true);
  const entries = [...data.classes.map((value, index) => ({ value, pointer: `/classes/${index}` })),
    ...data.builtin_classes.map((value, index) => ({ value, pointer: `/builtin_classes/${index}` }))];
  const index = new Map(entries.map(entry => [entry.value.name, entry]));
  const entry = index.get(className);
  const base = { source, version: data.header.version_full_name, coverage: { classes: data.classes.length, builtinClasses: data.builtin_classes.length, note: '本机引擎导出的 GDExtension API 与说明，不包含全部教程、GDScript 专用语法、插件 API 或 C# 绑定差异。' } };
  if (!entry) return { ...base, status: 'class-not-found', candidates: entries.filter(e => e.value.name.toLowerCase().includes(className.toLowerCase())).slice(0, 12).map(e => e.value.name), note: '此导出中没有找到这个类。不要推断整个引擎不存在该名称；继续核对对应版本的语言或插件文档。' };
  const chain = []; const visited = new Set();
  for (let current = entry; current && !visited.has(current.value.name); current = index.get(current.value.inherits)) {
    visited.add(current.value.name); chain.push(current);
  }
  const matches = [];
  if (member) for (const current of chain) {
    for (const section of sections) (current.value[section] ?? []).forEach((item, itemIndex) => {
      if (item.name === member) matches.push({ owner: current.value.name, section, pointer: `${current.pointer}/${section}/${itemIndex}`, detail: item });
      if (section === 'enums') (item.values ?? []).forEach((constant, constantIndex) => {
        if (constant.name === member) matches.push({ owner: current.value.name, section: 'enum-value', enum: item.name, pointer: `${current.pointer}/${section}/${itemIndex}/values/${constantIndex}`, detail: constant });
      });
    });
    if (matches.length) break; // Nearest declaration overrides inherited names.
  }
  const summary = { name: entry.value.name, inherits: entry.value.inherits ?? null, brief: entry.value.brief_description ?? '', description: (entry.value.description ?? '').slice(0, 5000), descriptionTruncated: (entry.value.description?.length ?? 0) > 5000, pointer: entry.pointer };
  const inventory = Object.fromEntries(sections.map(section => [section, (entry.value[section] ?? []).slice(0, 80).map(item => item.name ?? `constructor:${item.index}`)]));
  const result = { ...base, status: member ? matches.length ? 'matched' : 'member-not-found' : 'matched', class: summary, member, matches,
    ...(!member || !matches.length ? { declaredMembers: inventory, inventoryTruncated: sections.some(section => (entry.value[section]?.length ?? 0) > 80), searchedInheritance: chain.map(e => e.value.name) } : {}),
    note: '签名与说明来自下列本机导出位置。未导出的默认值、语言映射或行为不要补编；必要时用对应版本官方文档和最小运行验证补足。' };
  // Very long docs remain navigable by their JSON pointer, without unbounded output.
  result.matches = result.matches.slice(0, 6).map(match => {
    if (JSON.stringify(match.detail).length <= 7000) return match;
    return { ...match, detail: { name: match.detail.name, description: (match.detail.description ?? '').slice(0, 5000), arguments: match.detail.arguments?.slice(0, 20), return_value: match.detail.return_value, return_type: match.detail.return_type }, truncated: true };
  });
  return result;
}

async function generate(enginePath, directory, target, signal) {
  const staging = await fs.mkdtemp(path.join(directory, 'dump-'));
  const generated = path.join(staging, 'extension_api.json');
  try {
    const result = await runProcess(enginePath, ['--headless', '--path', staging, '--dump-extension-api-with-docs'], { cwd: staging, signal, timeoutMs: 60000 });
    signal?.throwIfAborted();
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) throw fault('API_EXPORT_FAILED', '引擎 API 导出未完成，请检查当前引擎是否支持 --dump-extension-api-with-docs；本次没有提供缓存结论。');
    const stat = await fs.stat(generated);
    if (!stat.isFile() || stat.size > 64_000_000) throw fault('API_EXPORT_TOO_LARGE', '引擎导出超过 64 MB 或格式不正确，请采用文档检索。');
    await fs.rename(generated, target);
  } finally {
    // Only remove the exact generated cache file and its now-empty directory.
    await fs.unlink(generated).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(staging).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  }
}

export async function lookupEngineReference(workbench, { className, member = '', refresh = false, signal } = {}) {
  identifier(className, '类名'); identifier(member, '成员名', true);
  if (typeof refresh !== 'boolean') throw fault('INVALID_INPUT', 'refresh 必须为布尔值');
  const engine = await checkGodot(workbench.enginePath, workbench.root, { signal });
  if (engine.status !== 'available') return { status: 'unavailable', reason: engine.reason, nextAction: '先配置当前项目可用的 Godot；不要使用记忆编造 API。' };
  await workbench.store.prepare();
  const directory = await confined(workbench.root, '.game-workbench/engine-api', { mustExist: false });
  await fs.mkdir(directory, { recursive: true });
  const binary = await fs.stat(workbench.enginePath);
  const key = digest({ path: workbench.enginePath, version: engine.version, size: binary.size, mtime: binary.mtimeMs }).slice(0, 24);
  const relative = `.game-workbench/engine-api/${key}.json`;
  const target = await confined(workbench.root, relative, { mustExist: false });
  const exists = await fs.access(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (!exists || refresh) {
    if (!inFlight.has(target)) {
      const pending = generate(workbench.enginePath, directory, target, signal).finally(() => inFlight.delete(target));
      inFlight.set(target, pending);
    }
    await inFlight.get(target);
  }
  signal?.throwIfAborted();
  const cache = await confined(workbench.root, relative);
  if ((await fs.stat(cache)).size > 64_000_000) throw fault('API_EXPORT_TOO_LARGE', 'API 缓存超过读取上限');
  const raw = await fs.readFile(cache, 'utf8');
  let data;
  try { data = JSON.parse(raw); } catch { throw fault('INVALID_API_CACHE', 'API 缓存格式损坏，请用 refresh=true 从引擎重新导出'); }
  const exportedVersion = `${data.header?.version_major}.${data.header?.version_minor}.${data.header?.version_patch}`;
  if (!Array.isArray(data.classes) || !Array.isArray(data.builtin_classes) || !engine.version.startsWith(exportedVersion + '.')) throw fault('INVALID_API_CACHE', 'API 缓存结构或版本与当前引擎不符，请重新导出');
  return queryEngineReference(data, { className, member }, { kind: 'local-engine-api-export', engineVersion: engine.version, enginePath: workbench.enginePath, file: cache, sha256: digest(raw), command: ['--headless', '--dump-extension-api-with-docs'] });
}
