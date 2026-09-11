/* utils.js — 共享工具：转义 / 目标词加粗 / 时间戳 / toast / 词条展示格式 */

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

/* 把 **目标词** 渲染为金色加粗（先转义再包裹，防注入） */
export function formatBold(text) {
  return esc(text).replace(/\*\*([^*]+)\*\*/g, '<strong class="tw">$1</strong>');
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* 统一时间戳机制：所有本地数据统一使用 ISO 8601 字符串（UTC），
   由 nowIso() 生成、parseStamp/formatStamp 统一解析与展示。 */
export const nowIso = () => new Date().toISOString();

export function parseStamp(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date;
}

export function pad2(number) {
  return String(number).padStart(2, "0");
}

/* formatStamp(value, prefix) → "前缀 YYYY.MM.DD HH:MM"，无效值返回 null 由调用方兜底 */
export function formatStamp(value, prefix = "") {
  const date = parseStamp(value);
  if (!date) return null;
  return `${prefix}${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------------- 词条展示格式（词库 / 单词本 / 池子共用） ---------------- */

export function wordbookPos(pos) {
  const value = String(pos || "").toLowerCase();
  if (value.startsWith("adj")) return "adj.";
  if (value.startsWith("adv")) return "adv.";
  if (value.startsWith("n")) return "n.";
  if (value.startsWith("v")) return "v.";
  return pos || "词汇";
}

export function wordbookMeaning(word) {
  const parts = String(word.meaning_cn || word.meaning || "暂无释义").split(/[；;，,、/]/).map((part) => part.trim()).filter(Boolean);
  return parts.slice(0, 3).join("；") + (parts.length > 3 ? "…" : "");
}

/* 展示层全部走 formatStamp/parseStamp，保证同一时间戳在全站显示一致 */
export const formatSavedAt = (value) => formatStamp(value, "收藏于 ") || "收藏时间未知";
export const wordbookDate = parseStamp;
export function formatWordbookDate(value) {
  const date = parseStamp(value);
  if (!date) return "时间未记录";
  return `${date.getFullYear()}年${pad2(date.getMonth() + 1)}月${pad2(date.getDate())}日`;
}
export function formatWordbookTime(value) {
  const date = parseStamp(value);
  if (!date) return "—";
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/* ---------------- 打卡日期 ---------------- */

export function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function dateLabel(key) {
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return key;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/* ---------------- 头像 ---------------- */

/* 头像：预设字符或用户上传的图片（data URL）。 */
export function avatarMarkup(value) {
  const val = value || "学";
  return String(val).startsWith("data:")
    ? `<img class="avatar-img" src="${esc(val)}" alt="头像">`
    : esc(val);
}

/* 上传头像 → 等比缩放到 256px、JPEG 压缩，避免大图拖慢加密同步。 */
export function fileToAvatar(file, max = 256) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("解析图片失败"));
      img.onload = () => {
        try {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        } catch (e) {
          reject(e);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
