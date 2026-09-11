/* views/ai-debug.js — AI 调试台：右下角 CMD 风格小窗，展示模型交互全轨迹
   （发送的消息 / 原始响应 / 耗时 / 校验与重试过程）。
   由 generate.js 在生成开始 / 结束时调用；面板惰性创建，可最小化与关闭。 */

import { esc } from "../utils.js";

let panel = null;
let bodyEl = null;

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.className = "ai-debug";
  panel.setAttribute("role", "log");
  panel.setAttribute("aria-label", "AI 调试台");
  panel.innerHTML = `
    <div class="ai-debug-titlebar">
      <span class="ai-debug-icon" aria-hidden="true">C:\\&gt;</span>
      <span class="ai-debug-title">ai-debug — 模型交互轨迹</span>
      <span class="ai-debug-btns">
        <button type="button" class="ai-debug-btn" data-act="min" aria-label="最小化">—</button>
        <button type="button" class="ai-debug-btn" data-act="close" aria-label="关闭">×</button>
      </span>
    </div>
    <div class="ai-debug-body"></div>`;
  document.body.appendChild(panel);
  bodyEl = panel.querySelector(".ai-debug-body");
  panel.querySelector('[data-act="min"]').addEventListener("click", () => {
    panel.classList.toggle("is-min");
  });
  panel.querySelector('[data-act="close"]').addEventListener("click", () => {
    panel.classList.add("is-hidden");
  });
  return panel;
}

function line(text, cls = "") {
  const div = document.createElement("div");
  div.className = `ai-line ${cls}`.trim();
  div.textContent = text;
  bodyEl.appendChild(div);
  return div;
}

function block(label, text) {
  const det = document.createElement("details");
  det.className = "ai-block";
  det.innerHTML = `<summary><span class="ai-mark" aria-hidden="true">▸</span> ${esc(label)}</summary><pre>${esc(text)}</pre>`;
  det.addEventListener("toggle", () => {
    det.querySelector(".ai-mark").textContent = det.open ? "▾" : "▸";
  });
  bodyEl.appendChild(det);
}

/* 生成开始：弹出窗口，显示请求目标与等待状态 */
export function aiDebugBegin(url) {
  const p = ensurePanel();
  p.classList.remove("is-hidden", "is-min");
  bodyEl.innerHTML = "";
  line(`$ POST ${url}`, "cmd");
  line("… 请求已发出，等待模型响应（长文生成通常 10–60s）", "pending");
}

/* 生成结束：用后端 debug 轨迹渲染完整交互过程 */
export function aiDebugEnd(debug, ok, errMsg) {
  ensurePanel();
  bodyEl.innerHTML = "";
  if (!debug) {
    line("$ 未返回调试轨迹", "dim");
    if (errMsg) line(`✗ ${errMsg}`, "err");
    return;
  }
  line(`$ provider : ${debug.provider_name || "?"} (${debug.provider || "?"})`);
  line(`$ model    : ${debug.model || "?"}`);
  line(`$ base_url : ${debug.base_url || "?"}`);
  line(`$ level    : ${debug.level || "?"} · 来源 ${debug.source || "original"}`);
  line(`$ params   : ${JSON.stringify(debug.params || {})}`);
  line(`$ words    : ${(debug.words || []).join(", ") || "(无)"}`);
  if (debug.fail) {
    line(`✗ ${debug.fail}`, "err");
    return;
  }
  const attempts = debug.attempts || [];
  attempts.forEach((a) => {
    line("", "dim");
    line(`── 第 ${a.n} 次请求 ${a.elapsed_ms != null ? `· ${(a.elapsed_ms / 1000).toFixed(1)}s` : ""} ──`, "dim");
    (a.messages || []).forEach((m) => {
      const c = String(m.content || "");
      block(`[${m.role}] ${c.length} 字符`, c);
    });
    if (a.error) {
      line(`✗ ${a.error}`, "err");
    } else if (a.raw != null) {
      block(`模型响应 · ${String(a.raw).length} 字符（点击展开原始输出）`, String(a.raw));
      line("✓ 结构校验通过", "ok");
    }
  });
  if (ok) line("✓ 生成成功，结果已交付", "ok");
  else if (errMsg && !attempts.some((a) => a.error)) line(`✗ ${errMsg}`, "err");
  bodyEl.scrollTop = bodyEl.scrollHeight;
}
