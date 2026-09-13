/* views/diagnose.js — 一键网络诊断：把线上网关的行为变成大白话结论。
   背景：线上「几十秒才返回」的请求会被云函数前面的网关掐成裸 HTTP 554，
   而短请求正常；同时每个请求都像是独立实例（上一个请求建的 job，下一个查不到）。
   这里用服务端探针测出真实边界，用户只需点一下按钮、看一眼结果，不用开 DevTools：

     GET  /api/health?delay=<ms>          服务端延时 N 秒再应答 → 测请求时长上限
     GET  /api/health?delay=<ms>&stream=1 SSE 心跳              → 测流式是否被透传
     POST /api/config {theme} → GET /api/config                → 测进程内存是否跨请求保留
*/

import { $ } from "../utils.js";

const PROBE_TIMEOUT_MS = 40000;
const DELAYS_MS = [3000, 6000, 9000, 12000, 18000];

function write(text, cls = "") {
  const box = $("#diagnose-output");
  if (!box) return;
  const row = document.createElement("div");
  row.className = `diag-line ${cls}`.trim();
  row.textContent = text;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function blank() {
  const box = $("#diagnose-output");
  if (box) box.appendChild(document.createElement("div"));
}

async function plainProbe(url, opts = {}) {
  const started = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), ...opts });
    const body = await res.text();
    return { status: res.status, ms: Math.round(performance.now() - started), body };
  } catch (err) {
    return { status: 0, ms: Math.round(performance.now() - started), error: err.name === "TimeoutError" ? "客户端等待超时" : err.message };
  }
}

async function streamProbe(url) {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) {
      return { status: res.status, ms: Math.round(performance.now() - started), chunks: 0, firstMs: null, done: false };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let chunks = 0;
    let firstMs = null;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstMs === null) firstMs = Math.round(performance.now() - started);
      chunks += 1;
      text += decoder.decode(value, { stream: true });
    }
    return { status: res.status, ms: Math.round(performance.now() - started), chunks, firstMs, done: text.includes("event: done") };
  } catch (err) {
    return { status: 0, ms: Math.round(performance.now() - started), chunks: 0, firstMs: null, done: false, error: err.name === "TimeoutError" ? "客户端等待超时" : err.message };
  }
}

const ok = (r) => r.status === 200;
const fmtStatus = (r) => (r.status ? String(r.status) : (r.error || "无响应"));

export async function runNetworkDiagnosis() {
  const button = $("#btn-diagnose");
  const box = $("#diagnose-output");
  if (!box) return;
  box.hidden = false;
  box.innerHTML = "";
  if (button) { button.disabled = true; button.textContent = "诊断中…"; }
  write("开始诊断（约 1 分钟，请勿关闭页面）");

  try {
    blank();
    write("① 短请求（线上一直是好的）");
    const short = await plainProbe("/api/health");
    write(`   GET /api/health  →  ${fmtStatus(short)}  ${short.ms}ms  ${ok(short) ? "✅" : "❌"}`, ok(short) ? "ok" : "bad");

    blank();
    write("② 模型连通性（一次极短的 LLM 调用）");
    const llm = await plainProbe("/api/health", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    write(`   POST /api/health →  ${fmtStatus(llm)}  ${llm.ms}ms  ${ok(llm) ? "✅ 凭证可用" : "❌"}`, ok(llm) ? "ok" : "bad");

    blank();
    write("③ 请求时长上限（服务端故意等 N 秒再回答）");
    let maxOkMs = 0;
    let firstFailMs = 0;
    for (const delay of DELAYS_MS) {
      const probe = await plainProbe(`/api/health?delay=${delay}`);
      const pass = ok(probe) && probe.ms >= delay - 500;
      if (pass) maxOkMs = delay;
      else if (!firstFailMs) firstFailMs = delay;
      write(`   等待 ${delay / 1000}s →  ${fmtStatus(probe)}  ${probe.ms}ms  ${pass ? "✅ 通过" : "❌ 被掐断"}`, pass ? "ok" : "bad");
      if (!pass) break;
    }
    blank();
    if (firstFailMs) {
      write(`   ➜ 结论：只要一个请求超过约 ${maxOkMs / 1000}–${firstFailMs / 1000} 秒就会被拒绝（HTTP 554）。`, "conclusion");
    } else {
      write(`   ➜ 结论：至少 ${maxOkMs / 1000} 秒以内的请求都能正常返回。`, "conclusion");
    }

    blank();
    write("④ 流式（SSE）是否被网关透传");
    const streamDelay = firstFailMs ? Math.max(3000, firstFailMs - 3000) : DELAYS_MS[DELAYS_MS.length - 1];
    const streamed = await streamProbe(`/api/health?delay=${streamDelay}&stream=1`);
    const streamOk = streamed.status === 200 && streamed.done;
    write(`   等待 ${streamDelay / 1000}s + 心跳 →  ${fmtStatus(streamed)}  ${streamed.ms}ms  首个数据 ${streamed.firstMs == null ? "无" : streamed.firstMs + "ms"}  分片 ${streamed.chunks} 个  ${streamOk ? "✅ 流式可用" : "❌ 未透传"}`, streamOk ? "ok" : "bad");

    blank();
    write("⑤ 进程内存是否跨请求保留（登录态、自选词、任务状态都靠它）");
    const saved = await plainProbe("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: "ink" }) });
    const readBack = await plainProbe("/api/config");
    let themeAfter = "";
    try { themeAfter = JSON.parse(readBack.body).theme || ""; } catch (err) { themeAfter = ""; }
    const memoryKept = themeAfter === "ink";
    write(`   写入 ink → 再读回：${themeAfter || "读取失败"}  ${memoryKept ? "✅ 保留" : "❌ 丢失"}`, memoryKept ? "ok" : "bad");
    if (!memoryKept) write("   ➜ 说明每个请求都是独立实例，服务端内存不能用来保存任何跨请求状态。", "conclusion");
    /* 恢复用户原本的风格 */
    await plainProbe("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: "paper" }) });
    void saved;

    blank();
    write("诊断完成。请把以上内容截图发给助手。", "conclusion");
  } finally {
    if (button) { button.disabled = false; button.textContent = "重新诊断"; }
  }
}

export function bindDiagnoseEvents() {
  const button = $("#btn-diagnose");
  if (button) button.addEventListener("click", () => { runNetworkDiagnosis(); });
}
