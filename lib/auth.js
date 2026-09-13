/* auth.js — 本地账户与学习数据存储。
   AI Works 平台文件系统只读：用户库保存在进程内存（用户已授权重启丢失取舍）。
   密码仍走 PBKDF2-HMAC-SHA256 摘要，不保存明文。 */

const crypto = require("crypto");

const PBKDF2_ITERATIONS = 310000;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const users = new Map(); // keyName -> {username, salt, password_hash, iterations, data, created_at}
const sessions = new Map(); // token -> {username, key, data, expires}

class PermissionError extends Error {}

function b64(buf) { return Buffer.from(buf).toString("base64url"); }
function unb64(value) { return Buffer.from(String(value || ""), "base64url"); }

function derive(password, salt) {
  const raw = crypto.pbkdf2Sync(String(password), salt, PBKDF2_ITERATIONS, 64, "sha256");
  return { key: raw.subarray(0, 32), verifier: raw.subarray(32, 64) };
}

function publicUser(username, data) {
  return {
    username,
    profile: data.profile && typeof data.profile === "object" ? data.profile : {},
    data,
  };
}

function validateCredentials(username, password) {
  const u = String(username || "").trim();
  const p = String(password || "");
  if (!USERNAME_RE.test(u)) throw new Error("账户名需为 3–32 位字母、数字、下划线、短横线或点号");
  if (p.length < 8) throw new Error("密码至少需要 8 位");
  return { username: u, password: p };
}

function startSession(username, key, data) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, {
    username, key, data,
    expires: Date.now() + SESSION_TTL_SECONDS * 1000,
  });
  return { token, user: publicUser(username, data) };
}

function register(username, password, data) {
  const creds = validateCredentials(username, password);
  const keyName = creds.username.toLowerCase();
  if (users.has(keyName)) throw new Error("该账户已存在，请直接登录");
  const salt = crypto.randomBytes(16);
  const { key, verifier } = derive(creds.password, salt);
  const payload = data && typeof data === "object" ? data : {};
  users.set(keyName, {
    username: creds.username,
    salt: b64(salt),
    password_hash: b64(verifier),
    iterations: PBKDF2_ITERATIONS,
    data: payload,
    created_at: Date.now() / 1000,
  });
  return startSession(creds.username, key, payload);
}

function login(username, password) {
  const u = String(username || "").trim();
  const p = String(password || "");
  const user = users.get(u.toLowerCase());
  if (!user) throw new Error("账户名或密码不正确");
  const derived = derive(p, unb64(user.salt));
  let ok;
  try {
    ok = crypto.timingSafeEqual(unb64(user.password_hash), derived.verifier);
  } catch (err) {
    ok = false;
  }
  if (!ok) throw new Error("账户名或密码不正确");
  return startSession(user.username || u, derived.key, user.data);
}

function session(token) {
  if (!token) throw new PermissionError("请先登录");
  const item = sessions.get(token);
  if (!item || item.expires < Date.now()) {
    sessions.delete(token);
    throw new PermissionError("登录已过期，请重新登录");
  }
  item.expires = Date.now() + SESSION_TTL_SECONDS * 1000;
  return item;
}

function saveSessionData(token, data) {
  const item = session(token);
  const payload = data && typeof data === "object" ? data : {};
  const user = users.get(String(item.username).toLowerCase());
  if (!user) throw new PermissionError("账户不存在");
  user.data = payload;
  item.data = payload;
  return publicUser(item.username, payload);
}

function logout(token) {
  if (token) sessions.delete(token);
}

module.exports = { register, login, session, saveSessionData, logout, publicUser, PermissionError };
