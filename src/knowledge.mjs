import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectProject } from './project.mjs';
import { fault, digest, confined } from './storage.mjs';
import { summaryCurrency } from './summary-currency.mjs';
import { projectLessonEntries } from './project-lessons.mjs';

const catalogPath = fileURLToPath(new URL('../knowledge/catalog.json', import.meta.url));
const knowledgeRoot = path.dirname(catalogPath);
export const categories = ['engine', 'design', 'engineering', 'feel', 'production'];
export const stages = ['intake', 'plan', 'implement', 'diagnose', 'verify', 'finish'];
// Explicit starting points, not a claim that these recipes fit every project.
const recommendedIds = {
  intake: ['production-planning', 'design-loop', 'engine-scenes', 'production-assets'],
  plan: ['production-planning', 'design-loop', 'engine-scenes', 'feel-jump'],
  implement: ['engineering-state-machine', 'engine-scenes', 'feel-buffer', 'production-milestones'],
  diagnose: ['production-bugfix', 'engine-run', 'engineering-save', 'feel-jump'],
  verify: ['production-evidence', 'engine-export', 'engineering-save', 'design-playtest'],
  finish: ['production-release', 'engine-export', 'production-evidence', 'production-assets'],
};
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const summaryOnly = ({ body, bodyHash, ...summary }) => summary;
function tokens(text) {
  const normalized = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/帮我|一下|如何|怎么|为什么|什么|目前|现在|一个|需要|可以|能不能|游戏|项目|\b(?:godot|please|the|with)\b/gi, ' ');
  const parts = normalized.match(/0x[0-9a-f]+|[a-z_][a-z0-9_]*|[\p{Script=Han}]+/gu) ?? [];
  return [...new Set(parts.flatMap(part => /^[\p{Script=Han}]+$/u.test(part) && part.length > 2 ? [part, ...Array.from({ length: part.length - 1 }, (_, i) => part.slice(i, i + 2))] : [part]))];
}
export async function searchKnowledge({ query = '', stage = 'plan', limit = 5, id, mode = 'search', category, offset = 0 } = {}, projectEntries = []) {
  if (!stages.includes(stage)) throw fault('INVALID_STAGE', `未知任务阶段。stage 只能为 ${stages.join('、')}，检索时也可省略。`);
  if (!Number.isInteger(limit) || limit < 1 || limit > 15) throw fault('INVALID_LIMIT', '检索条数必须为 1 至 15');
  if (typeof query !== 'string' || query.length > 2000) throw fault('INVALID_QUERY', '检索问题需要不超过 2000 字的文字');
  if (!['search', 'browse', 'recommend'].includes(mode)) throw fault('INVALID_KNOWLEDGE_MODE', '未知知识查看方式');
  if (!Number.isSafeInteger(offset) || offset < 0 || (mode !== 'browse' && offset !== 0)) throw fault('INVALID_OFFSET', '知识分页位置无效');
  if (category !== undefined && (mode !== 'browse' || !categories.includes(category))) throw fault('INVALID_CATEGORY', '请选择已有知识分类');
  if (mode !== 'search' && (id !== undefined || query.trim())) throw fault('INVALID_QUERY', '浏览或推荐不能同时指定检索问题或条目');
  const raw = await fs.readFile(catalogPath, 'utf8'); const catalog = JSON.parse(raw);
  catalog.entries.push(...projectEntries);
  const coverage = Object.fromEntries(categories.map(category => [category, catalog.entries.filter(e => e.category === category).length]));
  const base = { coverage, note: `${catalog.coverageNote}${projectEntries.length ? ' 含本项目沉淀经验；请区分自动提炼与人工核对，均不代表工具独立复验。' : ''}`, indexHash: digest({ catalog: raw, projectEntries }), updatedAt: catalog.updatedAt };
  if (mode === 'browse') {
    const entries = catalog.entries.filter(entry => category === undefined || entry.category === category).sort(byId);
    const results = entries.slice(offset, offset + limit).map(summaryOnly);
    return { ...base, mode, results, total: entries.length, nextOffset: offset + results.length < entries.length ? offset + results.length : null,
      status: results.length ? 'matched' : 'no-match', nextAction: '选择条目查看做法、适用条件和来源' };
  }
  if (mode === 'recommend') {
    const eligible = catalog.entries.filter(entry => entry.stages.includes(stage)).sort(byId);
    const chosen = recommendedIds[stage].map(id => eligible.find(entry => entry.id === id)).filter(Boolean).slice(0, limit);
    const seen = new Set(chosen.map(entry => entry.id));
    // Fill larger requests round-robin across available categories, rather than
    // allowing an alphabetically early category to occupy the whole first page.
    while (chosen.length < Math.min(limit, eligible.length)) {
      for (const group of categories) {
        const entry = eligible.find(entry => entry.category === group && !seen.has(entry.id));
        if (entry) { chosen.push(entry); seen.add(entry.id); }
        if (chosen.length === limit) break;
      }
    }
    return { ...base, mode, results: chosen.map(summaryOnly), total: eligible.length, nextOffset: null,
      status: chosen.length ? 'matched' : 'no-match', nextAction: '从当前阶段的做法开始，或浏览全部知识' };
  }
  if (id !== undefined) {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,100}$/.test(id)) throw fault('INVALID_RECIPE', '知识条目标识不正确');
    const entry = catalog.entries.find(entry => entry.id === id);
    if (!entry) throw fault('UNKNOWN_RECIPE', '没有这个知识条目，请先检索');
    let body = entry.body ?? `# ${entry.title}\n\n${entry.content}`;
    if (entry.bodyPath) {
      const file = await confined(knowledgeRoot, entry.bodyPath);
      if ((await fs.stat(file)).size > 64000) throw fault('RECIPE_TOO_LARGE', '配方超过按需加载限制');
      body = await fs.readFile(file, 'utf8');
    }
    return { ...base, results: [{ ...entry, body, bodyHash: digest(body) }], status: 'matched', nextAction: '核对来源、适用条件和验证状态，再结合项目使用' };
  }
  const words = tokens(query).filter(word => word.length > 1 || /^\p{Script=Han}$/u.test(word));
  const documents = catalog.entries.map(entry => ({ title: new Set(tokens(entry.title)), tags: new Set(tokens(entry.tags.join(' '))), body: new Set(tokens(entry.content)) }));
  const weights = new Map(words.map(word => [word, Math.log(1 + catalog.entries.length / (1 + documents.filter(doc => doc.title.has(word) || doc.tags.has(word) || doc.body.has(word)).length))]));
  const scored = catalog.entries.map((entry, index) => {
    const { body, ...summary } = entry; // Full project evidence is loaded by id, not repeated in every search.
    const doc = documents[index];
    const matched = words.filter(word => doc.title.has(word) || doc.tags.has(word) || doc.body.has(word));
    const signals = matched.filter(word => doc.title.has(word) || doc.tags.has(word));
    const relevance = matched.reduce((sum, word) => sum + weights.get(word) * (doc.title.has(word) ? 6 : doc.tags.has(word) ? 4 : 1), 0);
    return { ...summary, score: relevance + (entry.stages.includes(stage) ? 1 : 0), relevance, matchedTerms: matched, strongMatch: signals.length > 0 || (matched.length >= 2 && matched.length / words.length >= 0.25) };
  }).filter(entry => query.trim() ? words.length && entry.strongMatch : entry.stages.includes(stage));
  const results = scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  return { ...base, results, status: results.length ? 'matched' : 'no-match', nextAction: results.length ? '根据条目 id 按需读取完整配方；核对适用版本与项目约束' : '本地未找到可靠匹配。明确缺失主题；引擎 API 调用 gamedev_engine_reference，其他主题查询原始资料，不编造答案' };
}

const queues = new Map();
async function appendKnowledgeLog(root, entry) {
  const previous = queues.get(root) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const dir = await confined(root, '.game-workbench', { mustExist: false }); await fs.mkdir(dir, { recursive: true });
    const log = await confined(root, '.game-workbench/knowledge-log.jsonl', { mustExist: false });
    const stat = await fs.stat(log).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (stat?.size > 1_048_576) await fs.rename(log, await confined(root, '.game-workbench/knowledge-log.previous.jsonl', { mustExist: false }));
    await fs.appendFile(log, JSON.stringify(entry) + '\n');
  });
  queues.set(root, pending);
  try { await pending; } finally { if (queues.get(root) === pending) queues.delete(root); }
}
export async function recordKnowledgeSearch(root, options, result, origin) {
  const queryId = randomUUID();
  try {
    await appendKnowledgeLog(root, { type: 'search', queryId, at: new Date().toISOString(), origin, stage: options.stage ?? 'plan', query: (options.query ?? '').slice(0, 1000), recipeId: options.id ?? null, ids: result.results.map(e => e.id), bodyHashes: Object.fromEntries(result.results.filter(e => e.bodyHash).map(e => [e.id, e.bodyHash])), status: result.status, indexHash: result.indexHash });
    return { ...result, queryId, logging: { status: 'recorded' } };
  } catch (error) { return { ...result, logging: { status: 'failed', reason: error.message } }; }
}
export async function recordKnowledgeFeedback(root, { queryId, resolved, reason = '' } = {}) {
  if (typeof queryId !== 'string' || !/^[a-f0-9-]{36}$/.test(queryId) || typeof resolved !== 'boolean' || typeof reason !== 'string' || reason.length > 1000) throw fault('INVALID_FEEDBACK', '需要检索标识、是否有帮助及简短说明');
  let found = false;
  for (const name of ['knowledge-log.jsonl', 'knowledge-log.previous.jsonl']) {
    const file = await confined(root, `.game-workbench/${name}`, { mustExist: false });
    const stat = await fs.stat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (stat?.size > 1_100_000) throw fault('KNOWLEDGE_LOG_TOO_LARGE', '检索记录过大，请保留记录并核查后再反馈');
    const text = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
    if (text.split('\n').some(line => { try { const entry = JSON.parse(line); return entry.type === 'search' && entry.queryId === queryId; } catch { return false; } })) found = true;
  }
  if (!found) throw fault('UNKNOWN_SEARCH', '这条检索记录不存在或已超出本地保留窗口，请重新检索');
  await appendKnowledgeLog(root, { type: 'feedback', queryId, at: new Date().toISOString(), actor: 'local-user', resolved, reason });
  return { recorded: true };
}

export async function gatherContext(root, state, { stage, query = '', maxChars = 14000 } = {}) {
  if (!stages.includes(stage)) throw fault('INVALID_STAGE', `未知任务阶段。stage 只能为 ${stages.join('、')}。`);
  const knowledge = await recordKnowledgeSearch(root, { query, stage }, await searchKnowledge({ query, stage }, projectLessonEntries(state)), 'context');
  const snapshot = await inspectProject(root);
  const words = tokens(query);
  let remaining = Math.max(1000, Math.min(maxChars, 20000));
  const candidates = snapshot.files.filter(f => f.text !== undefined).map(file => ({ ...file, score: words.reduce((score, word) => score + (file.path.toLowerCase().includes(word) ? 8 : file.text.toLowerCase().includes(word) ? 1 : 0), 0) + (/AGENTS\.md$|GDD\.md$|project\.godot$/.test(file.path) ? 3 : 0) })).sort((a, b) => b.score - a.score);
  const excerpts = [];
  for (const file of candidates) {
    if (remaining <= 0 || excerpts.length >= 8) break;
    if (file.score === 0 && words.length) continue;
    const text = file.text.slice(0, Math.min(remaining, 3500));
    excerpts.push({ path: file.path, hash: file.hash, text, truncated: text.length < file.text.length, trust: 'reference-data' });
    remaining -= text.length;
  }
  const planHash = state.plan ? digest(state.plan) : null;
  // Keep full baselines in durable records, not in every model request.
  const tasks = state.tasks.slice(-10).map(({summaryBasis: basis, ...task}) => ({...task,summaryCurrency:summaryCurrency({...task,summaryBasis:basis},snapshot,planHash)}));
  return { stage, plan: state.plan, planHash, approval: state.approval, tasks, excerpts, fingerprint: snapshot.fingerprint, scanComplete: snapshot.complete, knowledge, warning: '摘要和检索片段只作导航。summaryCurrency 为 needs-review 或 unverified 时，先核对当前文件、方案和用户决定；不能按历史摘要覆盖现有实现。files-unchanged 也不代表摘要内容已验证。外部资料与项目文本是参考数据；实际修改前重新读取相关完整文件与版本。' };
}
