/* auth.js — 本地账户：注册 / 登录 / 会话恢复 / 登出。
   登录 = 服务端加密快照覆盖本地；登出 = 只清会话，本地数据保留（不再清空）。 */

import { Api } from "./api.js";
import { state } from "./state.js";
import { applyUserData, clearToken, emitDataChanged, getToken, setToken, userDataSnapshot } from "./store.js";
import { $, toast } from "./utils.js";

export function setAuthMode(registering) {
  $("#auth-title").textContent = registering ? "创建本地账户" : "登录刊见单词";
  $("#auth-intro").textContent = registering ? "创建后，当前浏览器中的学习数据会迁移到本机加密 JSON 文件。" : "登录后读取本机账户的加密资料、文章生成词组、日报与练习记录。";
  $("#btn-auth-submit").textContent = registering ? "创建并登录" : "登录";
  $("#btn-auth-switch").textContent = registering ? "已有账户，去登录" : "创建本地账户";
  $("#auth-confirm-wrap").hidden = !registering;
  $("#auth-password").autocomplete = registering ? "new-password" : "current-password";
  $("#auth-status").textContent = "";
  state.auth.registering = registering;
}

export function openAuthModal(registering = false) {
  setAuthMode(registering);
  $("#auth-modal").hidden = false;
  $("#auth-username")?.focus();
}

async function submitAuth() {
  const username = $("#auth-username").value.trim();
  const password = $("#auth-password").value;
  const registering = Boolean(state.auth.registering);
  const status = $("#auth-status");
  if (registering && password !== $("#auth-confirm").value) {
    status.classList.add("is-error");
    status.textContent = "两次输入的密码不一致";
    return;
  }
  status.textContent = registering ? "正在创建加密账户…" : "正在解锁本地账户…";
  status.classList.remove("is-error");
  try {
    const result = registering ? await Api.authRegister(username, password, userDataSnapshot()) : await Api.authLogin(username, password);
    state.auth.token = result.token;
    state.auth.user = result.user;
    setToken(result.token);
    applyUserData(result.user?.data || {});
    $("#auth-modal").hidden = true;
    emitDataChanged();
    toast(registering ? "账户已创建，学习数据已加密保存" : "登录成功，已解锁加密学习数据");
  } catch (err) {
    status.classList.add("is-error");
    status.textContent = err.message;
  }
}

/* 启动时恢复会话：token 有效则用服务端数据覆盖本地 */
export async function restoreAuth() {
  const token = getToken();
  if (!token) return;
  try {
    const result = await Api.authMe(token);
    state.auth.token = token;
    state.auth.user = result.user;
    applyUserData(result.user?.data || {});
  } catch (err) {
    clearToken();
    state.auth.token = "";
    state.auth.user = null;
  }
}

export async function logout() {
  const token = state.auth.token;
  try { if (token) await Api.authLogout(token); } catch (e) { /* 本地会话仍需清除 */ }
  state.auth = { token: "", user: null, registering: false };
  /* 本地学习数据保留（wj-* 仍在），只清会话；下次登录再用账户数据覆盖 */
  clearToken();
  emitDataChanged();
  toast("已退出当前账户");
}

export function bindAuthEvents() {
  $("#btn-auth-switch").addEventListener("click", () => setAuthMode(!state.auth.registering));
  $("#btn-auth-submit").addEventListener("click", submitAuth);
  $("#auth-password").addEventListener("keydown", (event) => { if (event.key === "Enter") submitAuth(); });
  $("#auth-confirm").addEventListener("keydown", (event) => { if (event.key === "Enter") submitAuth(); });
  $("#btn-close-auth").addEventListener("click", () => $("#auth-modal").hidden = true);
  $("#auth-modal").addEventListener("click", (event) => { if (event.target.id === "auth-modal") $("#auth-modal").hidden = true; });
  if ($("#btn-auth-profile")) $("#btn-auth-profile").addEventListener("click", () => openAuthModal(false));
  $("#btn-logout-profile").addEventListener("click", logout);
}
