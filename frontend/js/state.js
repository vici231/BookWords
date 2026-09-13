/* state.js — 全局状态 + 轻量事件总线。
   各视图直接读 state；域数据变化后由 store 持久化并 emit 对应事件，
   订阅了该事件的视图自行重渲染（单向数据流，视图之间不互相调用）。 */

export const MAX_STORY_CARDS = 20;

export const state = {
  pool: [],
  targetSelection: new Set(),
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
  periodicalSelections: { week: {}, month: {} },
  workflowStage: "words",
  generationRoute: "zhihu",
  coverageDays: 3,
  coveragePlans: [],
  coverageStatus: null,
  groupCandidates: [],
  selectedGroup: null,
  lockedWords: new Set(),
  excludedWords: new Set(),
  groupVariantIndex: 0,
  originalTopic: "",
  customStyle: { genre: "daily-science", tone: "clear", structure: "scene-explain", length: 220 },
  resultMode: "reading",
  practiceMode: "target",
  masteredWords: {},
  recentMistakes: [],
  practiceResults: {},
  workflowError: null,
  settings: { api: { base_url: "", model: "", has_key: false, api_key_masked: "" }, zhihu: {}, theme: "paper" },
  /* 本机凭证：只存在浏览器 localStorage，随每个请求发给后端（后端不落盘）。
     仓库与部署包默认不含任何真实凭证。 */
  credentials: { base_url: "", api_key: "", model: "", access_secret: "" },
  theme: "paper",
  search: "",
  pos: "",
  lastStory: null,
  lastGeneration: null,
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
  /* 当前选题来源；知乎强化路线由覆盖计划设置，今日创作使用 original。 */
  source: "original",
  sourceSelection: null,
  sourceRecommendations: [],
  sourceRecommendationKey: "",
  zhihuSearchCache: new Map(),
  zhihuHotCache: null,
  zhihuStoriesCache: null,
  zhihuKnowledgeCache: null,
  /* /api/meta 下发的单一事实来源 */
  minCards: 3,
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
