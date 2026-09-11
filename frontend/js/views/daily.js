/* views/daily.js — 每日打卡视图：连续天数 / 本周日历 / 打卡按钮 */

import { state } from "../state.js";
import { persist } from "../store.js";
import { $, dateKey, dateLabel, formatWordbookTime, nowIso, parseStamp, toast } from "../utils.js";

export function renderDaily() {
  const week = $("#daily-week");
  const button = $("#btn-daily-checkin");
  const today = dateKey();
  const recordMap = new Map(state.dailyRecords.map((item) => [item.date, item]));
  const checkedToday = recordMap.has(today);
  if (button) {
    button.disabled = checkedToday;
    button.querySelector(".btn-arrow")?.remove();
    if (checkedToday) button.childNodes[0].textContent = "今日已完成 ";
    else if (!button.querySelector(".btn-arrow")) button.insertAdjacentHTML("beforeend", '<span class="btn-arrow">→</span>');
  }
  let streak = 0;
  const cursor = new Date();
  while (recordMap.has(dateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  if ($("#daily-streak-count")) $("#daily-streak-count").textContent = streak;
  if ($("#daily-status-title")) $("#daily-status-title").textContent = checkedToday ? "今天已完成打卡" : "今天还没有打卡";
  if ($("#daily-status-copy")) $("#daily-status-copy").textContent = checkedToday ? "很好，保持这个节奏，明天继续遇见新单词。" : "完成一次打卡，记录你的学习节奏。";
  if (week) {
    const labels = ["一", "二", "三", "四", "五", "六", "日"];
    const items = [];
    for (let i = 6; i >= 0; i -= 1) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const key = dateKey(date);
      items.push(`<div class="daily-day ${recordMap.has(key) ? "is-done" : ""} ${key === today ? "is-today" : ""}"><span>周${labels[(date.getDay() + 6) % 7]}</span><strong>${date.getDate()}</strong><small>${recordMap.has(key) ? "已完成" : "—"}</small></div>`);
    }
    week.innerHTML = items.join("");
  }
  const latest = state.dailyRecords.slice().sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt))[0];
  if ($("#daily-last-time")) $("#daily-last-time").textContent = latest ? `最近打卡：${dateLabel(latest.date)} · ${formatWordbookTime(latest.checkedAt)}` : "最近打卡：—";
}

export function checkInToday() {
  const today = dateKey();
  if (state.dailyRecords.some((item) => item.date === today)) {
    toast("今天已经打卡完成");
    return;
  }
  const now = nowIso();
  state.dailyRecords.push({ date: today, checkedAt: now, createdAt: now });
  state.dailyRecords.sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt));
  persist();
  renderDaily();
  toast("今日打卡完成，继续保持");
}

export function bindDailyEvents() {
  $("#btn-daily-checkin").addEventListener("click", checkInToday);
}
