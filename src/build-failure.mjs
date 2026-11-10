// Classify observed failure signals, not their unproven root cause.
export function classifyBuildFailure(report) {
  if (report.status === 'ready' || report.status === 'cancelled') return null;
  const stage = ['startup', 'export', 'import'].find(name => report.checks?.[name]);
  const check = report.checks?.[stage];
  if (!check) return { kind: 'preparation', stage: 'checking', next: '先核对错误提示中的缺失配置，再重新生成。' };
  if (check.timedOut) return { kind: 'timeout', stage, next: '先检查最后一段日志，确认程序停在哪一步。' };
  const code = Number(check.exitCode);
  if (Number.isInteger(code) && (code < 0 || code >= 0x80000000)) return {
    kind: 'native-exit', stage, exitCode: check.exitCode, windowsCode: `0x${(code >>> 0).toString(16).toUpperCase()}`,
    next: '先核对导出程序日志与本机引擎环境；异常退出码本身不能定位到玩法代码。',
  };
  if (check.truncated || check.fileLogTruncated || check.fileLogError) return { kind: 'incomplete-log', stage, next: '先查看完整日志，当前输出不足以判断原因。' };
  if (check.issues?.some(issue => /SCRIPT ERROR:|Parse Error/.test(issue.message))) return { kind: 'script-error', stage, next: '先修复日志指出的脚本位置，再重新生成。' };
  return { kind: 'unclassified', stage, next: '先查看失败阶段日志，确认原因后再修改。' };
}
