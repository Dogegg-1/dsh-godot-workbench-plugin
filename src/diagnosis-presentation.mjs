import { fault } from './storage.mjs';

// Source-reading guidance, not a new claim or evidence of successful execution.
export function diagnosisExplanationBounds(issue) {
  const limits = [
    '影响仅限原问题及其证据覆盖的操作；未检查不等于失败，局部失败不等于整个项目无法使用。',
    '保留条件、否定和不确定性；不要从文件名猜参数含义，不补工期或体验结论。',
    '下一步只针对这条问题，不写整个项目“只差这一步”或已经可交付。',
  ];
  if (issue.category !== 'confirmed') limits.push('这是风险或假设，展示说明不能改写为已经发生的故障。');
  if (issue.code === 'NO_MAIN_SCENE') limits.push('当前证据仅说明未识别到项目主入口配置。可以说正常项目入口需设置；本次未测试单独场景或其他入口，不可断言所有玩法或画面都无法运行或验证。');
  if (issue.code === 'MAIN_SCENE_NOT_FOUND' || issue.code === 'SCAN_INCOMPLETE') limits.push('本次未找到或未读取的文件可能超出扫描范围，不能直接判断文件丢失或损坏。');
  if (issue.code === 'ENGINE_UNAVAILABLE') limits.push('当前工具未连接可用引擎，不等于用户电脑没有Godot或游戏自身有错误。');
  return limits;
}

// Display copy is independent of execution instructions. Never truncate it:
// truncation can remove a condition, a negation or the actual next action.
export function normalizeDiagnosisPresentation(value) {
  if (value === undefined) return undefined; // Historical/tool clients remain readable.
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fault('INVALID_PRESENTATION', '面向用户的说明需要 summary、impact、nextStep 三项文字');
  }
  const limits = { summary: 60, impact: 100, nextStep: 80 };
  const result = {};
  for (const [key, limit] of Object.entries(limits)) {
    const item = value[key];
    if (typeof item !== 'string' || !item.trim() || [...item.trim()].length > limit) {
      throw fault('INVALID_PRESENTATION', `${key}需要1至${limit}字；请用短句重写，不要截断原文`);
    }
    if (/`|(?:res|user):\/\/|\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b|\b[\w.-]+\.(?:gd|tscn|tres|cs|gdshader)\b|[A-Za-z]:[\\/]/i.test(item)) {
      throw fault('INVALID_PRESENTATION', `${key}含代码、路径或参数名，请用中文说明其含义，技术内容放在原始解释和建议中`);
    }
    result[key] = item.trim();
  }
  return result;
}
