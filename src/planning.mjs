import { digest, fault, now } from './storage.mjs';
import { gddSections, prototypeBriefPolicy } from './lifecycle-schema.mjs';

const required = [
  ['concept', '这款游戏的一句话概念是什么？'],
  ['experience', '希望玩家主要体验什么？例如成长、探索或操作挑战。'],
  ['coreLoop', '玩家反复做什么，怎样获得反馈并进入下一轮？'],
  ['platform', '本阶段在哪个平台运行，用什么方式操作？'],
];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const validList = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
const undecided = /^(?:待定|未定|未确定|暂未确定|不确定|待明确|待补充|待确认|待讨论|待设计|稍后再定|之后再说|暂不明确|先空着|随便|同上|暂无|未知|TBD|TODO)[\s。！!？?….]*$/iu;
const specific = value => nonempty(value) && !undecided.test(value.trim());
const distinctCriteria = list => validList(list) && list.every(specific) && new Set(list.map(value => value.trim().replace(/[。！!？?.]+$/u, ''))).size >= 2;

export function normalizePlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('INVALID_PLAN', '方案必须是对象');
  const plan = {};
  for (const key of ['title', ...required.map(([k]) => k), 'visualDirection', 'savePolicy']) {
    if (input[key] !== undefined && typeof input[key] !== 'string') throw fault('INVALID_PLAN', `${key} 必须为文字`);
    plan[key] = (input[key] ?? '').trim();
  }
  for (const key of ['inScope', 'outOfScope', 'acceptance', 'assumptions', 'blockingQuestions']) {
    const value = input[key] ?? [];
    if (!Array.isArray(value) || !value.every(nonempty)) throw fault('INVALID_PLAN', `${key} 必须为非空文字组成的列表`);
    plan[key] = value.map(x => x.trim());
  }
  if (input.gdd !== undefined) {
    if (!input.gdd || typeof input.gdd !== 'object' || Array.isArray(input.gdd) || Object.keys(input.gdd).some(key => !Object.hasOwn(gddSections, key))) throw fault('INVALID_GDD', '设计详情包含未知章节');
    const gdd = {};
    for (const key of Object.keys(gddSections)) {
      const value = input.gdd[key];
      if (value !== undefined && (typeof value !== 'string' || value.length > 8000)) throw fault('INVALID_GDD', `${gddSections[key]}需为不超过8000字的文字`);
      if (value?.trim()) gdd[key] = value.trim();
    }
    // Optional detail must not invalidate legacy approvals merely by being absent.
    if (Object.keys(gdd).length) plan.gdd = gdd;
  }
  if (input.milestones !== undefined) {
    if (!Array.isArray(input.milestones) || input.milestones.length > 20) throw fault('INVALID_MILESTONES', '项目阶段需为最多20项的列表');
    const ids = new Set();
    const milestones = input.milestones.map(item => {
      if (!item || typeof item !== 'object' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(item.id ?? '') || ids.has(item.id)) throw fault('INVALID_MILESTONES', '阶段标识需唯一，以字母开头，只含字母、数字、下划线或连字符');
      ids.add(item.id);
      if (![item.title, item.goal, item.deliverable].every(nonempty)) throw fault('INVALID_MILESTONES', '每个阶段需填写名称、目标和产物');
      const acceptanceItems = validateAcceptanceItems(plan, item.acceptanceItems);
      if (!acceptanceItems.length) throw fault('INVALID_MILESTONES', '阶段需关联至少一个方案验收条件');
      return { id: item.id, title: item.title.trim(), goal: item.goal.trim(), deliverable: item.deliverable.trim(), acceptanceItems };
    });
    // Empty/absent milestones preserve legacy plan hashes and confirmations.
    if (milestones.length) plan.milestones = milestones;
  }
  if (JSON.stringify(plan).length > 60000) throw fault('PLAN_TOO_LARGE', '方案过长，请拆分阶段');
  return plan;
}

export function assessPlan(plan, policy) {
  const brief = policy === prototypeBriefPolicy;
  const basis = brief ? { policy } : {};
  if (!plan) return { ...basis, ready: false, questions: ['请描述游戏概念和想验证的核心体验。'], missing: ['plan'] };
  const decided = brief ? specific : nonempty;
  const issues = required.filter(([key]) => !decided(plan[key]));
  if (!decided(plan.title)) issues.push(['title', '给项目取一个临时名称即可。']);
  if (brief) {
    if (!specific(plan.visualDirection)) issues.push(['visualDirection', '原型用什么画面风格？也可以明确选择纯色或灰盒占位。']);
    if (!specific(plan.gdd?.progression)) issues.push(['gdd.progression', '第一轮玩家要达成什么目标，怎样知道成功或结束？']);
    if (!specific(plan.gdd?.content)) issues.push(['gdd.content', '第一版能玩到哪些代表内容？例如一个关卡、一个对手或一轮升级。']);
  }
  if (!validList(plan.inScope) || (brief && !plan.inScope.every(specific))) issues.push(['inScope', '当前原型必须完成哪些功能？']);
  if (!validList(plan.outOfScope) || (brief && !plan.outOfScope.every(specific))) issues.push(['outOfScope', '当前明确先不做什么？没有排除项也请明确写出。']);
  if (brief ? !distinctCriteria(plan.acceptance) : !validList(plan.acceptance)) {
    issues.push(['acceptance', brief ? '写出两条不同的试玩结果，覆盖正常操作和一个需要核对的边界。' : '试玩时看到哪些结果，才算当前阶段完成？']);
  }
  if (plan.milestones?.length) {
    const mapped = new Set(plan.milestones.flatMap(item => item.acceptanceItems));
    const missing = plan.acceptance.map((_, index) => index + 1).filter(number => !mapped.has(number));
    if (missing.length) issues.push(['milestones', `验收条件 ${missing.join('、')} 尚未安排到项目阶段，请补齐或调整阶段范围。`]);
  }
  for (const q of plan.blockingQuestions ?? []) issues.push(['blockingQuestions', q]);
  return { ...basis, ready: issues.length === 0, missing: [...new Set(issues.map(([k]) => k))], questions: issues.slice(0, 3).map(([, q]) => q), remainingQuestions: Math.max(0, issues.length - 3) };
}

export function approvalValid(state) {
  return Boolean(state.plan && state.approval && state.approval.planHash === digest(state.plan) && assessPlan(state.plan, state.planningPolicy).ready);
}

export function validateAcceptanceItems(plan, items = []) {
  if (!Array.isArray(items) || new Set(items).size !== items.length || items.some(number => !Number.isInteger(number) || number < 1 || number > (plan?.acceptance.length ?? 0))) throw fault('INVALID_ACCEPTANCE_ITEMS', '验收条件编号需为当前方案中从1开始、不重复的有效编号');
  return [...items].sort((a, b) => a - b);
}

export function acceptanceCoverage(state, snapshot) {
  const hash = state.plan ? digest(state.plan) : null;
  const tasks = state.tasks.filter(task => task.planHash === hash);
  const items = (state.plan?.acceptance ?? []).map((text, index) => {
    const number = index + 1;
    const planned = tasks.filter(task => task.acceptanceItems?.includes(number));
    const reviewed = tasks.filter(task => task.status === 'accepted' && task.review?.accepted === true && task.review.executionId === task.execution?.id && task.review.coveredAcceptance?.includes(number));
    const reviewedTasks = reviewed.map(task => {
      const basis = task.review.basis;
      const currency = !snapshot ? 'not-compared' : !basis || !basis.scanComplete || !snapshot.complete ? 'unverified' : basis.planHash !== hash || basis.fingerprint !== snapshot.fingerprint ? 'changed' : 'files-unchanged';
      return { id: task.id, title: task.title, currency };
    });
    return { number, text, plannedTasks: planned.map(task => ({ id: task.id, title: task.title })), reviewedTasks, current: reviewedTasks.some(task => task.currency === 'files-unchanged'), status: reviewed.length ? 'reviewed' : planned.length ? 'planned' : 'unmapped' };
  });
  return { items, total: items.length, reviewed: items.filter(item => item.status === 'reviewed').length, current: items.filter(item => item.current).length, needsReview: items.filter(item => item.status === 'reviewed' && !item.current).length, complete: items.length > 0 && items.every(item => item.current), note: '人工通过记录保留；文件变化、旧记录缺少基线或扫描不完整时需要重新核对。文件相同也不代表已独立验证所有功能。' };
}

export function requireApproval(state) {
  if (!approvalValid(state)) throw fault('PLAN_NOT_CONFIRMED', '当前方案尚未由用户确认，或确认后方案已改变；请先展示当前 GDD 与计划');
}

export function milestoneProgress(state, snapshot) {
  const hash = state.plan ? digest(state.plan) : null;
  const approved = approvalValid(state);
  return (state.plan?.milestones ?? []).map(milestone => {
    const tasks = state.tasks.filter(task => task.planHash === hash && task.milestoneId === milestone.id);
    const coverage = acceptanceCoverage({ plan: state.plan, tasks }, snapshot);
    const items = coverage.items.filter(item => milestone.acceptanceItems.includes(item.number));
    const complete = approved && tasks.length > 0 && tasks.every(task => task.status === 'accepted') && items.length > 0 && items.every(item => item.current);
    const status = !approved ? 'unconfirmed' : !tasks.length ? 'unplanned' : complete ? 'complete' : tasks.some(task => ['failed','cancelled'].includes(task.status)) ? 'needs-attention' : tasks.some(task => task.status === 'running') ? 'running' : tasks.every(task => task.status === 'accepted') ? 'needs-review' : tasks.some(task => task.status === 'awaiting-review') ? 'awaiting-review' : 'planned';
    return { ...milestone, status, complete, taskIds: tasks.map(task => task.id), taskCount: tasks.length, acceptance: items };
  });
}

export function recordConfirmation(state, { planHash, statement, developmentMode = 'stepwise' }) {
  if (!['stepwise', 'continuous'].includes(developmentMode)) throw fault('INVALID_DEVELOPMENT_MODE', '请选择连续制作或逐项确认');
  const assessment = assessPlan(state.plan, state.planningPolicy);
  if (!assessment.ready) throw fault('PLAN_INCOMPLETE', assessment.policy ? assessment.questions.join(' ') : '先解决核心体验、范围与验收中的缺失项');
  if (planHash !== digest(state.plan)) throw fault('STALE_PLAN', '方案已改变，请重新查看后确认');
  if (!nonempty(statement)) throw fault('MISSING_CONFIRMATION', '需要用户明确的确认记录');
  state.approval = { planHash, statement: statement.trim(), at: now(), actor: 'local-user', developmentMode };
}

const list = values => values.length ? values.map(x => `- ${x}`).join('\n') : '- 待明确';
export function renderDocuments(plan, progress) {
  const p = plan ?? normalizePlan({});
  const hash = digest(p);
  const labels = { pending: '待实施', running: '进行中', 'awaiting-review': '待人工验收', accepted: '已记录人工通过', failed: '失败待处理', cancelled: '已停止待核查' };
  const phases = { intake: '澄清需求', plan: '确认方案', implement: '制作', diagnose: '检查中', verify: '验证与验收', finish: '当前方案验收条件已覆盖' };
  const currentTasks = (progress?.tasks ?? []).filter(task => task.planHash === hash);
  const tasksById = new Map(currentTasks.map(task => [task.id, task]));
  const taskText = currentTasks.map((task, index) => {
    const dependencies = (task.dependsOn ?? []).map(id => {
      const dependency = tasksById.get(id);
      return dependency ? `${dependency.title}（${labels[dependency.status] ?? '未知状态'}）` : '依赖不属于当前方案或记录缺失';
    });
    return `### ${index + 1}. ${task.title}\n\n状态：${labels[task.status] ?? '未知状态'}\n\n完成标准：${task.acceptance || '未记录'}\n\n依赖：${dependencies.join('；') || '无已登记依赖'}\n\n关联验收条件：${task.acceptanceItems?.join('、') || '尚未关联'}\n`;
  }).join('\n');
  const coverage = progress?.coverage;
  const coverageText = coverage?.items?.map(item => `${item.number}. ${item.text} — ${item.current ? '已有当前文件基线下的人工通过记录' : item.status === 'reviewed' ? '历史通过，需重新核对' : item.status === 'planned' ? '已有任务，尚未人工通过' : '尚未关联任务'}`).join('\n');
  const milestoneText = p.milestones?.length ? '## 项目阶段安排\n\n' + p.milestones.map((item,index) => `### ${index + 1}. ${item.title}\n\n目标：${item.goal}\n\n产物：${item.deliverable}\n\n验收条件编号：${item.acceptanceItems.join('、')}\n`).join('\n') + '\n' : '';
  const actualProgress = progress ? `## 当前执行情况\n\n当前环节：${phases[progress.phase] ?? '未提供'}。方案${progress.approved ? '已确认' : '尚未确认'}。\n\n## 当前方案任务\n\n${taskText || '尚未登记任务；范围清单不等于已安排实施。'}\n\n## 验收覆盖\n\n${coverageText || '当前未提供覆盖检查，不能据任务状态推定通过。'}\n\n任务通过记录与当前文件有效性分开判断；完整证据见任务及诊断页。历史方案任务不计入本次执行清单。\n\n` : '## 当前执行情况\n\n本视图仅含方案，未读取任务及当前文件基线，不提供实际进度判断。\n\n';
  return {
    gdd: `# ${p.title || '未命名项目'} 游戏设计文档\n\n方案校验值：${hash}\n\n## 核心体验\n\n${p.concept || '待明确'}\n\n体验目标：${p.experience || '待明确'}\n\n核心循环：${p.coreLoop || '待明确'}\n\n平台与输入：${p.platform || '待明确'}\n\n## 当前范围\n\n${list(p.inScope)}\n\n## 当前不做\n\n${list(p.outOfScope)}\n\n## 验收标准\n\n${list(p.acceptance)}\n\n## 视觉与存档\n\n视觉：${p.visualDirection || '待后续明确，不视为已确认风格'}\n\n存档：${p.savePolicy || '未确定'}\n\n${Object.entries(gddSections).filter(([key]) => p.gdd?.[key]).map(([key,label]) => `## ${label}\n\n${p.gdd[key]}\n\n`).join('')}## 假设\n\n${list(p.assumptions)}\n\n## 阻塞性问题\n\n${p.blockingQuestions.length ? list(p.blockingQuestions) : '暂无已记录的阻塞问题，仍需用户确认方案。'}\n`,
    developmentPlan: `# ${p.title || '未命名项目'} 开发计划\n\n关联方案：${hash}\n\n${milestoneText}${actualProgress}## 通用流程参考（不是项目里程碑记录）\n\n1. 概念与范围确认：明确核心体验及排除项。\n2. GDD 与计划：解决阻塞问题，由用户确认当前方案。\n3. 原型制作：按已确认范围逐个实施，每个任务关联验收项。\n4. 功能验证：检查当前行为、已有功能和可编辑性。\n5. 用户试玩：记录结果、调整决定和未覆盖项。\n\n## 本阶段产物\n\n${list(p.inScope)}\n\n## 退出条件\n\n${list(p.acceptance)}\n\n## 规则\n\n- 此文档由结构化方案生成；修改方案后重新确认受影响范围。\n- 时间估计未提供，不虚构完成日期。\n- 生成文档不等于用户已经确认。\n- 功能实现、自动检查和人工验收分别记录。\n`,
  };
}
