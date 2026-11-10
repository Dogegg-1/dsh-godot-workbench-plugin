import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { digest, fault } from './storage.mjs';

const key = randomBytes(32); // Process-local receipts; restart requires reading the source again.
const LIMIT = 60000;
const PAGE = 8000; // JSON escaping can expand each character sixfold; response stays bounded.
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
function verify(token) {
  if (typeof token !== 'string' || token.length > 3000) throw fault('INVALID_SOURCE_CURSOR', '来源读取凭据无效，请从第一页重新读取');
  const [body, signature, extra] = token.split('.');
  const expected = createHmac('sha256', key).update(body ?? '').digest();
  const actual = Buffer.from(signature ?? '', 'base64url');
  if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw fault('INVALID_SOURCE_CURSOR', '来源读取凭据无效或服务已重启，请从第一页重新读取');
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch { throw fault('INVALID_SOURCE_CURSOR', '来源读取凭据格式无效'); }
}
function describe(source, scope) {
  const serialized = JSON.stringify(source);
  return { serialized, binding: { scope: digest(scope), id: source.id, contentHash: digest(serialized) } };
}
function matches(payload, binding) {
  return payload.scope === binding.scope && payload.id === binding.id && payload.contentHash === binding.contentHash;
}
export function readReportSource(source, scope, cursor) {
  const { serialized, binding } = describe(source, scope);
  if (!cursor && serialized.length <= LIMIT) return source;
  let offset = 0;
  if (cursor) {
    const payload = verify(cursor);
    if (!matches(payload, binding)) throw fault('STALE_REPORT', '读取期间来源已变化或项目不匹配，请从第一页重新读取');
    if (payload.kind !== 'next' || !Number.isSafeInteger(payload.offset) || payload.offset <= 0 || payload.offset >= serialized.length) throw fault('INVALID_SOURCE_CURSOR', '来源页码无效');
    offset = payload.offset;
  }
  const end = Math.min(serialized.length, offset + PAGE);
  const complete = end === serialized.length;
  return { id: source.id, revision: source.revision, sourceHash: source.sourceHash, paged: true,
    encoding: 'json-text-fragment', offset, totalCharacters: serialized.length, chunk: serialized.slice(offset, end), complete,
    nextCursor: complete ? null : sign({ ...binding, kind: 'next', offset: end }),
    sourceReadToken: complete ? sign({ ...binding, kind: 'complete' }) : null,
    note: '来源较长，chunk是完整JSON文本的顺序片段，不是独立JSON。使用nextCursor作为同一reportId的sourceCursor继续读取；按序合并所有chunk才能还原完整来源及引用。最后一页sourceReadToken提交给analyze。不得仅根据部分片段生成整阶段结论；凭据只证明各段已返回，不证明模型理解或结论正确。服务重启或来源变化需从第一页重读。',
  };
}
export function requireCompleteReportRead(source, scope, token) {
  const { serialized, binding } = describe(source, scope);
  if (serialized.length <= LIMIT) return;
  if (!token) throw fault('SOURCE_READ_INCOMPLETE', '长来源尚未完整分段读取，请读取至最后一页后提交sourceReadToken');
  const payload = verify(token);
  if (payload.kind !== 'complete') throw fault('SOURCE_READ_INCOMPLETE', '来源仍有后续页，不能保存完整结论');
  if (!matches(payload, binding)) throw fault('STALE_REPORT', '读取后来源已变化或项目不匹配，请重新读取');
}
