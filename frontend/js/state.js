/* state.js — 全局状态 + 轻量事件总线。
   各视图直接读 state；域数据变化后由 store 持久化并 emit 对应事件，
   订阅了该事件的视图自行重渲染（单向数据流，视图之间不互相调用）。 */

export const MAX_STORY_CARDS = 20;

export const state = {
  pool: [],
  wordbook: [],
  wordbookSort: "time-desc",
  levels: [],           // [{id, label}]
  level: "all",         // 当前词库难度；all 表示全部词库
  libraryCards: [],     // 当前库展示的子集（搜索 / 随机 / 每日），绝不全部
  diff: 3,              // 故事难度滑条（1-10）
  sliders: { density: 5, richness: 5, reasoning: 5, abstraction: 5, length: 220 },
  memoryScope: "pool",
  articleLanguage: "en",
  periodicalView: "daily",
  fetchedModels: [],    // 由 /api/models 实时查询到的该 Key 可用模型
  settings: { api: { base_url: "", model: "", has_key: false, api_key_masked: "" }, zhihu: {}, theme: "paper" },
  theme: "paper",
  search: "",
  pos: "",
  lastStory: null,
  articles: [],
  lastArticleId: "",
  practiceCompleted: false,
  poolUpdatedAt: "",
  wbSelection: new Set(),
  dailyRecords: [],
  profile: { name: "刊见学习者", goal: "每天记住 10 个词", signature: "", avatar: "学", updatedAt: "" },
  auth: { token: "", user: null, registering: false },
  settingsUpdatedAt: "",
  generating: false,
  /* 选题来源：auto 先按词汇池推荐题材；其余为手动来源。 */
  source: "auto",
  sourceSelection: null,
  sourceRecommendations: [],
  sourceRecommendationKey: "",
  zhihuSearchCache: new Map(),
  zhihuHotCache: null,
  zhihuStoriesCache: null,
  zhihuKnowledgeCache: null,
  /* /api/meta 下发的单一事实来源（避免前后端各硬编码一份） */
  minCards: 3,
  providers: [],        // [{id, name, base_url}]
  providerRules: { tokens: [], modelPrefixes: [] },
};

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export function emit(event, payload) {
  listeners.get(event)?.forEach((fn) => {
    try { fn(payload); } catch (e) { console.error(`[bus] ${event} 处理失败`, e); }
  });
}
