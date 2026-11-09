// 笔记长任务注册表（P10-⑩）：抓一条 / 搜一批都是「本机浏览器跑 10–90 秒」的长活，
// 不能再让前端干等一个卡住的请求 —— 起任务立刻拿 id，前端轮询看「跑到哪一步 + 已多少秒」，随时能取消。
//
// 只在内存里（进程重启就没了）：任务本身不写库、跑完的结果由前端取走后自己落到界面/接口，
// 所以不需要持久化；跑完的结果留 TTL 供前端取一次。
//
// 语义：
//   · 同一 kind + platform 同时只跑一个（新的顶掉旧的）—— 两个浏览器抢同一个 profile 会双双失败，
//     而且「搜两次状态互相覆盖」正是原来的毛病；
//   · cancel 立即 kill 子进程（通过 hooks.onChild 拿到的句柄），并把状态标成 canceled，结果不再采用。
const crypto = require('node:crypto');

const TTL_MS = 10 * 60 * 1000; // 跑完的结果留 10 分钟给前端取
const MAX_JOBS = 30;

function createNoteJobs(opts = {}) {
  const jobs = new Map();
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const ttlMs = Number(opts.ttlMs) || TTL_MS;
  const maxJobs = Number(opts.maxJobs) || MAX_JOBS;

  function sweep() {
    const t = now();
    for (const [id, job] of Array.from(jobs.entries())) {
      if (job.finished_at && t - job.finished_at > ttlMs) jobs.delete(id);
    }
    while (jobs.size > maxJobs) {
      const oldest = jobs.keys().next().value;
      jobs.delete(oldest);
    }
  }

  function view(job) {
    if (!job) return null;
    const end = job.finished_at || now();
    return {
      id: job.id,
      kind: job.kind,
      status: job.status, // running | done | failed | canceled
      stage: job.stage,
      started_at: job.started_at,
      elapsed_ms: Math.max(0, end - job.started_at),
      error: job.error || null,
      message: job.message || null,
      result: job.status === 'done' ? job.result : null,
    };
  }

  function get(id) {
    sweep(); // 顺手清过期的，别让内存里堆着没人取的结果
    return jobs.get(String(id || '')) || null;
  }

  function isCanceled(job) {
    return !!(job && job.handle && job.handle.canceled);
  }

  // 起一个任务：task(hooks) → Promise<result>；task 抛错就记成 failed（HttpError 带 status/code 时原样记）
  function start(kind, params, task) {
    sweep();
    const platform = String((params && params.platform) || '');
    // 单飞：同 kind + platform 的旧任务直接取消（避免两个浏览器抢同一个 profile）
    for (const job of jobs.values()) {
      if (job.status === 'running' && job.kind === kind && job.platform === platform) markCanceled(job);
    }
    const job = {
      id: 'nj_' + crypto.randomBytes(6).toString('hex'),
      kind: String(kind || ''),
      platform,
      params: params || {},
      status: 'running',
      stage: '准备中',
      started_at: now(),
      finished_at: null,
      result: null,
      error: null,
      message: null,
      handle: { child: null, canceled: false },
    };
    jobs.set(job.id, job);
    sweep(); // 加入之后再清一次：保证 size 不会超过 maxJobs

    const hooks = {
      isCanceled: () => job.handle.canceled,
      onChild: (child) => {
        job.handle.child = child;
        if (job.handle.canceled) killChild(job);
      },
      onProgress: (stage) => {
        if (!stage || job.handle.canceled) return;
        job.stage = String(stage).slice(0, 80);
      },
    };

    Promise.resolve()
      .then(() => task(hooks))
      .then((res) => {
        if (isCanceled(job)) return;
        if (res && res.ok === false) {
          job.status = 'failed';
          job.error = res.error || 'FETCH_FAIL';
          job.message = res.message || '失败';
        } else {
          job.status = 'done';
          job.result = res === undefined ? null : res;
        }
      })
      .catch((err) => {
        if (isCanceled(job)) return;
        job.status = 'failed';
        job.error = err && err.code ? String(err.code) : 'INTERNAL_ERROR';
        job.message = String((err && err.message) || err || '失败');
      })
      .then(() => {
        if (!job.finished_at) job.finished_at = now();
        job.stage = job.status === 'done' ? '完成' : job.status === 'canceled' ? '已取消' : '失败';
      });
    return job;
  }

  function killChild(job) {
    const child = job.handle && job.handle.child;
    if (!child) return;
    try {
      child.kill('SIGKILL');
    } catch (err) {
      /* 已经退出了 */
    }
  }

  function markCanceled(job) {
    if (!job || job.status !== 'running') return job;
    job.handle.canceled = true;
    job.status = 'canceled';
    job.stage = '已取消';
    job.error = 'CANCELED';
    job.message = '已取消';
    job.finished_at = now();
    killChild(job);
    return job;
  }

  function cancel(id) {
    return markCanceled(get(id));
  }

  return { start, get, cancel, view, isCanceled, size: () => jobs.size };
}

module.exports = { createNoteJobs, TTL_MS };
