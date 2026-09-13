/* periodical.js — 本地周刊聚合（纯本地，不调模型）。 */

function parseDate(value) {
  const d = new Date(String(value || "").replace("Z", "+00:00"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function aggregate(raw, period) {
  const articles = Array.isArray(raw) ? raw.filter((item) => item && typeof item === "object") : [];
  const groups = new Map();
  for (const article of articles.slice(0, 500)) {
    const when = parseDate(article.generatedAt || article.savedAt);
    if (!when) continue;
    const key = period === "month"
      ? `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}`
      : String(article.weekKey || `${when.getFullYear()}-${String(getWeek(when)).padStart(2, "0")}`);
    if (!groups.has(key)) groups.set(key, { key, articles: [], words: new Set(), themes: new Map(), sources: {} });
    const group = groups.get(key);
    group.articles.push(article);
    for (const word of Array.isArray(article.targetWords) ? article.targetWords : []) {
      if (word) group.words.add(String(word).toLowerCase());
    }
    const sorting = article.sorting && typeof article.sorting === "object" ? article.sorting : {};
    const selected = sorting.selected_group && typeof sorting.selected_group === "object" ? sorting.selected_group : {};
    const theme = String(selected.theme || article.genre || "其他主题");
    if (!group.themes.has(theme)) group.themes.set(theme, new Set());
    for (const word of selected.words || []) if (word) group.themes.get(theme).add(String(word));
    const source = String((article.story || {}).source_type || "original");
    group.sources[source] = (group.sources[source] || 0) + 1;
  }
  const result = [...groups.keys()].sort().reverse().map((key) => {
    const item = groups.get(key);
    return {
      key,
      article_count: item.articles.length,
      word_count: item.words.size,
      themes: [...item.themes.entries()].map(([name, words]) => ({ name, words: [...words].sort() })),
      sources: item.sources,
    };
  });
  return { ok: true, period, groups: result, ai_calls: 0 };
}

function getWeek(date) {
  const start = new Date(date.getFullYear(), 0, 1);
  return Math.floor((date - start) / (7 * 24 * 60 * 60 * 1000));
}

module.exports = { aggregate };
