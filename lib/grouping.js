/* grouping.js — 词汇分组（语境语义优先，AI 排序 + 本地降级）。 */

const crypto = require("crypto");
const prompts = require("./prompts");
const llm = require("./llm");
const settings = require("./settings");
const { extractJson } = require("./util");

const MAX_ARTICLE_WORDS = 20;
const MAX_CANDIDATE_WORDS = 80;

const DOMAINS = {
  "人物与关系": ["人", "朋友", "家庭", "社会", "关系", "交流", "情感", "person", "people", "social", "friend"],
  "思考与学习": ["学习", "知识", "思考", "记忆", "理解", "发现", "研究", "learn", "think", "idea", "knowledge"],
  "行动与变化": ["行动", "改变", "发展", "过程", "移动", "增长", "减少", "change", "move", "grow", "action"],
  "自然与环境": ["自然", "环境", "动物", "植物", "天气", "地球", "nature", "environment", "animal", "plant"],
  "科技与工作": ["科技", "技术", "工作", "商业", "系统", "工具", "网络", "technology", "work", "business", "system"],
  "感受与选择": ["感受", "情绪", "快乐", "害怕", "选择", "希望", "feel", "emotion", "choose", "hope"],
};
const TOKEN_RE = /[A-Za-z]{3,}|[\u4e00-\u9fff]{2,}/g;
const COMMON_WORDS = new Set(["a","an","the","able","about","after","again","all","also","and","are","back","be","because","before","between","both","but","can","centre","choice","come","could","day","do","down","each","even","every","for","from","get","give","go","good","have","help","here","how","if","in","into","is","it","just","keep","know","like","look","make","many","may","more","most","much","must","new","not","now","of","on","one","only","or","other","our","out","over","people","right","same","say","see","simple","some","still","such","take","than","that","their","them","then","there","these","they","thing","think","this","time","to","too","two","under","up","use","very","want","way","we","well","what","when","where","which","who","will","with","work","would","you","your"]);

function coreScore(card) {
  const word = String(card.word || "").trim();
  const pos = String(card.pos || "").toLowerCase();
  let score = 0;
  if (COMMON_WORDS.has(word.toLowerCase())) return -100;
  if (/[A-Z]/.test(word[0]) || /[A-Z]/.test(word.slice(1)) || /\d/.test(word)) score += 4;
  if (["n", "名词", "proper", "专有"].some((t) => pos.includes(t))) score += 2;
  if (word.replace(/[^A-Za-z]/g, "").length >= 7) score += 1;
  if (word.split(/\s+/).length > 1) score += 2;
  return score;
}

function distinctiveWords(cards, limit = 6) {
  const ranked = [...cards].sort((a, b) => (coreScore(b) - coreScore(a)) || (String(b.word || "").length - String(a.word || "").length));
  const candidates = ranked.filter((card) => coreScore(card) > -100);
  let core = candidates.slice(0, Math.max(2, Math.min(limit, candidates.length))).map((card) => String(card.word || ""));
  if (core.length < 2) {
    core = ranked.slice(0, Math.max(1, Math.min(limit, ranked.length))).filter((card) => card.word).map((card) => String(card.word));
  }
  const coreKeys = new Set(core.map((w) => w.toLowerCase()));
  const support = cards.map((card) => String(card.word || "")).filter((word) => !coreKeys.has(word.toLowerCase()));
  return [core, support];
}

function screeningPool(cards, limit = 24) {
  return [...cards]
    .sort((a, b) => (coreScore(b) - coreScore(a)) || (String(b.word || "").length - String(a.word || "").length) || (Number(Boolean(b.meaning_cn)) - Number(Boolean(a.meaning_cn))))
    .slice(0, Math.max(6, Math.min(limit, cards.length)));
}

function cardText(card) {
  return ["word", "meaning_cn", "meaning_en"].map((k) => String(card[k] || "")).join(" ").toLowerCase();
}

function tokens(card) {
  return new Set((cardText(card).match(TOKEN_RE) || []).map((t) => t.toLowerCase()));
}

function domainScores(card) {
  const text = cardText(card);
  const out = {};
  for (const [name, keywords] of Object.entries(DOMAINS)) {
    out[name] = keywords.reduce((acc, kw) => acc + (text.includes(kw) ? 1 : 0), 0);
  }
  return out;
}

function sourceTokens(sourcePayload) {
  const item = sourcePayload && typeof sourcePayload === "object" ? sourcePayload : {};
  const text = [item.title || "", item.summary || item.excerpt || "", ...(item.labels || []).slice(0, 10).map((l) => String(l))].join(" ");
  return new Set((text.match(TOKEN_RE) || []).map((t) => t.toLowerCase()));
}

function canonicalWords(values, allowed, limit = null) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const value of values) {
    const canonical = allowed.get(String(value).toLowerCase());
    if (canonical && !out.includes(canonical) && (limit === null || out.length < limit)) out.push(canonical);
  }
  return out;
}

function groupRoles(words, cards, coreValues = null, supportValues = null) {
  const allowed = new Map(cards.map((card) => [String(card.word || "").toLowerCase(), String(card.word || "")]));
  const wordKeys = new Set(words.map((w) => w.toLowerCase()));
  let core = canonicalWords(coreValues, allowed, 6);
  if (core.length < 2) {
    core = distinctiveWords(cards.filter((card) => wordKeys.has(String(card.word || "").toLowerCase())))[0];
  }
  core = core.filter((word) => wordKeys.has(word.toLowerCase())).slice(0, 6);
  let support = canonicalWords(supportValues, allowed).filter((word) => wordKeys.has(word.toLowerCase()) && !core.some((c) => c.toLowerCase() === word.toLowerCase()));
  if (!support.length) support = words.filter((word) => !core.some((c) => c.toLowerCase() === word.toLowerCase()));
  return [core, support];
}

function localGroup(cards, sourcePayload = null) {
  cards = cards.slice(0, MAX_CANDIDATE_WORDS);
  const source = sourceTokens(sourcePayload);
  const buckets = new Map();
  const unclassified = [];
  for (const card of cards) {
    const scores = domainScores(card);
    let best = null;
    let bestScore = 0;
    for (const [name, score] of Object.entries(scores)) {
      if (score > bestScore) { best = name; bestScore = score; }
    }
    if (bestScore > 0) {
      if (!buckets.has(best)) buckets.set(best, []);
      buckets.get(best).push(card);
    } else {
      unclassified.push(card);
    }
  }

  const groups = [];
  const chunk = (items, makeGroup) => {
    for (let i = 0; i < items.length; i += MAX_ARTICLE_WORDS) {
      groups.push(makeGroup(items.slice(i, i + MAX_ARTICLE_WORDS)));
    }
  };

  for (const [theme, items] of buckets) {
    chunk(items, (list) => {
      const words = list.map((item) => item.word);
      let overlap = 0;
      if (source.size) {
        const union = new Set();
        for (const item of list) for (const t of tokens(item)) union.add(t);
        for (const t of union) if (source.has(t)) overlap++;
      }
      return {
        theme,
        words,
        reason: `这些词的释义共同指向“${theme}”，可以在同一场景、动作或因果链中自然展开。`,
        coherence: Math.min(1, Math.round((0.48 + words.length * 0.025 + overlap * 0.04) * 100) / 100),
        core_words: distinctiveWords(list)[0],
        supporting_words: distinctiveWords(list)[1],
      };
    });
  }
  if (unclassified.length) {
    chunk(unclassified, (list) => ({
      theme: "日常问题与具体选择",
      words: list.map((item) => item.word),
      reason: "这些词可围绕一个具体人物、问题和结果组织为连续的日常文章。",
      coherence: Math.min(0.62, Math.round((0.38 + list.length * 0.02) * 100) / 100),
      core_words: distinctiveWords(list)[0],
      supporting_words: distinctiveWords(list)[1],
    }));
  }
  if (!groups.length) throw new Error("没有可供分组的有效词汇");
  groups.sort((a, b) => (b.coherence - a.coherence) || (b.words.length - a.words.length));
  let selected = groups.find((g) => g.words.length >= 3) || groups[0];
  if (selected.words.length < 3) {
    const merged = [];
    for (let i = 0; i < cards.length; i += MAX_ARTICLE_WORDS) {
      const list = cards.slice(i, i + MAX_ARTICLE_WORDS);
      merged.push({
        theme: "日常问题与具体选择",
        words: list.map((card) => card.word),
        reason: "将词汇合并为具体人物、问题和结果明确的日常语境。",
        coherence: 0.4,
        core_words: distinctiveWords(list)[0],
        supporting_words: distinctiveWords(list)[1],
      });
    }
    groups.splice(0, groups.length, ...merged);
    selected = groups[0];
  }
  return { provider: "local-semantic", groups, selected_group: { ...selected } };
}

function normalizeSortResult(payload, cards) {
  const allowed = new Map(cards.map((card) => [String(card.word).toLowerCase(), String(card.word)]));
  const groups = [];
  for (const item of Array.isArray(payload.groups) ? payload.groups : []) {
    if (!item || typeof item !== "object") continue;
    const words = [];
    for (const value of Array.isArray(item.words) ? item.words : []) {
      const word = allowed.get(String(value).toLowerCase());
      if (word && !words.includes(word) && words.length < MAX_ARTICLE_WORDS) words.push(word);
    }
    if (!words.length) continue;
    let coherence = Number(item.coherence);
    if (!Number.isFinite(coherence)) coherence = 0.5;
    const [coreWords, supportingWords] = groupRoles(words, cards, item.core_words, item.supporting_words);
    groups.push({
      theme: String(item.theme || "共同语境").slice(0, 80),
      words,
      core_words: coreWords,
      supporting_words: supportingWords,
      reason: String(item.reason || "这些词可在同一篇文章中自然表达").slice(0, 240),
      coherence: Math.max(0, Math.min(1, coherence)),
    });
  }
  if (!groups.length) throw new Error("排序结果缺少有效 groups");
  const covered = new Set(groups.flatMap((g) => g.words.map((w) => w.toLowerCase())));
  const missingCards = cards.filter((card) => !covered.has(String(card.word).toLowerCase()));
  if (missingCards.length) groups.push(...localGroup(missingCards).groups);
  groups.sort((a, b) => (b.coherence - a.coherence) || (b.words.length - a.words.length));
  const selected = groups.find((g) => g.words.length >= 3);
  if (!selected) throw new Error("排序结果没有至少 3 个词的可成文分组");
  return { provider: "external-api", groups, selected_group: { ...selected } };
}

function decorateGroups(result, cards, { maxGroups, maxWords, lockedWords, excludedWords }) {
  const locked = new Set(lockedWords.map((w) => w.toLowerCase()));
  const excluded = new Set(excludedWords.map((w) => w.toLowerCase()));
  const lockedKeys = new Set(lockedWords.map((w) => w.toLowerCase()));
  const decorated = [];
  for (const [index, raw] of (result.groups || []).entries()) {
    let words = (raw.words || []).map(String).filter((word) => !excluded.has(word.toLowerCase()));
    words = [...lockedWords, ...words.filter((word) => !lockedKeys.has(word.toLowerCase()))].slice(0, maxWords);
    if (words.length < 3 || !lockedWords.every((w) => new Set(words.map((x) => x.toLowerCase())).has(w.toLowerCase()))) continue;
    const coherence = Math.max(0, Math.min(1, Number(raw.coherence) || 0.5));
    const [coreWords, supportingWords] = groupRoles(words, cards, raw.core_words, raw.supporting_words);
    decorated.push({
      id: `group-${index + 1}`,
      theme: String(raw.theme || "共同语境").slice(0, 80),
      reason: String(raw.reason || "这些词可在同一篇文章中自然表达").slice(0, 240),
      coherence,
      words,
      core_words: coreWords,
      supporting_words: supportingWords,
      estimated_length: Math.max(180, Math.min(260, 180 + Math.max(0, words.length - 3) * 5)),
      estimated_genre: coherence >= 0.7 ? "daily-science" : "daily-curiosity",
    });
    if (decorated.length >= maxGroups) break;
  }
  if (!decorated.length) throw new Error("锁定词无法形成至少 3 个词的共同语境，请减少必用词或取消部分排除词");
  return { ...result, groups: decorated, selected_group: { ...decorated[0] } };
}

async function groupCards(cards, sourcePayload = null, { lockedWords = [], excludedWords = [], maxGroups = 3, maxWords = MAX_ARTICLE_WORDS } = {}) {
  cards = cards.slice(0, MAX_CANDIDATE_WORDS);
  const allowed = new Map(cards.map((card) => [String(card.word || "").toLowerCase(), String(card.word || "")]));
  const uniq = (values) => [...new Set((values || []).map((v) => String(v).toLowerCase()))].map((k) => allowed.get(k)).filter(Boolean);
  lockedWords = uniq(lockedWords);
  excludedWords = uniq(excludedWords);
  const excluded = new Set(excludedWords.map((w) => w.toLowerCase()));
  lockedWords = lockedWords.filter((word) => !excluded.has(word.toLowerCase()));
  cards = cards.filter((card) => !excluded.has(String(card.word || "").toLowerCase()));
  maxGroups = Math.max(1, Math.min(3, Number(maxGroups) || 3));
  maxWords = Math.max(3, Math.min(MAX_ARTICLE_WORDS, Number(maxWords) || MAX_ARTICLE_WORDS));
  if (cards.length < 3) throw new Error("排除后至少需要 3 个单词");
  if (lockedWords.length > maxWords) throw new Error(`必用词不能超过 ${maxWords} 个`);
  const screenedCards = screeningPool(cards);
  const request = {
    cards: screenedCards,
    available_target_words: cards.map((card) => card.word),
    topic: sourcePayload || {},
    locked_words: lockedWords,
    excluded_words: excludedWords,
    max_groups: maxGroups,
    max_words: maxWords,
  };
  try {
    const response = await llm.complete({
      skillName: "word_sort",
      promptVersion: prompts.version("word_sort"),
      messages: [
        { role: "system", content: prompts.getStagePrompt("word_screening") },
        { role: "user", content: JSON.stringify(request) },
      ],
      config: settings.effectiveApi(),
      jsonMode: true,
      temperature: 0.15,
      metadata: { word_count: cards.length, screened_word_count: screenedCards.length },
    });
    const result = normalizeSortResult(extractJson(response.content), cards);
    return decorateGroups(result, cards, { maxGroups, maxWords, lockedWords, excludedWords });
  } catch (err) {
    const result = localGroup(cards, sourcePayload);
    result.reason = `AI 排序不可用，已使用本地语境规则：${err.message}`;
    return decorateGroups(result, cards, { maxGroups, maxWords, lockedWords, excludedWords });
  }
}

module.exports = {
  MAX_ARTICLE_WORDS, MAX_CANDIDATE_WORDS,
  distinctiveWords, screeningPool, localGroup, groupCards,
  randomId: () => crypto.randomBytes(6).toString("hex"),
};
