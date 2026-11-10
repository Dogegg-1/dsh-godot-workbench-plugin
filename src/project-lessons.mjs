import { digest, fault, now } from './storage.mjs';
import { reportSourceHash } from './development-reports.mjs';

const categories = ['engine', 'design', 'engineering', 'feel', 'production'];
export function lessonCandidates(state) {
  const local = (state.developmentReports ?? []).flatMap(report => (report.analysis?.findings ?? []).filter(finding => finding.kind === 'lesson').map(finding => {
    const key = `${report.id}:${finding.id}`;
    const sourceHash = digest({ source: reportSourceHash(report), analysis: report.analysis });
    const review = state.lessonReviews?.find(item => item.key === key);
    const stale = report.analysis.sourceHash !== reportSourceHash(report) || Boolean(review && review.sourceHash !== sourceHash);
    return { updatedAt: report.analysis.at, key, reportId: report.id, findingId: finding.id, sourceHash, reviewHash: digest(review ?? null), title: finding.title, detail: finding.detail, certainty: finding.certainty, evidenceRefs: finding.evidenceRefs, stale, review: review ?? null };
  }));
  return [...local, ...(state.importedLessons ?? []).map(item => {
    const review = state.lessonReviews?.find(record => record.key === item.key);
    return { ...item, review: review ?? null, reviewHash: digest(review ?? null), stale: false, imported: true, certainty: 'reported', evidenceRefs: [], title: item.lesson.title, detail: item.lesson.content };
  })];
}

// Human review is deliberately not registered as an AI tool.
export function reviewLesson(state, { key, sourceHash, reviewHash, action, title, content, category, applicability, verification, limitations }) {
  const candidate = lessonCandidates(state).find(item => item.key === key);
  if (!candidate) throw fault('UNKNOWN_LESSON', '经验来源已被新版分析替换，请重新查看候选');
  if (reviewHash !== candidate.reviewHash) throw fault('STALE_LESSON_REVIEW', '审核记录已变化，请刷新后核对，不覆盖后续修改');
  if (!['approve', 'revoke'].includes(action)) throw fault('INVALID_ACTION', '请选择纳入本项目检索或撤回');
  const reviews = state.lessonReviews ??= [];
  const existing = reviews.find(item => item.key === key);
  if (action === 'approve') {
    if (candidate.stale || sourceHash !== candidate.sourceHash) throw fault('STALE_LESSON', '复盘来源已更新，先重新分析并核对经验');
    for (const [name, value, max] of [['标题', title, 120], ['经验内容', content, 2000], ['适用条件与版本', applicability, 1000], ['实际验证', verification, 2000], ['边界与反例', limitations, 1000]]) {
      if (typeof value !== 'string' || !value.trim() || value.length > max) throw fault('INVALID_LESSON', `${name}需填写，且不超过${max}字`);
    }
    if (!categories.includes(category)) throw fault('INVALID_LESSON', '请选择知识分类');
  }
  const record = { key, sourceHash: candidate.sourceHash, status: action === 'approve' ? 'approved' : 'revoked', at: now(), actor: 'local-user', ...(action === 'approve' ? { title: title.trim(), content: content.trim(), category, applicability: applicability.trim(), verification: verification.trim(), limitations: limitations.trim() } : {}) };
  if (existing) { record.history = [...(existing.history ?? []), { ...existing, history: undefined }]; reviews.splice(reviews.indexOf(existing), 1, record); }
  else reviews.push(record);
  return record;
}

export function projectLessonEntries(state) {
  const candidates = lessonCandidates(state);
  const automatic = candidates.filter(item => !item.imported && !item.stale && !item.review && item.certainty !== 'hypothesis' && item.evidenceRefs.length).map(item => ({
    id: `project-${digest(item.key).slice(0, 32)}`, title: item.title,
    content: `自动提炼 · 未经人工核对：${item.detail}`, category: 'engineering',
    stages: ['intake', 'plan', 'implement', 'diagnose', 'verify', 'finish'], tags: [item.title],
    version: '仅适用于来源项目记录，复用前核对版本和条件',
    verification: { status: 'project-auto-extracted' }, source: `project-report:${item.reportId}`,
    localProject: true, updatedAt: item.updatedAt, sourceHash: item.sourceHash,
    body: `# ${item.title}\n\n${item.detail}\n\n自动提炼，未独立复验。引用仅用于追溯，不证明根因或通用性。复用前核对适用条件和当前工程。\n来源报告：${item.reportId}\n来源引用：${item.evidenceRefs.join('、')}`,
  }));
  return [...automatic, ...candidates.filter(item => item.review?.status === 'approved' && !item.stale).map(item => {
    const review = item.review;
    const body = `# ${review.title}\n\n${review.content}\n\n## 适用条件与版本\n${review.applicability}\n\n## 用户记录的验证\n${review.verification}\n\n## 边界与反例\n${review.limitations}\n\n来源报告：${item.reportId}\n来源引用：${item.evidenceRefs.join('、') || '无直接引用，需核对原始依据'}\n\n${item.imported ? '来自手动导入的经验包；来源是提供者声明，当前项目未独立复验，无法自动获知来源撤回或更新。' : ''}仅本项目人工审核记录，不代表工具独立复验，不自动推广到其他项目。`;
    return { id: `project-${digest(item.key).slice(0, 32)}`, title: review.title, content: review.content, category: review.category, stages: ['intake', 'plan', 'implement', 'diagnose', 'verify', 'finish'], tags: [review.title, review.applicability], version: review.applicability, verification: { status: 'project-reviewed' }, updatedAt: review.at, source: `project-report:${item.reportId}`, localProject: true, body, sourceHash: item.sourceHash };
  })];
}

const shareFields = { title: 120, content: 2000, category: 30, applicability: 1000, verification: 2000, limitations: 1000 };
function shareLesson(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(shareFields, key))) throw fault('INVALID_LESSON_PACKAGE', '经验包只能包含约定的公开字段');
  const result = {};
  for (const [key, max] of Object.entries(shareFields)) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > max) throw fault('INVALID_LESSON_PACKAGE', '经验字段缺失或过长');
    result[key] = input[key].trim().normalize('NFC');
  }
  if (!categories.includes(result.category)) throw fault('INVALID_LESSON_PACKAGE', '经验分类不受支持');
  return result;
}
// Heuristics catch common leaks, not every private name or unpublished design.
export function lessonPrivacyRisks(lesson) {
  const text = Object.values(lesson).join('\n');
  const rules = [
    ['本机绝对路径', /(?:[a-z]:[\\/]|\\\\[^\s\\]+\\|\/(?:Users|home|tmp|var)\/)/i],
    ['邮箱地址', /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i],
    ['疑似凭据', /(?:\b(?:sk|gh[pousr]|github_pat)[_-][\w-]{8,}|\b(?:api[_ -]?key|password|(?:access[_ -]?|refresh[_ -]?)?token|secret|authorization)["']?\s*[:=]\s*["']?\S+|Bearer\s+\S+|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----)/i],
    ['网络地址（请改为公开来源名称）', /(?:https?:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b)/i],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}
function requirePublicLesson(input) {
  const lesson = shareLesson(input), risks = lessonPrivacyRisks(lesson);
  if (risks.length) throw fault('LESSON_PRIVACY_RISK', `请先脱敏：${risks.join('、')}。规则不能替代人工检查。`);
  return lesson;
}
export function exportLesson(state, { key, sourceHash, reviewHash, lesson, privacyConfirmed }) {
  const candidate = lessonCandidates(state).find(item => item.key === key);
  if (!candidate || candidate.stale || candidate.review?.status !== 'approved' || candidate.sourceHash !== sourceHash || candidate.reviewHash !== reviewHash) throw fault('STALE_LESSON', '仅可导出当前已审核经验，请刷新后核对');
  if (privacyConfirmed !== true) throw fault('LESSON_CONFIRMATION_REQUIRED', '请确认有权分享且已去除私有信息');
  const selected = requirePublicLesson(lesson);
  const payload = { format: 'dsh-game-lesson', version: 1, lesson: selected, provenance: { reportId: candidate.reportId, sourceHash: candidate.sourceHash } };
  return { ...payload, checksum: digest(payload) };
}
export function inspectLessonPackage(input) {
  if (!input || JSON.stringify(input).length > 16000 || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['format', 'version', 'lesson', 'provenance', 'checksum'].includes(key)) || input.format !== 'dsh-game-lesson' || input.version !== 1) throw fault('INVALID_LESSON_PACKAGE', '不支持的经验包格式或大小');
  const lesson = requirePublicLesson(input.lesson), p = input.provenance;
  if (!p || Object.keys(p).sort().join(',') !== 'reportId,sourceHash' || typeof p.reportId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(p.reportId) || typeof p.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.sourceHash)) throw fault('INVALID_LESSON_PACKAGE', '来源标识格式不正确');
  const payload = { format: input.format, version: input.version, lesson, provenance: { reportId: p.reportId, sourceHash: p.sourceHash } };
  if (input.checksum !== digest(payload)) throw fault('INVALID_LESSON_PACKAGE', '经验包已修改或校验不一致，请重新导出');
  return { ...payload, checksum: input.checksum, key: `shared-${digest(lesson)}` };
}
export function importLesson(state, { package: input, privacyConfirmed }) {
  if (privacyConfirmed !== true) throw fault('LESSON_CONFIRMATION_REQUIRED', '请核对内容并确认导入');
  const item = inspectLessonPackage(input), list = state.importedLessons ??= [];
  const existing = list.find(record => record.key === item.key);
  if (existing) return { key: existing.key, duplicate: true };
  list.push({ key: item.key, lesson: item.lesson, reportId: item.provenance.reportId, sourceHash: item.checksum, importedAt: now(), provenance: item.provenance });
  return { key: item.key, duplicate: false };
}
