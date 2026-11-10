import { randomUUID } from 'node:crypto';
// A process-local identity supplements the PID. Never treat an uncertain PID
// check as proof that another execution has stopped.
const instance = globalThis[Symbol.for('xingyou.workbench.execution')] ??= randomUUID();
export function newExecution(sessionId) {
  return { id: randomUUID(), pid: process.pid, instance, sessionId: typeof sessionId === 'string' ? sessionId : null, startedAt: new Date().toISOString() };
}
export function executionHealth(task) {
  if (task.status !== 'running') return null;
  const run = task.execution;
  if (!run || !Number.isSafeInteger(run.pid) || run.pid <= 0) return { taskId: task.id, state: 'unknown', message: '旧任务没有执行来源记录，请核对对应会话后恢复。' };
  if (run.pid === process.pid && run.instance === instance) return { taskId: task.id, state: 'host-alive', message: '执行宿主仍在运行；任务是否继续执行需核对对应会话。' };
  try { process.kill(run.pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return { taskId: task.id, state: 'interrupted', message: '原执行宿主已经退出，任务中断。已有文件和证据已保留，尚未自动重试。' };
    return { taskId: task.id, state: 'unknown', message: '无法确认原执行宿主是否结束，请核对对应会话后恢复。' };
  }
  return { taskId: task.id, state: 'unknown', message: '原进程编号仍存在，不能据此认定原任务已停止，请核对对应会话。' };
}
