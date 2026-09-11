/* views/profile.js — 我的页：资料编辑 / 头像（上传自动压缩到 256px）/ 学习统计 */

import { state } from "../state.js";
import { persist } from "../store.js";
import { $, avatarMarkup, fileToAvatar, formatStamp, nowIso, toast } from "../utils.js";

export function renderProfile() {
  if ($("#profile-signature")) $("#profile-signature").value = state.profile.signature || "";
  if ($("#profile-avatar-button")) $("#profile-avatar-button").innerHTML = avatarMarkup(state.profile.avatar);
  if ($(".sidebar-avatar")) $(".sidebar-avatar").innerHTML = avatarMarkup(state.profile.avatar);
  if ($("#mobile-profile-avatar")) $("#mobile-profile-avatar").innerHTML = avatarMarkup(state.profile.avatar);
  if ($("#profile-account-status")) $("#profile-account-status").textContent = state.auth.user ? `本地账户：${state.auth.user.username} · 数据已加密同步` : "未登录 · 登录后同步加密数据";
  document.querySelectorAll(".avatar-option").forEach((button) => button.classList.toggle("is-selected", button.dataset.avatar === (state.profile.avatar || "学")));
  if ($("#profile-stat-words")) $("#profile-stat-words").textContent = state.wordbook.length;
  if ($("#profile-stat-issues")) $("#profile-stat-issues").textContent = state.articles.length;
  if ($("#profile-stat-completed")) $("#profile-stat-completed").textContent = state.articles.filter((article) => article.completedAt).length;
  if ($("#profile-stat-checkins")) $("#profile-stat-checkins").textContent = state.dailyRecords.length;
  if ($("#btn-logout-profile")) $("#btn-logout-profile").hidden = !state.auth.user;
  if ($("#btn-auth-profile")) $("#btn-auth-profile").hidden = Boolean(state.auth.user);
  if ($("#profile-name")) $("#profile-name").value = state.profile.name || "";
  if ($("#profile-goal")) $("#profile-goal").value = state.profile.goal || "";
  if ($("#sidebar-profile-name")) $("#sidebar-profile-name").textContent = state.profile.name || "刊见学习者";
  if ($("#profile-updated")) $("#profile-updated").textContent = state.profile.updatedAt ? `最近更新：${formatStamp(state.profile.updatedAt) || "时间未知"}` : "信息尚未更新";
}

export function saveProfile() {
  const now = nowIso();
  state.profile = {
    name: ($("#profile-name")?.value || "").trim() || "刊见学习者",
    goal: ($("#profile-goal")?.value || "").trim() || "每天记住 10 个词",
    signature: ($("#profile-signature")?.value || "").trim(),
    avatar: state.profile.avatar || "学",
    updatedAt: now,
  };
  persist();
  renderProfile();
  toast(state.auth.user ? "个人信息已保存并加密同步" : "个人信息已保存（本地）；登录后才会加密备份到账户");
}

export function bindProfileEvents() {
  $("#btn-save-profile").addEventListener("click", saveProfile);
  document.querySelectorAll(".avatar-option").forEach((button) => button.addEventListener("click", () => {
    state.profile.avatar = button.dataset.avatar || "学";
    renderProfile();
  }));
  if ($("#btn-avatar-upload")) $("#btn-avatar-upload").addEventListener("click", () => $("#avatar-file")?.click());
  if ($("#avatar-file")) $("#avatar-file").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast("请选择图片文件"); return; }
    if (file.size > 1.5 * 1024 * 1024) { toast("图片请小于 1.5MB"); return; }
    try {
      /* 上传即压缩：等比缩放到 256px JPEG，避免大图拖慢加密同步 */
      state.profile.avatar = await fileToAvatar(file, 256);
      renderProfile();
      toast("头像已更换，记得保存");
    } catch (err) {
      toast("头像处理失败：" + err.message);
    }
  });
}
