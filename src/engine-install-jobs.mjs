import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fault } from './storage.mjs';
import { fetchGodotDownloadOffer } from './engine-download.mjs';
import { installGodotEngine } from './engine-install.mjs';

const active = job => job && ['running', 'cancelling'].includes(job.state.status);
export class EngineInstallJobs {
  constructor({ lookup = fetchGodotDownloadOffer, install = installGodotEngine } = {}) {
    this.lookup = lookup; this.install = install; this.offers = new Map(); this.jobs = new Map();
  }
  async offer(root, version, signal) {
    const offer = await this.lookup({ version, signal });
    const id = randomUUID(); const expiresAt = Date.now() + 10 * 60_000;
    for (const [key, item] of this.offers) if (item.expiresAt < Date.now()) this.offers.delete(key);
    if (this.offers.size >= 20) this.offers.delete(this.offers.keys().next().value);
    this.offers.set(id, { root, offer, expiresAt });
    // A proposed location only: querying never creates folders or starts an
    // install. The installer still exclusively creates the confirmed target.
    const label = String(offer.version).replace(/[^a-zA-Z0-9.-]/g, '-').slice(0, 60);
    const suggestedDestination = path.join(os.homedir(), `Godot-${label}-${id.slice(0, 8)}`);
    return { id, ...offer, expiresAt, suggestedDestination };
  }
  start(root, { offerId, destination, confirmed, requestId } = {}) {
    if (confirmed !== true) throw fault('CONFIRM_REQUIRED', '请先确认版本和安装目录');
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) throw fault('INVALID_REQUEST', '下载请求标识无效');
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw fault('INVALID_PATH', '安装目录需要完整路径');
    for (const job of this.jobs.values()) {
      if (job.root === root && job.requestId === requestId) {
        if (job.state.destination !== destination || job.offerId !== offerId) throw fault('REQUEST_CONFLICT', '相同下载请求的参数已改变');
        return this.snapshot(job);
      }
    }
    if ([...this.jobs.values()].some(active)) throw fault('INSTALL_BUSY', '已有安装任务，请等待完成或取消后再开始');
    const cached = this.offers.get(offerId);
    if (!cached || cached.root !== root || cached.expiresAt < Date.now()) throw fault('OFFER_EXPIRED', '版本信息已过期，请重新查询并确认');
    const id = randomUUID(); const abort = new AbortController();
    const job = { root, requestId, offerId, abort, state: { id, status: 'running', phase: 'checking-release', destination, version: cached.offer.version, startedAt: new Date().toISOString() } };
    this.jobs.set(id, job);
    if (this.jobs.size > 20) { const old = [...this.jobs].find(([, value]) => !active(value)); if (old) this.jobs.delete(old[0]); }
    job.done = Promise.resolve().then(() => this.install({ offer: cached.offer, destination, confirmed: true }, {
      signal: abort.signal, onProgress: progress => { job.state = { ...job.state, ...progress }; },
    })).then(result => { job.state = { ...job.state, status: 'installed', result }; }, error => {
      job.state = { ...job.state, status: abort.signal.aborted ? 'cancelled' : 'failed', message: abort.signal.aborted ? `安装已取消。${error.message ?? ''}` : error.message, code: error.code ?? 'INSTALL_FAILED' };
    }).finally(() => { job.state.finishedAt = new Date().toISOString(); });
    return this.snapshot(job);
  }
  snapshot(job) { return structuredClone(job.state); }
  find(root, id) {
    const job = id ? this.jobs.get(id) : [...this.jobs.values()].filter(j => j.root === root).at(-1);
    if (id && (!job || job.root !== root)) throw fault('INSTALL_NOT_FOUND', '找不到此项目的安装任务；宿主重启后请核对安装目录，不自动重试');
    return job?.root === root ? job : null;
  }
  status(root, id) { const job = this.find(root, id); return job ? this.snapshot(job) : null; }
  cancel(root, id) {
    const job = this.find(root, id);
    if (!job) throw fault('INSTALL_NOT_FOUND', '找不到安装任务');
    if (active(job)) { job.state.status = 'cancelling'; job.abort.abort(); }
    return this.snapshot(job);
  }
}
