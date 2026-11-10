import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { confined, digest, fault } from './storage.mjs';
import { readProjectFile } from './file-changes.mjs';
import { readManifest, readParameters, prepareParameterText } from './project-resources.mjs';
import { simulateMiningEconomy } from './economy-simulation.mjs';

// Implementations verified against real Godot by verify-economy-simulation.mjs.
// Unknown implementations need an adapter/parity check, never silently this model.
const verified = {
  'mining_state.gd': '183e995992f016509cdc2e3a7ce3d07f35a6a5118c627d8466a3f8e7fe1e911c',
  'balance.gd': '2231d98f0413d35702d2b78855910a680159441dd07286abf750e7594c4e7f5b',
};
// Read direct external bindings by identity, allowing editor-added UID metadata
// and regenerated IDs. Do not accept a declaration without its section binding.
function externalBinding(text, body, property, type, resource) {
  const assignments = body.split('\n').filter(line => new RegExp(`^${property}\\s*=`).test(line));
  const match = assignments.length === 1 && assignments[0].match(/^\w+\s*=\s*ExtResource\("([^"\n]+)"\)\s*$/);
  if (!match) return false;
  const declarations = text.split('\n').filter(line => line.startsWith('[ext_resource ')).map(line => {
    const attrs = [...line.matchAll(/(?:^|\s)(\w+)="([^"\n]*)"/g)];
    if (new Set(attrs.map(a => a[1])).size !== attrs.length) return null;
    return Object.fromEntries(attrs.map(a => [a[1], a[2]]));
  });
  const candidates = declarations.filter(a => a?.id === match[1]);
  return candidates.length === 1 && candidates[0].type === type && candidates[0].path === `res://${resource}`;
}
// Deliberately supports only the recipe's direct text-scene entry. This is
// binding evidence, not proof that callbacks execute or the game is playable.
async function entryBinding(root, sources) {
  const texts = {};
  for (const name of ['project.godot', 'main.tscn', 'main.gd']) {
    const file = await readProjectFile(root, { path: name });
    if (file.hash === 'missing' || file.encoding !== 'utf8' || file.truncated) return { reason: `入口文件${name}缺失或超出可检查范围。` };
    sources[name] = file.hash;
    texts[name] = file.content.replaceAll('\r\n', '\n');
  }
  const sections = texts['project.godot'].split(/(?=^\[)/m);
  const application = sections.filter(s => /^\[application\][ \t]*\n/.test(s));
  if (application.length !== 1) return { reason: '无法唯一识别当前游戏入口设置。' };
  const main = application[0].split('\n').filter(line => /^run\/main_scene\s*=/.test(line));
  if (main.length !== 1 || !/^run\/main_scene\s*=\s*"res:\/\/main\.tscn"\s*(?:;.*)?$/.test(main[0])) return { reason: '当前启动场景不是已适配的挖矿入口，不能沿用该玩法的模拟。' };
  const scene = texts['main.tscn'];
  const roots = scene.split(/(?=^\[)/m).filter(s => /^\[node\b/.test(s) && !/^\[node[^\n]*\bparent\s*=/.test(s));
  if (roots.length !== 1 || /\binstance\s*=/.test(roots[0].split('\n')[0])) return { reason: '当前主场景不是已适配的直接节点入口。' };
  for (const [property, type, resource] of [['script', 'Script', 'main.gd'], ['balance', 'Resource', 'balance.tres']]) {
    if (!externalBinding(scene, roots[0], property, type, resource)) return { reason: `主场景未绑定预期的${resource}，不能沿用旧模拟。` };
  }
  return { status: 'static-binding-only', mainScene: 'res://main.tscn', script: 'res://main.gd', parameters: 'res://balance.tres', runtimeVerified: false };
}
export async function projectEconomy(root, options = {}, overrides) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !['strategy', 'includeCurve', 'expectedFingerprint'].includes(k))) throw fault('INVALID_SIMULATION', 'simulation内仅支持strategy、includeCurve、expectedFingerprint。操作节奏放simulation.strategy，假设数值values与simulation同级。例如 {"simulation":{"strategy":{"durationSeconds":3600,"clicksPerSecond":1}},"values":{"upgrade_multiplier":1.5}}');
  if (options.includeCurve !== undefined && typeof options.includeCurve !== 'boolean') throw fault('INVALID_SIMULATION', 'includeCurve需要布尔值');
  if (options.strategy !== undefined && (!options.strategy || typeof options.strategy !== 'object' || Array.isArray(options.strategy))) throw fault('INVALID_SIMULATION', 'strategy需要策略对象');
  if (options.expectedFingerprint !== undefined && (typeof options.expectedFingerprint !== 'string' || options.expectedFingerprint.length > 128)) throw fault('INVALID_SIMULATION', '来源标识无效');
  const manifest = await readManifest(root);
  const unavailable = reason => ({ available: false, reason, next: '先让 AI 核对当前玩法和数值规则，确认能否使用这套模拟。',
    adapter: {
      id: 'mining-incremental-v1',
      directMainScene: 'res://main.tscn',
      rootBindings: { script: 'res://main.gd', balance: 'res://balance.tres' },
      ruleValidation: 'mining_state.gd与balance.gd必须匹配经过引擎对照的实现；参数需合法。',
      unsupported: ['其他启动场景，即使加载或实例化main.tscn', '仅在其他入口挂载挖矿脚本', '纯UID启动入口', '继承场景或间接根节点绑定'],
      interpretation: '这是当前工作台模拟适配器的支持范围，不是Godot或游戏玩法本身的要求。保留其他入口需扩展工作台适配并做引擎对照；仅改变游戏场景连线不能解除此限制。不要为通过检查擅自改回旧入口，也不能由不支持推断玩法损坏。',
    } });
  if (manifest.data?.economy !== 'mining-incremental-v1' || manifest.data?.parameters?.path !== 'balance.tres') return unavailable('当前仅接入已核对的挖矿模型与balance.tres参数源。');
  const parameters = await readParameters(root, manifest.data.parameters);
  if (!parameters.available || parameters.issues.length) return unavailable('参数源缺失或含无效值，尚未模拟。');
  const resourceText = parameters.text.replaceAll('\r\n', '\n');
  const resourceBodies = resourceText.split(/(?=^\[)/m).filter(part => /^\[resource\]\s*\n/.test(part));
  if (resourceBodies.length !== 1 || !externalBinding(resourceText, resourceBodies[0], 'script', 'Script', 'balance.gd')) return unavailable('数值资源的脚本绑定不符合已验证模型。');
  const sources = { 'game-workbench.json': manifest.hash, 'balance.tres': parameters.hash };
  const entry = await entryBinding(root, sources);
  if (entry.reason) return unavailable(entry.reason);
  for (const [name, expected] of Object.entries(verified)) {
    const file = await readProjectFile(root, { path: name });
    if (file.hash === 'missing') return unavailable(`缺少规则文件${name}。`);
    const bytes = await fs.readFile(await confined(root, name));
    if (bytes.length > 262144) return unavailable(`规则文件${name}过大，未匹配模型。`);
    if (createHash('sha256').update(bytes).digest('hex') !== file.hash) throw fault('RESOURCE_CHANGED', '规则读取期间变化，请重试');
    sources[name] = file.hash;
    if (createHash('sha256').update(bytes.toString('utf8').replaceAll('\r\n', '\n')).digest('hex') !== expected) return unavailable(`${name}已不同于核对过的规则，不能沿用旧模拟。`);
  }
  if (overrides !== undefined) prepareParameterText(parameters, overrides);
  const values = { ...Object.fromEntries(parameters.fields.map(field => [field.key, field.value])), ...overrides };
  const report = simulateMiningEconomy(values, options.strategy ?? {});
  for (const [name, expected] of Object.entries(sources)) if ((await readProjectFile(root, { path: name })).hash !== expected) throw fault('RESOURCE_CHANGED', '模拟期间源文件变化，请重新计算');
  const sourceFingerprint = digest(sources);
  if (!options.includeCurve) delete report.curve;
  else {
    const originalSamples = report.curve.length;
    const stride = Math.max(1, Math.ceil((originalSamples - 1) / 119));
    report.curve = report.curve.filter((_, index) => index % stride === 0 || index === originalSamples - 1);
    report.curveSampling = { originalSamples, returnedSamples: report.curve.length, note: '曲线至多120点，保留首尾；购买事件和等待统计未抽样。' };
  }
  return { available: true, ...report, entryBinding: entry, sourceFingerprint, sources, previousSourceChanged: options.expectedFingerprint ? options.expectedFingerprint !== sourceFingerprint : null, hypothetical: overrides !== undefined,
    scope: '已核对经济状态类、参数资源及启动场景的静态脚本/资源绑定；未证明脚本实际调用这些规则或输入回调有效，未运行画面、真实输入或人工试玩。结果仅对应读取时的文件。' };
}
