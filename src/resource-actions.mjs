import path from 'node:path';
import { fault } from './storage.mjs';
import { requireApproval } from './planning.mjs';
import { inspectResources, readManifest, readParameters, prepareParameterText, MANIFEST, mediaExtensions, resourcePath } from './project-resources.mjs';
import { readProjectFile } from './file-changes.mjs';

async function checkEditable(workbench, token) {
  const state = await workbench.store.read(); requireApproval(state);
  if (state.tasks.some(task => task.status === 'running') || state.automaticChecks?.some(check => check.status === 'checking')) throw fault('PROJECT_BUSY', '请先结束当前任务或检查，再调整资源');
  const view = await inspectResources(workbench.root, { state });
  if (view.token !== token) throw fault('RESOURCE_CHANGED', '项目或资源已变化，请刷新并重新查看修改预览');
  if (!view.manifest.valid) throw fault('MANIFEST_INVALID', '先修复资源说明，当前没有写入任何文件');
  return view;
}
async function managedEdit(workbench, title, statement, edits, signal) {
  if (typeof statement !== 'string' || !statement.trim() || statement.length > 2000) throw fault('INVALID_INPUT', '请填写本次调整原因（1 至 2000 字）');
  signal?.throwIfAborted();
  const task = await workbench.addTask({ title, acceptance: '配置或素材按用户预览保存；重新检查导入，操作和画面保留人工验收' });
  let run;
  try {
    run = await workbench.updateTask({ taskId: task.id, action: 'start' });
    for (const edit of edits) {
      signal?.throwIfAborted();
      await workbench.fileChange({ ...edit, taskId: task.id, executionId: run.execution.id, action: 'write' });
    }
    const submitted = await workbench.updateTask({ taskId: task.id, executionId: run.execution.id, action: 'submit', summary: `${statement.trim()}；已保存：${edits.map(edit => edit.path).join('、')}。尚未人工试玩。`, evidence: edits.map(edit => ({ type: 'file', detail: `用户在工作台预览后保存 ${edit.path}；原内容已留存，可查看改动与回退。` })) }, { signal });
    return { taskId: task.id, paths: edits.map(edit => edit.path), automaticDiagnosis: submitted.automaticDiagnosis, message: '修改已保存并记录版本。请查看检查结果；游戏操作、画面和体验仍待验证。' };
  } catch (error) {
    if (run) {
      const current = await workbench.store.read();
      if (current.tasks.find(item => item.id === task.id)?.status === 'running') await workbench.updateTask({ taskId: task.id, executionId: run.execution.id, action: 'fail', summary: `资源操作未全部完成：${error.message}。已写入的内容与原版均保留，先在查看改动中核查，不自动覆盖或回退。` }, { signal }).catch(() => {});
    }
    throw fault(error.code ?? 'RESOURCE_EDIT_FAILED', `${error.message}；关联任务 ${task.id}。请在“查看改动”核查已保存部分。`);
  }
}

export async function saveParameters(workbench, { token, values, statement, signal } = {}) {
  const view = await checkEditable(workbench, token);
  const manifest = await readManifest(workbench.root);
  const parameters = await readParameters(workbench.root, manifest.data?.parameters);
  if (manifest.hash !== view.manifest.hash || parameters.hash !== view.parameters.hash) throw fault('RESOURCE_CHANGED', '预览后参数来源发生变化，请刷新再保存');
  const prepared = prepareParameterText(parameters, values);
  if (!prepared.changes.length) throw fault('NO_PARAMETER_CHANGE', '参数与当前资源一致，无需保存');
  return managedEdit(workbench, `调整参数：${prepared.changes.map(change => change.label).join('、')}`, statement, [{ path: parameters.path, expectedHash: parameters.hash, content: prepared.content }], signal);
}

export async function assetInfo(root, { path: name } = {}) {
  resourcePath(name); const ext = path.extname(name).toLowerCase();
  if (!mediaExtensions.has(ext) || ext === '.svg') throw fault('UNSUPPORTED_ASSET', '此入口支持 PNG、JPEG、WebP、OGG、WAV、TTF、OTF 和 GLB；SVG 等文本资源由受控文件修改处理');
  const file = await readProjectFile(root, { path: name });
  return { path: name, hash: file.hash, bytes: file.bytes, exists: file.hash !== 'missing', type: ext.slice(1) };
}

export async function importAsset(workbench, { token, path: name, expectedHash, content, source = '', status = 'draft', statement, signal } = {}) {
  const view = await checkEditable(workbench, token);
  const file = await assetInfo(workbench.root, { path: name });
  if (file.hash !== expectedHash) throw fault('RESOURCE_CHANGED', '目标素材已改变，请重新查看替换预览');
  if (typeof content !== 'string' || content.length > 22369624 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw fault('INVALID_ASSET', '素材需要有效 Base64 内容，最大 16 MiB');
  const bytes = Buffer.from(content, 'base64');
  if (!bytes.length || bytes.length > 16 * 1024 * 1024 || bytes.toString('base64') !== content) throw fault('INVALID_ASSET', '素材为空、超限或编码不完整');
  if (typeof source !== 'string' || source.length > 2000 || !['draft', 'implemented', 'unknown'].includes(status)) throw fault('INVALID_ASSET', '请填写来源说明和素材使用状态');
  const manifest = await readManifest(workbench.root);
  if (manifest.hash !== view.manifest.hash) throw fault('RESOURCE_CHANGED', '预览后资产清单发生变化，请刷新再保存');
  if (!manifest.data) throw fault('MANIFEST_INVALID', '先修复资产说明');
  const assets = (manifest.data.assets ?? []).filter(asset => asset.path !== name);
  assets.push({ path: name, source: source.trim() || '来源待核实', status });
  const metadata = JSON.stringify({ ...manifest.data, assets }, null, 2) + '\n';
  if (Buffer.byteLength(metadata) > 262144 || assets.length > 1000) throw fault('MANIFEST_TOO_LARGE', '资产清单超出当前容量，请先整理');
  return managedEdit(workbench, `${file.exists ? '替换' : '导入'}素材：${name}`, statement, [
    { path: name, expectedHash, content, encoding: 'base64' },
    { path: MANIFEST, expectedHash: manifest.hash, content: metadata },
  ], signal);
}
