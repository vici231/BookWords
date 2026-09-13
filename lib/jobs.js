/* jobs.js — 进程内异步任务表：把「长请求」改造成「短请求 + 轮询」。
   背景：AI Works 预览网关在云函数之前还有一层固定时长上限。实测把函数超时从
   3 秒提到 60 秒后，失败从「固定 3000ms 返回 ret_code 200401」变成「约 10–30 秒
   返回裸 HTTP 554」，且线上只掐长请求（/api/generate/story、/api/topics/zhihu-coverage
   等 LLM 接口），短接口正常。函数超时改不动前面那一层，所以改为：提交立即返回
   job_id，客户端用短请求轮询结果。每个 HTTP 请求都在 1 秒内，任何代理层的
   时长上限都不再适用。

   状态放进程内存：与 settings / auth / 知乎搜索缓存同一取舍（平台文件系统只读，
   不做磁盘写入）。单实例部署下有效；实例重启会丢任务，客户端拿到 404 后重提交。 */

const crypto = require("crypto");

const TTL_MS = 15 * 60 * 1000; /* 完成后保留 15 分钟，足够前端取回结果 */
const MAX_JOBS = 200;
const store = new Map();

function prune() {
  const now = Date.now();
  for (const [id, job] of store) {
    const finished = job.status !== "running";
    if (finished && now - Number(job.finished_at || job.created_at) > TTL_MS) store.delete(id);
  }
  while (store.size > MAX_JOBS) {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const [id, job] of store) {
      if (Number(job.created_at) < oldestAt) { oldestAt = Number(job.created_at); oldestId = id; }
    }
    if (oldestId === null) break;
    store.delete(oldestId);
  }
}

/* runner 必须返回 `{ status, body }`，与同步路径共用同一段逻辑，
   保证轮询取回的 body 与同步响应逐字段一致。 */
function create(kind, runner) {
  const id = crypto.randomBytes(9).toString("hex");
  const job = { id, kind, status: "running", created_at: Date.now(), finished_at: null, result: null };
  store.set(id, job);
  Promise.resolve()
    .then(runner)
    .then(
      (result) => {
        job.result = result && typeof result === "object" ? result : { status: 500, body: { ok: false, error: "任务未返回结果" } };
        job.status = "done";
        job.finished_at = Date.now();
      },
      (err) => {
        job.result = {
          status: 500,
          body: { ok: false, error: `服务器内部错误：${err && err.message ? err.message : String(err)}` },
        };
        job.status = "done";
        job.finished_at = Date.now();
      }
    )
    .then(prune, prune);
  prune();
  return job;
}

function get(id) {
  prune();
  const job = store.get(String(id || ""));
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    running: job.status === "running",
    elapsed_ms: (job.finished_at || Date.now()) - job.created_at,
    result: job.result,
  };
}

function summary() {
  let running = 0;
  for (const job of store.values()) if (job.status === "running") running += 1;
  return { jobs: store.size, running };
}

module.exports = { create, get, summary };
