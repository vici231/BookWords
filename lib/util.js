/* util.js — 共享工具：JSON 提取、内存事件追踪。
   AI Works 平台文件系统只读：一切状态内存化（用户已授权重启丢失取舍）。 */

const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");

/* AI 事件追踪：进程内环形缓冲（监控台消费；实例回收即失，可接受）。 */
const TRACE_LIMIT = 500;
const traceBuffer = [];

function trace(event, fields = {}) {
  const record = { ts: new Date().toISOString(), event: String(event).slice(0, 40) };
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    record[String(key).slice(0, 40)] =
      typeof value === "number" || typeof value === "boolean" ? value : String(value).slice(0, 220);
  }
  traceBuffer.push(record);
  if (traceBuffer.length > TRACE_LIMIT) traceBuffer.splice(0, traceBuffer.length - TRACE_LIMIT);
}

function recentTrace(limit = 100) {
  return traceBuffer.slice(-Math.max(1, Math.min(Number(limit) || 100, TRACE_LIMIT))).reverse();
}

/* 从模型输出提取 JSON：容忍代码块围栏与多余散文。 */
function extractJson(content) {
  let text = String(content || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("响应中未找到 JSON 对象");
  return JSON.parse(text.slice(start, end + 1));
}

function randomHex(bytes = 6) {
  return crypto.randomBytes(bytes).toString("hex");
}

module.exports = { ROOT, trace, recentTrace, extractJson, randomHex };
