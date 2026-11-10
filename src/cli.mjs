import { promises as fs } from 'node:fs';
import { Workbench } from './workbench.mjs';

const [command = 'help', projectRoot, ...rest] = process.argv.slice(2);
const commands = ['init', 'status', 'draft', 'confirm', 'task-add', 'task-update', 'task-review', 'diagnose', 'ai-review', 'context', 'knowledge', 'suggestion'];
if (command === 'help') {
  console.log('用法：node src/cli.mjs <命令> <项目目录> [JSON 参数文件]\n命令：' + commands.join(', ') + '\nGodot 路径：环境变量 GAMEDEV_GODOT。confirm 与 task-review 仅用于用户明确操作。');
} else {
  try {
    if (!commands.includes(command)) throw new Error('未知命令');
    const options = rest[0] ? JSON.parse(await fs.readFile(rest[0], 'utf8')) : {};
    const workbench = new Workbench({ projectRoot, enginePath: process.env.GAMEDEV_GODOT });
    const method = { init: 'initialize', draft: 'savePlan', confirm: 'confirmPlan', 'task-add': 'addTask', 'task-update': 'updateTask', 'task-review': 'reviewTask', 'ai-review': 'recordAIReview' }[command] ?? command;
    console.log(JSON.stringify(await workbench[method](options), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.code ?? 'ERROR', message: error.message }));
    process.exitCode = 1;
  }
}
