/* words.js — 词库加载与检索 + 词条归一化（word_catalog + word_utils 合并）。 */

const fs = require("fs");
const path = require("path");
const { trace } = require("./util");

const WORDLIST_DIR = path.join(__dirname, "..", "wordlist", "json");
/* 预映射缓存（gen-wordlist-cache.js 生成）：运行时只做纯 JSON.parse，
   避免 3 秒请求超时限制下冷启动内联解析超时 */
const CARD_CACHE_DIR = path.join(__dirname, "..", "wordlist", "cache");
const RANKS = ["A", "J", "Q", "K"];

/* 自设单词：进程内存（平台只读文件系统，用户已授权重启丢失取舍）。 */
const customWords = [];

const POS_WORDS = new Set(["bright", "happy", "love", "joy", "good", "great", "beautiful", "kind", "tender", "luminous", "cherish", "hope", "lucky", "peace", "warm", "gentle", "calm", "delight", "smile", "bless", "喜悦", "高兴", "爱", "美好", "温柔", "光明", "希望", "幸福", "喜欢", "快乐", "亲爱", "珍贵"]);
const NEG_WORDS = new Set(["dark", "sad", "hate", "fear", "bad", "angry", "cruel", "bleak", "abandon", "despair", "pain", "loss", "lonely", "cold", "doubt", "vanish", "grim", "荒凉", "悲伤", "恐惧", "恨", "抛弃", "黑暗", "痛苦", "孤独", "绝望", "惨淡", "愤怒", "失败"]);

let levelsCache = null;
const wordCache = new Map();
let allCache = null;
let allIndex = null; /* key → allCache 内词条，供自设词增量合并 O(1) 定位 */
let rebuildingAll = false;

/* ---------------- word_utils：归一化与启发式 ---------------- */

function autoValence(entry) {
  const v = String(entry.valence || "").toLowerCase();
  if (["positive", "pos", "褒义", "积极", "正面", "good"].includes(v)) return "positive";
  if (["negative", "neg", "贬义", "消极", "负面", "bad"].includes(v)) return "negative";
  if (["neutral", "中性", "中立"].includes(v)) return "neutral";
  const text = `${entry.word || ""} ${entry.meaning_cn || ""} ${entry.meaning_en || ""}`.toLowerCase();
  for (const w of POS_WORDS) if (text.includes(w)) return "positive";
  for (const w of NEG_WORDS) if (text.includes(w)) return "negative";
  return "neutral";
}

function detectPos(entry) {
  const p = String(entry.pos || "").toLowerCase();
  if (p) {
    if (p.startsWith("n")) return "n.";
    if (p.startsWith("v")) return "v.";
    if (p.startsWith("adj") || p.startsWith("a")) return "adj.";
    return p;
  }
  const w = String(entry.word || "").toLowerCase();
  if (w.endsWith("ly")) return "adv.";
  if (/(tion|ment|ness|ity|ship|ism|ance|ence|er|or)$/.test(w)) return "n.";
  if (/(ize|ise|ify|ate)$/.test(w)) return "v.";
  if (/(ous|ful|ive|able|ible|al|ic)$/.test(w)) return "adj.";
  return "";
}

function autoSuit(entry) {
  const s = String(entry.suit || "").toLowerCase();
  if (["spades", "hearts", "diamonds", "clubs"].includes(s)) return s;
  const pos = detectPos(entry);
  if (pos.startsWith("v")) return "diamonds";
  if (pos.startsWith("adj")) return "hearts";
  if (pos.startsWith("n")) return "clubs";
  const valence = autoValence(entry);
  if (valence === "positive") return "hearts";
  if (valence === "negative") return "spades";
  return "clubs";
}

/* ---------------- 词库加载 ---------------- */

/* ASCII 文件名 → 中文标签（平台 Linux 解压对中文文件名的编码不可控，
   词库文件一律用 ASCII 命名，展示层再映射回中文）。 */
const LEVEL_LABELS = {
  chuzhong: "初中",
  gaozhong: "高中",
  cet4: "四级 CET4",
  cet6: "六级 CET6",
  kaoyan: "考研",
  tuofu: "托福",
  sat: "SAT",
};

function labelFor(id) {
  return LEVEL_LABELS[id] || id;
}

function scanLevels() {
  const levels = [];
  try {
    for (const f of fs.readdirSync(WORDLIST_DIR).sort()) {
      /* 新命名 1-chuzhong.json；兼容旧命名 1-初中-顺序.json */
      let m = f.match(/^(\d+)-([A-Za-z0-9_-]+)\.json$/);
      if (m) {
        const id = m[2];
        levels.push({ id, label: labelFor(id), path: path.join(WORDLIST_DIR, f) });
        continue;
      }
      m = f.match(/^(\d+)-(.+)-顺序\.json$/);
      if (m) levels.push({ id: m[2], label: m[2], path: path.join(WORDLIST_DIR, f) });
    }
  } catch (err) { /* 目录缺失返回空 */ }
  return levels;
}

/* 部署诊断：/api/meta 带回词库目录实况，线上排障一眼定位 */
function wordlistStatus() {
  let files = [];
  try { files = fs.readdirSync(WORDLIST_DIR).filter((f) => f.endsWith(".json")); } catch (err) { /* 缺目录 */ }
  return {
    dir: WORDLIST_DIR,
    exists: files.length > 0 || (function () { try { return fs.existsSync(WORDLIST_DIR); } catch (e) { return false; } })(),
    file_count: files.length,
    files: files.slice(0, 10),
    level_count: listLevels().length,
  };
}

function listLevels() {
  if (!levelsCache) levelsCache = scanLevels();
  return levelsCache;
}

function levelPath(levelId) {
  const hit = listLevels().find((lv) => lv.id === levelId);
  return hit ? hit.path : null;
}

function normalizeLevelId(levelId) {
  const id = String(levelId || "");
  if (["all", "全部", "custom", "自设"].includes(id)) return id === "全部" ? "all" : id;
  return levelPath(id) ? id : "all";
}

function toCard(entry, levelId, index) {
  const word = String(entry.word || "").trim();
  const translations = Array.isArray(entry.translations) ? entry.translations : [];
  const phrasesRaw = Array.isArray(entry.phrases) ? entry.phrases : [];
  const types = [];
  for (const t of translations) {
    const ty = String((t && typeof t === "object" ? t.type : "") || "").trim();
    if (ty && !types.includes(ty)) types.push(ty);
  }
  const pos = types.length ? `${types.join(".")}.` : "";
  const meaningCn = translations
    .filter((t) => t && typeof t === "object" && String(t.translation || "").trim())
    .map((t) => String(t.translation).trim())
    .join("；");
  const card = { word, pos, phonetic: "", meaning_cn: meaningCn, meaning_en: "", etymology: "" };
  return {
    ...card,
    valence: autoValence(card),
    suit: autoSuit({ ...card, pos }),
    rank: RANKS[index % 4],
    example: "",
    phrases: phrasesRaw
      .filter((p) => p && typeof p === "object" && String(p.phrase || "").trim())
      .map((p) => ({ phrase: String(p.phrase).trim(), translation: String(p.translation || "").trim() })),
    level: levelId,
  };
}

function loadLevel(levelId) {
  if (wordCache.has(levelId)) return wordCache.get(levelId);
  const file = levelPath(levelId);
  if (!file) return [];
  /* 优先读预映射缓存：纯 JSON.parse，冷加载亚秒级（3 秒超时安全） */
  const pre = path.join(CARD_CACHE_DIR, `${levelId}.json`);
  if (fs.existsSync(pre)) {
    try {
      const cards = JSON.parse(fs.readFileSync(pre, "utf8"));
      const out = Array.isArray(cards) ? cards : [];
      wordCache.set(levelId, out);
      return out;
    } catch (err) { /* 缓存损坏回退源文件 */ }
  }
  let data = [];
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return [];
  }
  const cards = (Array.isArray(data) ? data : [])
    .map((entry, i) => (entry && typeof entry === "object" && String(entry.word || "").trim() ? toCard(entry, levelId, i) : null))
    .filter(Boolean);
  wordCache.set(levelId, cards);
  return cards;
}

/* 启动后台预热：listen 后逐级加载并合并 "all" 池，每级让出事件循环，
   不阻塞早期请求。用户请求到达时缓存大概率已热，残余缺口由前端重试兜底 */
let warmStarted = false;
function warmup() {
  if (warmStarted) return;
  warmStarted = true;
  const ids = listLevels().map((l) => l.id).concat(["all"]);
  (function step(i) {
    if (i >= ids.length) return;
    setImmediate(() => {
      const t0 = Date.now();
      try { cardsForLevel(ids[i]); } catch (err) { /* 预热失败不影响请求路径 */ }
      trace("wordlist_warm", { level: ids[i], ms: Date.now() - t0 });
      step(i + 1);
    });
  })(0);
}

function mergeCards(cards) {
  const merged = new Map();
  for (const card of cards) {
    const key = String(card.word || "").trim().toLowerCase();
    if (!key) continue;
    if (!merged.has(key)) {
      const item = { ...card };
      const levels = Array.isArray(card.levels) ? [...card.levels] : card.level ? [card.level] : [];
      item.levels = [...new Set(levels)];
      item.level = item.levels.join(" / ") || "词库";
      merged.set(key, item);
      continue;
    }
    absorbInto(merged.get(key), card);
  }
  return [...merged.values()];
}

/* 把 card 并入 item（跨级别同词去重合并）。供 mergeCards 与自设词增量更新共用 */
function absorbInto(item, card) {
  if (!Array.isArray(item.levels)) item.levels = [];
  const level = card.level || "";
  if (level && !item.levels.includes(level)) item.levels.push(level);
  item.level = item.levels.join(" / ") || "词库";
  for (const field of ["pos", "meaning_cn"]) {
    const split = (v) => String(v || "").replace(/；/g, ";").split(";").map((s) => s.trim()).filter(Boolean);
    item[field] = [...new Set([...split(item[field]), ...split(card[field])])].join("；");
  }
  if (!item.phonetic && card.phonetic) item.phonetic = card.phonetic;
  if (!item.example && card.example) item.example = card.example;
  const existing = new Set((item.phrases || []).filter((p) => p && typeof p === "object").map((p) => p.phrase));
  item.phrases = [...(item.phrases || []), ...((card.phrases || []).filter((p) => p && typeof p === "object" && !existing.has(p.phrase)))];
}

function loadCustomWords() {
  return customWords.map((item, index) => ({
    ...item,
    level: item.level || "自设",
    levels: item.levels || ["自设"],
    phrases: Array.isArray(item.phrases) ? item.phrases : [],
    rank: item.rank || RANKS[index % 4],
  }));
}

function saveCustomWords(cards) {
  customWords.splice(0, customWords.length, ...(Array.isArray(cards) ? cards : []));
}

function invalidateAllCache() {
  allCache = null;
  allIndex = null;
  browseCache.clear();
}

/* 后台重合并 all 池（54k 词条本地 1.5s，平台 CPU 必超 3 秒请求斧，
   绝不能在请求路径里做）。完成后自动挂 key 索引并重建浏览快照 */
function rebuildAllAsync() {
  allCache = null;
  allIndex = null;
  if (rebuildingAll) return;
  rebuildingAll = true;
  setImmediate(() => {
    try {
      let cards = [];
      for (const lv of listLevels()) if (wordCache.has(lv.id)) cards = cards.concat(wordCache.get(lv.id));
      cards = cards.concat(loadCustomWords());
      allCache = mergeCards(cards);
      allIndex = new Map(allCache.map((c) => [String(c.word || "").trim().toLowerCase(), c]));
      buildSnapshotsAsync();
    } finally {
      rebuildingAll = false;
    }
  });
}

/* 自设单词保存后的增量合并：只碰自设的那几条，毫秒级，替代全量重合并 */
function syncCustomIntoAll() {
  if (!allCache) return; /* 冷启动期：预热/后台重建会自然带上自设词 */
  if (!allIndex) allIndex = new Map(allCache.map((c) => [String(c.word || "").trim().toLowerCase(), c]));
  for (const cw of loadCustomWords()) {
    const key = String(cw.word || "").trim().toLowerCase();
    if (!key) continue;
    const hit = allIndex.get(key);
    if (hit) absorbInto(hit, cw);
    else {
      allCache.push(cw);
      allIndex.set(key, cw);
    }
  }
  browseCache.clear(); /* 快照里含自设词：立刻重建 */
  buildSnapshotsAsync();
}

function cardsForLevel(levelId) {
  const id = String(levelId || "");
  if (id === "custom" || id === "自设") return loadCustomWords();
  if (!id || id === "all" || id === "全部") {
    const levels = listLevels();
    const allWarm = levels.every((lv) => wordCache.has(lv.id));
    if (allCache && allWarm) return allCache;
    let cards = [];
    for (const lv of levels) if (wordCache.has(lv.id)) cards = cards.concat(wordCache.get(lv.id));
    cards = cards.concat(loadCustomWords());
    if (allWarm) {
      /* 已全热但池缺失/重建中：返回未合并拼接（跨级重复属可接受瞬态），
         重合并放后台——54k 词条合并平台 CPU 超 3 秒，绝不内联 */
      rebuildAllAsync();
      return cards;
    }
    /* 冷启动部分池：直接原样返回（不合并、不缓存），
       预热完成后 rebuildAllAsync 自然补全 */
    rebuildAllAsync();
    return cards;
  }
  return loadLevel(id);
}

/* ---- 全量浏览快照：预热时把各级整级词表序列化成 JSON 字符串，
        请求路径零计算（平台弱 CPU 下 filter+stringify 4000 卡也要数百毫秒）---- */
const browseCache = new Map(); /* levelId -> 完整响应 JSON 字符串 */
let snapshotsScheduled = false;

function buildSnapshotsAsync() {
  if (snapshotsScheduled) return;
  snapshotsScheduled = true;
  setImmediate(() => {
    snapshotsScheduled = false;
    const ids = listLevels().map((l) => l.id).concat(["all"]);
    for (const id of ids) {
      try {
        const cards = cardsForLevel(id).slice(0, 4000);
        browseCache.set(id, JSON.stringify({ words: cards, level: id, total: count(id) }));
      } catch (err) { /* 快照失败退回实时路径 */ }
    }
    trace("wordlist_snapshots", { levels: ids.length, bytes: [...browseCache.values()].reduce((a, s) => a + s.length, 0) });
  });
}

function browseSnapshot(levelId) {
  const key = String(levelId || "all");
  return browseCache.get(key) || null;
}

function count(levelId) {
  return cardsForLevel(levelId).length;
}

function search(levelId, q = "", limit = 30, pos = "") {
  let hay = cardsForLevel(levelId);
  const needle = String(q || "").trim().toLowerCase();
  const posNeedle = String(pos || "").trim().toLowerCase();
  if (needle) {
    hay = hay.filter((c) => c.word.toLowerCase().includes(needle) || String(c.meaning_cn || "").toLowerCase().includes(needle) || String(c.pos || "").toLowerCase().includes(needle));
  }
  if (posNeedle) {
    hay = hay.filter((c) => String(c.pos || "").toLowerCase().startsWith(posNeedle));
  }
  return hay.slice(0, limit);
}

function randomWords(levelId, n = 12) {
  const cards = cardsForLevel(levelId);
  if (!cards.length) return [];
  const picked = [];
  const pool = [...cards];
  for (let i = 0; i < Math.min(n, cards.length); i++) {
    picked.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
  }
  return picked;
}

function daily(levelId, n = 12) {
  const cards = cardsForLevel(levelId);
  if (!cards.length) return [];
  const now = new Date();
  const seed = Number(`${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`);
  /* mulberry32：与 Python random.Random(seed).sample 等价的确定性抽样（结果只需同日稳定） */
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = [...cards];
  const picked = [];
  for (let i = 0; i < Math.min(n, pool.length); i++) {
    picked.push(...pool.splice(Math.floor(rand() * pool.length), 1));
  }
  return picked;
}

module.exports = {
  listLevels, normalizeLevelId, loadLevel, mergeCards, cardsForLevel,
  loadCustomWords, saveCustomWords, invalidateAllCache, count, search, randomWords, daily,
  autoValence, autoSuit, detectPos, wordlistStatus, warmup, rebuildAllAsync, syncCustomIntoAll, browseSnapshot,
};
