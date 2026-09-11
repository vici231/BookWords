"""本地账户与加密学习数据存储。

用户数据保存在 JSON 容器中，但每个用户的 data 字段都是 AES-GCM 密文。
密码只保存 PBKDF2-HMAC-SHA256 摘要，不保存明文；解密密钥只存在当前进程
的登录会话内。该模块适合本地单机应用，不代替线上多设备账户系统。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

STORE_PATH = Path(__file__).resolve().parent / "data" / "users.json"
PBKDF2_ITERATIONS = 310_000
SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
_lock = threading.RLock()
_sessions: dict[str, dict] = {}


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value.encode("ascii"))


def _read() -> dict:
    if not STORE_PATH.is_file():
        return {"version": 1, "users": {}}
    try:
        raw = json.loads(STORE_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("users"), dict):
            return raw
    except (OSError, json.JSONDecodeError):
        pass
    return {"version": 1, "users": {}}


def _write(data: dict) -> None:
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STORE_PATH)


def _derive(password: str, salt: bytes) -> tuple[bytes, bytes]:
    raw = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS, 64)
    return raw[:32], raw[32:]


def _password_record(password: str) -> tuple[str, str, bytes]:
    salt = secrets.token_bytes(16)
    key, verifier = _derive(password, salt)
    return _b64(salt), _b64(verifier), key


def _encrypt(payload: dict, key: bytes) -> tuple[str, str]:
    nonce = secrets.token_bytes(12)
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return _b64(nonce), _b64(AESGCM(key).encrypt(nonce, raw, None))


def _decrypt(user: dict, key: bytes) -> dict:
    raw = AESGCM(key).decrypt(_unb64(user["nonce"]), _unb64(user["ciphertext"]), None)
    data = json.loads(raw.decode("utf-8"))
    return data if isinstance(data, dict) else {}


def _public(username: str, data: dict) -> dict:
    profile = data.get("profile") if isinstance(data.get("profile"), dict) else {}
    return {
        "username": username,
        "profile": profile,
        "data": data,
    }


def _validate_credentials(username: str, password: str) -> tuple[str, str]:
    username = str(username or "").strip()
    password = str(password or "")
    if not USERNAME_RE.fullmatch(username):
        raise ValueError("账户名需为 3–32 位字母、数字、下划线、短横线或点号")
    if len(password) < 8:
        raise ValueError("密码至少需要 8 位")
    return username, password


def register(username: str, password: str, data: dict | None = None) -> tuple[str, dict]:
    username, password = _validate_credentials(username, password)
    with _lock:
        store = _read()
        key_name = username.casefold()
        if key_name in store["users"]:
            raise ValueError("该账户已存在，请直接登录")
        salt, password_hash, key = _password_record(password)
        payload = data if isinstance(data, dict) else {}
        nonce, ciphertext = _encrypt(payload, key)
        store["users"][key_name] = {
            "username": username,
            "salt": salt,
            "password_hash": password_hash,
            "iterations": PBKDF2_ITERATIONS,
            "nonce": nonce,
            "ciphertext": ciphertext,
            "created_at": time.time(),
        }
        _write(store)
        return _start_session(username, key, payload)


def login(username: str, password: str) -> tuple[str, dict]:
    username = str(username or "").strip()
    password = str(password or "")
    with _lock:
        store = _read()
        user = store["users"].get(username.casefold())
        if not user:
            raise ValueError("账户名或密码不正确")
        try:
            salt = _unb64(user["salt"])
            key, verifier = _derive(password, salt)
            if not hmac.compare_digest(_b64(verifier), str(user["password_hash"])):
                raise ValueError("账户名或密码不正确")
            payload = _decrypt(user, key)
        except Exception as exc:
            if isinstance(exc, ValueError) and str(exc) == "账户名或密码不正确":
                raise
            raise ValueError("账户数据损坏或密码不正确") from exc
        return _start_session(user.get("username", username), key, payload)


def _start_session(username: str, key: bytes, data: dict) -> tuple[str, dict]:
    token = secrets.token_urlsafe(32)
    _sessions[token] = {"username": username, "key": key, "data": data, "expires": time.time() + SESSION_TTL_SECONDS}
    return token, _public(username, data)


def session(token: str | None) -> dict:
    if not token:
        raise PermissionError("请先登录")
    item = _sessions.get(token)
    if not item or item["expires"] < time.time():
        _sessions.pop(token, None)
        raise PermissionError("登录已过期，请重新登录")
    item["expires"] = time.time() + SESSION_TTL_SECONDS
    return item


def save_session_data(token: str, data: dict) -> dict:
    item = session(token)
    payload = data if isinstance(data, dict) else {}
    with _lock:
        store = _read()
        key_name = str(item["username"]).casefold()
        user = store["users"].get(key_name)
        if not user:
            raise PermissionError("账户不存在")
        nonce, ciphertext = _encrypt(payload, item["key"])
        user["nonce"] = nonce
        user["ciphertext"] = ciphertext
        _write(store)
        item["data"] = payload
    return _public(item["username"], payload)


def logout(token: str | None) -> None:
    if token:
        _sessions.pop(token, None)


def public_user(username: str, data: dict) -> dict:
    """公有别名：路由层用它组装响应，不直接触达 _public。"""
    return _public(username, data)
