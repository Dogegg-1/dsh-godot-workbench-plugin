import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { confined, digest, fault } from './storage.mjs';
import { inspectProject } from './project.mjs';
import { readProjectFile } from './file-changes.mjs';

export const MANIFEST = 'game-workbench.json';
export const mediaExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ogg', '.wav', '.ttf', '.otf', '.glb']);
const resourceExtensions = new Set([...mediaExtensions, '.tscn', '.tres', '.res', '.gdshader']);
const excluded = /^(?:\.|node_modules$|logs$|tmp$|export$|build$|saves?$)|credential|secret|token|password/i;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function resourcePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || path.isAbsolute(value) || value.includes('\\') || value.split('/').some(p => !p || p === '..' || excluded.test(p) || /[:\x00-\x1f]|[. ]$/.test(p))) throw fault('INVALID_RESOURCE_PATH', '需要项目内的资源相对路径，不能指向缓存、存档或私密目录');
  return value;
}
const problem = (code, message, file, line = 1, category = 'confirmed') => ({ code, message, path: file, line, category });

export async function readManifest(root) {
  const file = await readProjectFile(root, { path: MANIFEST });
  if (file.hash === 'missing') return { data: { schemaVersion: 1, assets: [] }, hash: file.hash, issues: [] };
  const raw = await fs.readFile(await confined(root, MANIFEST), 'utf8');
  if (createHash('sha256').update(raw).digest('hex') !== file.hash) throw fault('RESOURCE_CHANGED', '资源说明读取时发生变化，请刷新后再操作');
  if (Buffer.byteLength(raw) > 262144) return { data: null, hash: file.hash, issues: [problem('MANIFEST_INVALID', '资源说明超过 256 KiB，请先拆分整理。', MANIFEST)] };
  try {
    const data = JSON.parse(raw);
    if (!plain(data) || data.schemaVersion !== 1 || (data.assets !== undefined && (!Array.isArray(data.assets) || data.assets.length > 1000))) throw new Error('需要 schemaVersion=1，assets 为至多 1000 条的数组');
    const known = new Set();
    for (const asset of data.assets ?? []) {
      if (!plain(asset) || typeof asset.source !== 'string' || asset.source.length > 2000 || !['draft', 'implemented', 'unknown'].includes(asset.status)) throw new Error('资产需要路径、来源文字和 draft/implemented/unknown 状态');
      resourcePath(asset.path);
      if (known.has(asset.path.toLowerCase())) throw new Error(`重复资产路径：${asset.path}`);
      known.add(asset.path.toLowerCase());
    }
    if (data.parameters !== undefined) {
      const parameters = data.parameters;
      if (!plain(parameters) || parameters.format !== 'godot-resource' || !Array.isArray(parameters.fields) || parameters.fields.length > 40 || !parameters.fields.length) throw new Error('参数需要 godot-resource 格式和 1 至 40 个字段');
      resourcePath(parameters.path);
      if (!parameters.path.endsWith('.tres')) throw new Error('参数源必须是 .tres 资源');
      const names = new Set();
      for (const field of parameters.fields) {
        if (!plain(field) || !/^[a-zA-Z_][\w]*$/.test(field.key) || names.has(field.key) || typeof field.label !== 'string' || field.label.length > 80 || typeof field.unit !== 'string' || field.unit.length > 80 || typeof field.effect !== 'string' || field.effect.length > 500 || !['integer', 'number', 'boolean'].includes(field.type)) throw new Error('参数字段需要唯一名称、标签、单位、影响说明和数值/布尔类型');
        if (field.type !== 'boolean' && (!Number.isFinite(field.min) || !Number.isFinite(field.max) || field.min > field.max || (field.type === 'integer' && (!Number.isSafeInteger(field.min) || !Number.isSafeInteger(field.max))))) throw new Error(`参数 ${field.key} 的范围不合法`);
        names.add(field.key);
      }
    }
    return { data, hash: file.hash, issues: [] };
  } catch (error) { return { data: null, hash: file.hash, issues: [problem('MANIFEST_INVALID', `资源说明无法读取：${error.message}`, MANIFEST)] }; }
}

export function parameterValue(value, field) {
  if (field.type === 'boolean') return typeof value === 'boolean' ? null : '需要开关值';
  if (typeof value !== 'number' || !Number.isFinite(value) || (field.type === 'integer' && !Number.isSafeInteger(value))) return field.type === 'integer' ? '需要整数' : '需要有限数值';
  return value < field.min || value > field.max ? `应在 ${field.min} 至 ${field.max} 之间` : null;
}
export async function readParameters(root, definition) {
  if (!definition) return { available: false, fields: [], issues: [], note: `尚未登记参数。可在 ${MANIFEST} 指向游戏实际使用的 .tres 资源。` };
  const file = await readProjectFile(root, { path: definition.path });
  if (file.hash === 'missing') return { available: false, path: definition.path, fields: [], issues: [problem('PARAMETER_SOURCE_MISSING', '声明的参数资源不存在。', definition.path)] };
  const text = await fs.readFile(await confined(root, definition.path), 'utf8');
  if (createHash('sha256').update(text).digest('hex') !== file.hash) throw fault('RESOURCE_CHANGED', '参数资源读取时发生变化，请刷新后再操作');
  if (Buffer.byteLength(text) > 262144) throw fault('RESOURCE_TOO_LARGE', '参数资源超过 256 KiB，暂不直接编辑');
  const lines = text.split('\n'); let inResource = false;
  const positions = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { inResource = /^\s*\[resource\]\s*\r?$/.test(lines[i]); continue; }
    if (!inResource) continue;
    const assignment = lines[i].match(/^(\s*)([a-zA-Z_]\w*)(\s*=\s*)(.*?)(\r?)$/);
    if (assignment) { const values = positions.get(assignment[2]) ?? []; values.push({ index: i, prefix: assignment[1] + assignment[2] + assignment[3], raw: assignment[4], suffix: assignment[5] }); positions.set(assignment[2], values); }
  }
  const issues = [];
  const fields = definition.fields.map(field => {
    const found = positions.get(field.key) ?? []; const location = found[0];
    let value = null; let error;
    if (found.length !== 1) error = found.length ? '同一属性重复定义，不能确定唯一来源' : '资源未显式保存此属性；先在 Godot 资源中设置并保存';
    else if (/^(?:true|false)$/.test(location.raw)) value = location.raw === 'true';
    else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(location.raw)) value = Number(location.raw);
    else error = '当前只支持显式保存的数值或布尔属性，不改写表达式与复合类型';
    error ??= parameterValue(value, field);
    if (error) issues.push(problem('PARAMETER_INVALID', `${field.label}（${field.key}）：${error}。`, definition.path, (location?.index ?? 0) + 1));
    return { ...field, value, line: (location?.index ?? 0) + 1, error: error ?? null };
  });
  return { available: true, path: definition.path, hash: file.hash, fields, issues, text, lines, positions };
}

export function prepareParameterText(parameters, values) {
  if (!parameters.available || !plain(values) || !Object.keys(values).length) throw fault('INVALID_PARAMETERS', '请先选择要调整的参数');
  const fields = new Map(parameters.fields.map(field => [field.key, field]));
  const lines = [...parameters.lines]; const changes = [];
  for (const [key, value] of Object.entries(values)) {
    const field = fields.get(key);
    if (!field) throw fault('INVALID_PARAMETERS', `未登记参数：${key}`);
    const invalid = parameterValue(value, field);
    if (invalid) throw fault('INVALID_PARAMETERS', `${field.label}：${invalid}`);
    const found = parameters.positions.get(key) ?? [];
    if (found.length !== 1 || (field.error && field.value === null)) throw fault('INVALID_PARAMETERS', `${field.label}没有可安全替换的单一数值，先核对源资源`);
    if (field.value === value) continue;
    const location = found[0]; lines[location.index] = location.prefix + String(value) + location.suffix;
    changes.push({ key, label: field.label, before: field.value, after: value, unit: field.unit, effect: field.effect });
  }
  return { content: lines.join('\n'), changes };
}

export function economyReport(parameters, recipe, overrides = {}) {
  if (recipe !== 'mining-incremental-v1' || !parameters.available) return null;
  const values = Object.fromEntries(parameters.fields.map(field => [field.key, field.value])); Object.assign(values, overrides);
  const keys = ['click_yield', 'coin_per_ore', 'base_upgrade_cost', 'upgrade_multiplier', 'miner_output'];
  if (keys.some(key => typeof values[key] !== 'number' || !Number.isFinite(values[key]) || values[key] <= 0) || parameters.fields.some(field => parameterValue(values[field.key], field))) return { available: false, reason: '先修正参数，再计算回本时间。' };
  const marginalIncome = values.miner_output * values.coin_per_ore;
  const levels = Array.from({ length: 5 }, (_, i) => {
    const cost = Math.ceil(values.base_upgrade_cost * values.upgrade_multiplier ** i);
    return { level: i + 1, cost, addedCoinsPerSecond: marginalIncome, paybackSeconds: cost / marginalIncome, savingSeconds: i ? cost / (i * marginalIncome) : null };
  });
  return { available: true, firstUpgradeClicks: Math.ceil(Math.ceil(values.base_upgrade_cost / values.coin_per_ore) / values.click_yield), levels, formula: '购买价格 = ceil(基础价格 × 涨价倍率 ^ 已有矿机数)；回本秒数 = 价格 ÷（单机产矿/秒 × 单矿售价）', assumptions: ['矿石即时全部出售，不计点击和出售操作耗时', '从零库存计算，不含离线收益、暂停、容量限制和其他奖励', '理论计算，不代表玩家实际等待时间或体验通过'] };
}

export async function inventory(root, scan, metadata = []) {
  const assets = []; const skipped = []; let walked = 0;
  async function walk(relative = '') {
    const dir = await confined(root, relative);
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.test(entry.name)) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (++walked > 3000 || assets.length >= 1000) { skipped.push({ path: relative, reason: 'inventory-limit' }); break; }
      if (entry.isSymbolicLink()) { skipped.push({ path: name, reason: 'symbolic-link' }); continue; }
      if (entry.isDirectory()) { await walk(name); continue; }
      const extension = path.extname(name).toLowerCase(); if (!resourceExtensions.has(extension)) continue;
      const stat = await fs.lstat(await confined(root, name));
      if (!stat.isFile() || stat.nlink !== 1) { skipped.push({ path: name, reason: 'not-independent-file' }); continue; }
      const record = metadata.find(item => item.path === name);
      assets.push({ path: name, type: extension.slice(1), bytes: stat.size, source: record?.source || '来源待核实', status: record?.status ?? 'unknown', references: [], replaceable: mediaExtensions.has(extension) && extension !== '.svg' && stat.size <= 16 * 1024 * 1024 });
    }
  }
  await walk();
  const references = [];
  for (const file of scan.files) if (file.text) {
    let line = 0;
    for (const text of file.text.split('\n')) {
      line++;
      if (/^\s*(?:#|\/\/)/.test(text)) continue;
      for (const match of text.matchAll(/["']res:\/\/([^"'\r\n]+)["']/g)) {
        const target = match[1];
        if (target.includes('..') || target.includes(':') || target.includes('\\')) continue;
        const prefix = text.slice(0, match.index);
        const resourceLike = resourceExtensions.has(path.extname(target).toLowerCase()) || target.endsWith('.gd');
        const explicitLoad = /\b(?:load|preload)\s*\(\s*$/.test(prefix);
        references.push({ from: file.path, line, target, kind: resourceLike || explicitLoad ? 'resource-candidate' : 'unclassified-path' });
      }
    }
  }
  for (const asset of assets) asset.references = references.filter(reference => reference.target === asset.path).slice(0, 30);
  const missing = [], unclassifiedPaths = [];
  for (const reference of references) {
    try { resourcePath(reference.target); await fs.access(await confined(root, reference.target)); }
    catch (error) { if (['ENOENT', 'INVALID_RESOURCE_PATH', 'OUTSIDE_PROJECT'].includes(error.code)) (reference.kind === 'resource-candidate' ? missing : unclassifiedPaths).push(reference); }
  }
  return { assets, missingReferences: missing, unclassifiedPaths, complete: !skipped.length && scan.complete, skipped, note: '只统计当前可识别的引用；未发现引用不代表可以删除。来源与使用状态由项目登记，实际效果仍需检查。', limitations: '资源扩展名或 load/preload 的 res:// 字面路径作为资源候选；其他路径单独列为未分类，不自动判为丢失资源。跳过整行注释，不解析完整语法、动态拼接、文件读写数据流、uid://、二进制资源或完整运行依赖。' };
}

export async function inspectResources(root, { state, values, snapshot } = {}) {
  const manifest = await readManifest(root);
  const parameters = await readParameters(root, manifest.data?.parameters);
  const scan = snapshot ?? await inspectProject(root);
  const assets = await inventory(root, scan, manifest.data?.assets ?? []);
  const changes = values ? prepareParameterText(parameters, values).changes : [];
  const issues = [...manifest.issues, ...parameters.issues, ...assets.missingReferences.map(reference => problem('RESOURCE_REFERENCE_MISSING', `静态路径引用 ${reference.target} 未找到；先核对是否为实际引用。`, reference.from, reference.line, 'risk'))];
  const token = digest({ revision: state?.revision, manifest: manifest.hash, parameters: parameters.hash ?? null });
  const { text, lines, positions, ...publicParameters } = parameters;
  return { manifest: { path: MANIFEST, hash: manifest.hash, present: manifest.hash !== 'missing', valid: Boolean(manifest.data) }, parameters: publicParameters, inventory: assets, issues, token, changes, economy: economyReport(parameters, manifest.data?.economy), proposedEconomy: values ? economyReport(parameters, manifest.data?.economy, values) : null };
}
