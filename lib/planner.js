/* planner.js — 知乎选题规划：AI 关键词选择 → 只搜关键词 → AI 选题 → AI 原文概括。 */

const crypto = require("crypto");
const prompts = require("./prompts");
const llm = require("./llm");
const settings = require("./settings");
const grouping = require("./grouping");
const zhihu = require("./zhihu");
const { extractJson, trace } = require("./util");

const CN_TOKEN_RE = /[\u4e00-\u9fff]{2,6}/g;

function extractJsonSafe(content) {
  let text = String(content || "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("选题规划响应中没有 JSON");
  const payload = JSON.parse(text.slice(start, end + 1));
  if (!payload || typeof payload !== "object") throw new Error("选题规划响应不是对象");
  return payload;
}

function queryFor(cards) {
  const terms = [];
  for (const card of cards) {
    const meaning = String(card.meaning_cn || card.meaning_en || "");
    const first = meaning.split(/[；;,，。/|]/)[0].trim();
    terms.push(first || String(card.word || ""));
  }
  return terms.filter(Boolean).join(" ").slice(0, 120);
}

function candidateScore(card, candidate) {
  const text = `${candidate.title || ""} ${candidate.summary || ""}`.toLowerCase();
  const word = String(card.word || "").toLowerCase();
  let score = word && text.includes(word) ? 3 : 0;
  const meaning = String(card.meaning_cn || card.meaning_en || "").toLowerCase();
  const phrases = meaning.split(/[；;,，。/|]/).map((s) => s.trim()).filter((s) => s.length >= 2);
  for (const phrase of phrases.slice(0, 4)) if (text.includes(phrase)) score += 1.2;
  for (const token of (meaning.match(CN_TOKEN_RE) || []).slice(0, 8)) if (text.includes(token)) score += 0.35;
  return score;
}

function fallbackQueries(cards) {
  const localGroups = grouping.localGroup(cards).groups.slice(0, 3);
  const cardMap = new Map(cards.map((card) => [String(card.word || "").toLowerCase(), card]));
  const queries = [];
  for (const group of localGroups) {
    const groupCards = (group.words || []).map((word) => cardMap.get(word.toLowerCase())).filter(Boolean);
    const query = queryFor(groupCards.slice(0, 6));
    if (query && !queries.includes(query)) queries.push(query);
  }
  return queries;
}

/* 步骤 1 — AI 选关键词（懂中文的英文母语者：英文思考主题，中文写搜索词） */
async function planQueries(cards) {
  const safeCards = cards.slice(0, 40).map((card) => ({
    word: card.word,
    meaning: String(card.meaning_cn || card.meaning_en || "").slice(0, 60),
  }));
  const prompt = (
    "You are a native English-speaking learning editor who reads Chinese fluently. " +
    "Design Zhihu search queries to find Chinese articles whose topics can naturally carry ALL the target English words.\n" +
    "Rules:\n" +
    "- Think in English about which everyday themes fit these words, then write each query in Chinese (Zhihu is Chinese content).\n" +
    "- Output 3 to 4 queries; each is a short Chinese phrase of 4-12 characters on one searchable popular topic.\n" +
    "- Queries must point to DIFFERENT themes (for example nature and travel, work and psychology, history and culture, food and health).\n" +
    "- Queries must be real searchable topics, not word lists; never put English words inside a query.\n" +
    'Output only JSON: {"queries":["",""]}'
  );
  let queries = [];
  try {
    const response = await llm.complete({
      skillName: "zhihu_query_planning",
      promptVersion: prompts.version("zhihu_query_planning"),
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify({ words: safeCards }) },
      ],
      config: settings.effectiveApi(),
      jsonMode: true,
      temperature: 0.3,
      metadata: { word_count: safeCards.length },
    });
    const payload = extractJsonSafe(response.content);
    const raw = Array.isArray(payload.queries) ? payload.queries : [];
    for (const item of raw) {
      const text = String(item || "").replace(/\s+/g, " ").trim().slice(0, 30);
      if (text && !queries.includes(text)) queries.push(text);
    }
    queries = queries.slice(0, 4);
    if (!queries.length) throw new Error("query planning returned no queries");
  } catch (err) {
    trace("ai_queries_fallback", { error: String(err.message) });
    queries = fallbackQueries(cards).slice(0, 4);
  }
  trace("ai_queries", { queries: queries.join(" / ") });
  return queries;
}

/* 步骤 2 — 只用规划好的关键词搜索知乎（不做全量频道加载） */
async function collectCandidates(cards, queries) {
  const candidates = [];
  const errors = [];
  const seen = new Set();
  for (const query of queries) {
    const result = await zhihu.search(query, 10);
    if (!result.ok) {
      trace("zhihu_search", { query, error: String(result.error || "知乎搜索失败") });
      errors.push(String(result.error || "知乎搜索失败"));
      continue;
    }
    trace("zhihu_search", { query, count: (result.items || []).length });
    for (const item of result.items || []) {
      const contentId = String(item.content_id || "");
      if (!contentId || seen.has(contentId)) continue;
      seen.add(contentId);
      candidates.push({ ...item, planner_id: `search:${contentId}`, source: "zhihu_search", query });
    }
  }
  trace("candidates_ready", { total: candidates.slice(0, 40).length, queries: queries.length });
  return { candidates: candidates.slice(0, 40), errors };
}

function localPlan(cards, candidates, count) {
  const ranked = [...candidates]
    .sort((a, b) => cards.reduce((acc, card) => acc + candidateScore(card, b), 0) - cards.reduce((acc, card) => acc + candidateScore(card, a), 0))
    .slice(0, count);
  return ranked.map((item) => ({
    content_id: item.planner_id || item.content_id,
    words: [],
    reason: "theme shares an expandable context with the target words",
  }));
}

/* 步骤 3 — AI 选题审核（英文理由、主题分散、词分散分配） */
async function aiPlan(cards, candidates, count) {
  const safeCards = cards.map((card) => ({
    word: card.word,
    meaning: String(card.meaning_cn || card.meaning_en || "").slice(0, 80),
  }));
  const safeCandidates = candidates.slice(0, 16).map((item) => ({
    id: item.planner_id || item.content_id,
    title: String(item.title || "").slice(0, 140),
    summary: String(item.summary || "").slice(0, 220),
    search: String(item.query || "").slice(0, 30),
  }));
  const themes = [];
  for (const item of candidates.slice(0, 16)) {
    const query = String(item.query || "").trim();
    if (query && !themes.includes(query)) themes.push(query);
  }
  const prompt = (
    "You are a native English-speaking editor who reads Chinese fluently. " +
    `The candidates were found through these deliberately different search themes: ${JSON.stringify(themes)}. ` +
    `Build up to ${count} plans, aiming for one plan per search theme.\n` +
    "Rules:\n" +
    "- Each plan uses one article and keeps that article's own theme; never pick two plans on the same theme.\n" +
    "- Skip a search theme only if none of its articles can naturally carry at least 3 of the target words.\n" +
    "- Spread the target words across the plans; a word may appear in several plans when it fits; never pour all words into a single plan while other themes can carry some.\n" +
    "- Together the plans must still assign every target word at least once; each plan carries 3-20 words.\n" +
    "- Think in English and write every reason in English: one or two short sentences, no Chinese.\n" +
    'Output only JSON: {"plans":[{"content_id":"","words":[""],"reason":""}]}'
  );
  trace("ai_plan_start", { words: cards.length, candidates: safeCandidates.length });
  try {
    const response = await llm.complete({
      skillName: "zhihu_topic_coverage",
      promptVersion: prompts.version("zhihu_topic_coverage"),
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify({ words: safeCards, articles: safeCandidates }) },
      ],
      config: settings.effectiveApi(),
      jsonMode: true,
      temperature: 0.1,
      metadata: { word_count: cards.length, candidate_count: safeCandidates.length },
    });
    const payload = extractJsonSafe(response.content);
    const plans = Array.isArray(payload.plans) ? payload.plans : [];
    for (const plan of plans.slice(0, count)) {
      if (plan && typeof plan === "object") {
        trace("plan_pick", { content_id: String(plan.content_id || "").slice(0, 60), words: (plan.words || []).length, reason: String(plan.reason || "") });
      }
    }
    return { plans, provider: "external-api" };
  } catch (err) {
    trace("ai_plan_fallback", { provider: "local-semantic", error: String(err.message) });
    return { plans: localPlan(cards, candidates, count), provider: "local-semantic" };
  }
}

function normalizePlans(cards, candidates, rawPlans, count) {
  const cardMap = new Map(cards.map((card) => [String(card.word || "").toLowerCase(), card]));
  const candidateMap = new Map();
  for (const item of candidates) {
    if (item.planner_id) candidateMap.set(item.planner_id, item);
    if (item.content_id && !candidateMap.has(item.content_id)) candidateMap.set(item.content_id, item);
  }
  const plans = [];
  const used = new Set();
  for (const raw of rawPlans || []) {
    if (!raw || typeof raw !== "object") continue;
    const contentId = String(raw.content_id || raw.id || "");
    const item = candidateMap.get(contentId);
    if (!item || used.has(contentId)) continue;
    used.add(contentId);
    const words = [];
    for (const value of Array.isArray(raw.words) ? raw.words : []) {
      const card = cardMap.get(String(value).toLowerCase());
      if (card && !words.includes(card.word)) words.push(card.word);
    }
    plans.push({ item, words: words.slice(0, 20), reason: String(raw.reason || "theme fits the everyday meanings of the target words").slice(0, 180) });
    if (plans.length >= count) break;
  }
  if (!plans.length) {
    for (const raw of localPlan(cards, candidates, count)) {
      plans.push({ item: candidateMap.get(raw.content_id), words: [], reason: raw.reason });
    }
  }

  const requiredPlans = Math.ceil(cards.length / 20);
  const planCap = Math.max(count, requiredPlans);

  /* 多样性优先：每个 AI 搜索主题至少落一篇，再做通用容量补篇 */
  const distinctThemes = [];
  for (const item of candidates) {
    const query = String(item.query || "").trim();
    if (query && !distinctThemes.includes(query)) distinctThemes.push(query);
  }
  const usedThemes = new Set(plans.map((plan) => String(plan.item.query || "").trim()));
  for (const item of candidates) {
    if (plans.length >= Math.min(distinctThemes.length, planCap)) break;
    const query = String(item.query || "").trim();
    const plannerId = String(item.planner_id || "");
    if (!plannerId || used.has(plannerId) || !query || usedThemes.has(query)) continue;
    used.add(plannerId);
    usedThemes.add(query);
    plans.push({ item, words: [], reason: "backup topic from an AI-chosen search theme not represented yet" });
  }
  for (const item of candidates) {
    if (plans.length >= planCap) break;
    const plannerId = String(item.planner_id || "");
    if (plannerId && !used.has(plannerId)) {
      used.add(plannerId);
      plans.push({ item, words: [], reason: "backup Zhihu topic used to cover the remaining target words" });
    }
  }
  if (plans.length * 20 < cards.length) {
    throw new Error("符合条件的知乎文章数量不足，无法在单篇 20 词限制下完整覆盖");
  }

  const covered = new Set(plans.flatMap((plan) => plan.words.map((w) => w.toLowerCase())));
  for (const card of cards) {
    const key = String(card.word || "").toLowerCase();
    if (covered.has(key)) continue;
    let available = plans.filter((plan) => plan.words.length < 20);
    if (!available.length) {
      const occurrences = new Map();
      for (const plan of plans) {
        for (const word of plan.words) occurrences.set(word.toLowerCase(), (occurrences.get(word.toLowerCase()) || 0) + 1);
      }
      for (const plan of plans) {
        const duplicate = [...plan.words].reverse().find((word) => (occurrences.get(word.toLowerCase()) || 0) > 1);
        if (duplicate) {
          plan.words.splice(plan.words.indexOf(duplicate), 1);
          available = [plan];
          break;
        }
      }
    }
    if (!available.length) throw new Error("知乎覆盖方案没有足够容量容纳全部目标词");
    const target = available.reduce((best, plan) =>
      candidateScore(card, plan.item) - plan.words.length > candidateScore(card, best.item) - best.words.length ? plan : best
    );
    target.words.push(card.word);
    covered.add(key);
  }

  const allWords = cards.map((card) => card.word);
  plans.forEach((plan, index) => {
    if (plan.words.length < 3) {
      const extras = [...cards].sort((a, b) => candidateScore(b, plan.item) - candidateScore(a, plan.item));
      for (const card of extras) {
        if (!plan.words.includes(card.word)) plan.words.push(card.word);
        if (plan.words.length >= Math.min(3, allWords.length)) break;
      }
    }
    const item = plan.item;
    plans[index] = {
      id: `plan-${index + 1}`,
      source: item.source || "zhihu_search",
      content_id: item.content_id,
      work_id: item.work_id || (item.source === "story" || item.source === "knowledge" ? item.content_id : ""),
      title: item.title,
      author: item.author,
      summary: item.summary,
      excerpt: item.excerpt || item.summary || "",
      labels: item.labels || [item.content_type || "知乎文章"],
      url: item.url,
      vote_up_count: item.vote_up_count || 0,
      word_count: plan.words.length,
      words: plan.words,
      reason: plan.reason,
      estimated_length: Math.max(180, Math.min(260, 180 + Math.max(0, plan.words.length - 3) * 5)),
    };
  });
  return plans;
}

/* 步骤 4 — AI 概括选中文章的真实内容（一次批量调用；失败降级用节选头部） */
async function enrichDigests(plans) {
  const items = [];
  plans.forEach((plan, index) => {
    const content = String(plan.excerpt || "").slice(0, 1500);
    if (content) items.push({ id: String(index), title: String(plan.title || "").slice(0, 140), content });
  });
  if (!items.length) return;
  const prompt = (
    "You are a native English-speaking editor who reads Chinese fluently. " +
    "Summarize each Chinese article's gist so another writer can retell the SAME material in English.\n" +
    "Rules:\n" +
    "- For every article output one digest of 60-110 English words.\n" +
    "- The digest must state the theme, the core information, key facts and the conclusion; no commentary, no added facts.\n" +
    "- Stay faithful to the original content; never change its stance.\n" +
    'Output only JSON: {"digests":[{"id":"","digest":""}]} with ids copied from the input.'
  );
  trace("source_digest_start", { articles: items.length });
  try {
    const response = await llm.complete({
      skillName: "source_digest",
      promptVersion: prompts.version("source_digest"),
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify({ articles: items }) },
      ],
      config: settings.effectiveApi(),
      jsonMode: true,
      temperature: 0.2,
      metadata: { article_count: items.length },
    });
    const payload = extractJsonSafe(response.content);
    const raw = Array.isArray(payload.digests) ? payload.digests : [];
    const digestMap = new Map(raw.filter((e) => e && typeof e === "object").map((e) => [String(e.id), String(e.digest || "").trim()]));
    let hit = false;
    for (const [index, plan] of plans.entries()) {
      const digest = (digestMap.get(String(index)) || "").slice(0, 1200);
      if (digest) {
        hit = true;
        plan.digest = digest;
        trace("source_digest", { title: String(plan.title || "").slice(0, 80), digest: digest.slice(0, 160) });
      }
    }
    if (!hit) throw new Error("digest response contained no digests");
  } catch (err) {
    trace("source_digest_fallback", { error: String(err.message) });
    for (const plan of plans) {
      const head = String(plan.excerpt || "").slice(0, 400);
      if (head) plan.digest = head;
    }
  }
}

/* ---------------- 分步执行（线上单请求 ≤15 秒的硬上限） ----------------
   buildCoveragePlan 一次跑完约 30 秒（3 次 LLM + 4 次知乎搜索），必然被网关掐成 HTTP 554。
   拆成 4 个短请求，每一步的产物由客户端回传，服务端不保存任何中间态：
     stage=queries    → 选关键词（LLM #1）
     stage=candidates → 知乎搜索取候选（无 LLM）
     stage=plan       → 选题审核并归一化（LLM #2）
     stage=digest     → 批量概括正文并组装成品（LLM #3）
   同步整链 buildCoveragePlan 保留（本地/调试用），两条路径共用同一批 stage 函数，结果一致。 */

const COVERAGE_STAGES = ["queries", "candidates", "plan", "digest", "assemble"];

function slicedCards(rawCards) {
  return Array.isArray(rawCards) ? rawCards.slice(0, 60) : [];
}

function planCount(cards, candidates, queries) {
  return Math.min(4, Math.max(Math.ceil(cards.length / 8), queries.length, 1), candidates.length);
}

async function stageQueries(rawCards) {
  const cards = slicedCards(rawCards);
  if (cards.length < 3) throw Object.assign(new Error("近 3 天至少需要 3 个单词"), { statusCode: 400, stage: "topic_planning" });
  return { queries: await planQueries(cards) };
}

async function stageCandidates(rawCards, queries) {
  const cards = slicedCards(rawCards);
  const list = (Array.isArray(queries) ? queries : []).map((q) => String(q || "").trim()).filter(Boolean).slice(0, 4);
  if (!list.length) throw Object.assign(new Error("缺少搜索关键词"), { statusCode: 400, stage: "topic_planning" });
  const { candidates, errors } = await collectCandidates(cards, list);
  if (!candidates.length) {
    throw Object.assign(new Error(errors[0] || "知乎搜索没有返回可用文章，请稍后重试"), { statusCode: 502, stage: "zhihu_search", retryable: true });
  }
  return { candidates, errors };
}

async function stagePlan(rawCards, candidates, queries) {
  const cards = slicedCards(rawCards);
  const pool = Array.isArray(candidates) ? candidates : [];
  if (!pool.length) throw Object.assign(new Error("缺少候选文章，请重新搜索"), { statusCode: 400, stage: "topic_planning" });
  const count = planCount(cards, pool, Array.isArray(queries) ? queries : []);
  const { plans: rawPlans, provider } = await aiPlan(cards, pool, count);
  const plans = normalizePlans(cards, pool, rawPlans, count);
  if (!plans.length) throw Object.assign(new Error("没有选出可用的选题，请调整单词后重试"), { statusCode: 422, stage: "topic_planning" });
  return { plans, provider };
}

/* 概括正文：对传入的选题批量调用一次。
   整批 4 篇需要 20 秒以上（超限），所以客户端会**逐篇**调用本阶段（每篇约 5 秒），
   同步整链则一次传入全部（保持与旧行为一致）。 */
async function stageDigest(rawCards, plans) {
  const list = Array.isArray(plans) ? plans : [];
  if (!list.length) throw Object.assign(new Error("缺少待概括的选题"), { statusCode: 400, stage: "topic_planning" });
  await enrichDigests(list);
  for (const plan of list) {
    trace("plan_final", { title: String(plan.title || "").slice(0, 120), words: plan.word_count, reason: String(plan.reason || "").slice(0, 180) });
  }
  return { plans: list };
}

/* 组装成品：纯本地计算，无 LLM，毫秒级 —— 客户端把逐篇概括好的选题一起回传。 */
function stageAssemble(rawCards, days, plans, provider, errors) {
  const cards = slicedCards(rawCards);
  const list = Array.isArray(plans) ? plans : [];
  if (!list.length) throw Object.assign(new Error("缺少选题结果"), { statusCode: 400, stage: "topic_planning" });
  const covered = [...new Set(list.flatMap((plan) => plan.words))];
  const totalWords = new Set(cards.map((card) => String(card.word).toLowerCase())).size;
  const complete = new Set(covered.map((w) => w.toLowerCase())).size === totalWords;
  trace("coverage_done", { plans: list.length, covered: covered.length, total: cards.length, complete });
  return {
    ok: true,
    request_id: crypto.randomBytes(6).toString("hex"),
    days,
    provider,
    plans: list,
    coverage: {
      covered_words: covered,
      total_words: cards.length,
      input_words: Array.isArray(rawCards) ? rawCards.length : cards.length,
      truncated: (Array.isArray(rawCards) ? rawCards.length : cards.length) > cards.length,
      complete,
    },
    search_errors: Array.isArray(errors) ? errors : [],
  };
}

/* 供服务端按 stage 调度；payload 就是客户端回传的请求体（全部可序列化）。 */
async function runCoverageStage(stage, payload = {}) {
  if (!COVERAGE_STAGES.includes(stage)) {
    throw Object.assign(new Error(`未知阶段: ${stage}`), { statusCode: 400, stage: "topic_planning" });
  }
  const cards = payload.cards;
  if (stage === "queries") return stageQueries(cards);
  if (stage === "candidates") return stageCandidates(cards, payload.queries);
  if (stage === "plan") return stagePlan(cards, payload.candidates, payload.queries);
  if (stage === "digest") return stageDigest(cards, payload.plans);
  return stageAssemble(cards, Number(payload.days) === 7 ? 7 : 3, payload.plans, payload.provider, payload.search_errors);
}

async function buildCoveragePlan(cards, days = 3) {
  days = Number(days) === 7 ? 7 : 3;
  if (!Array.isArray(cards) || cards.length < 3) throw new Error(`近 ${days} 天至少需要 3 个单词`);
  const inputCount = cards.length;
  const sliced = slicedCards(cards);
  trace("coverage_start", { days, words: sliced.length });
  const { queries } = await stageQueries(cards);
  const { candidates, errors } = await stageCandidates(cards, queries);
  const { plans, provider } = await stagePlan(cards, candidates, queries);
  const { plans: digested } = await stageDigest(cards, plans);
  const result = stageAssemble(cards, days, digested, provider, errors);
  result.coverage.input_words = inputCount;
  result.coverage.truncated = inputCount > sliced.length;
  return result;
}

module.exports = { buildCoveragePlan, runCoverageStage, COVERAGE_STAGES };
