/* main.js — 应用入口：模块装配 + 初始化顺序。
   启动流程：迁移旧数据 → 载入本地 → 恢复登录会话 → 拉取 meta/词库/设置 →
   注册视图渲染器 → 首屏渲染 → 词库首刷。 */

import { Api } from "./api.js";
import { on, state } from "./state.js";
import { loadLocal, loadSettingsStamp, migrateLegacyStorage, registerArticleMigrator } from "./store.js";
import { bindNavigation, registerView, showView } from "./router.js";
import { bindAuthEvents, restoreAuth } from "./auth.js";
import { migrateArticles } from "./articles.js";
import { bindLibraryEvents, refreshLibrary, renderLibrary } from "./views/library.js";
import { bindWordbookEvents, renderWordbook } from "./views/wordbook.js";
import { bindPoolEvents, renderStoryPoolView } from "./views/pool.js";
import { bindGenerateEvents, renderResult } from "./views/generate.js";
import { bindStorybookEvents, renderArticleBook } from "./views/storybook.js";
import { bindPracticeEvents, renderPractice } from "./views/practice.js";
import { bindDailyEvents, renderDaily } from "./views/daily.js";
import { bindProfileEvents, renderProfile } from "./views/profile.js";
import { applySettings, bindSettingsEvents } from "./views/settings.js";
import { bindSourceEvents } from "./views/source.js";
import { bindReaderEvents } from "./newspaper/reader.js";
import { downloadWordArticle, printNewspaper } from "./newspaper/export.js";
import { activeArticle } from "./articles.js";
import { esc, toast } from "./utils.js";

async function init() {
  /* 文章迁移器注入 store（避免 store ↔ articles 循环依赖） */
  registerArticleMigrator(migrateArticles);

  migrateLegacyStorage();
  loadLocal();
  loadSettingsStamp();

  /* 一次性事件绑定 */
  bindNavigation();
  bindLibraryEvents();
  bindWordbookEvents();
  bindPoolEvents();
  bindGenerateEvents();
  bindPracticeEvents();
  bindStorybookEvents();
  bindDailyEvents();
  bindProfileEvents();
  bindSettingsEvents();
  bindAuthEvents();
  bindSourceEvents();
  bindReaderEvents();
  /* 阅读器弹窗内的导出按钮（export 依赖 reader.openNewspaper，绑在此处避免循环引用）：
     导出「正在看的这期」（整刊 = 一周所有文章；单篇 = 该篇） */
  document.querySelector("#btn-newspaper-pdf")?.addEventListener("click", () => printNewspaper(currentOpenArticles()));
  document.querySelector("#btn-newspaper-word")?.addEventListener("click", () => downloadWordArticle(currentOpenArticles()));

  /* 域事件 → 视图刷新（跨模块联动都走事件总线） */
  on("wordbook", () => { renderWordbook(); renderLibrary(); });
  on("pool", () => renderStoryPoolView());
  on("articles", () => renderArticleBook());
  on("daily", () => renderDaily());
  on("profile", () => renderProfile());
  on("auth", () => renderProfile());

  await restoreAuth();

  /* 元信息 + 词库分级 + 设置（并行拉取；失败不阻塞首屏） */
  try {
    const [levelsRes, cfg, meta] = await Promise.all([Api.levels(), Api.getConfig(), Api.meta()]);
    state.levels = (levelsRes.levels || []).map((l) => ({ id: l.id, label: l.label || l.id }));
    state.minCards = meta?.min_cards?.story || 3;
    state.providers = Array.isArray(meta?.providers) ? meta.providers : [];
    state.providerRules = meta?.provider_rules || { tokens: [], model_prefixes: [] };
    if (!state.level && state.levels.length) state.level = "all";
    const sel = document.querySelector("#word-level");
    sel.innerHTML = '<option value="all">全部词库</option>' + state.levels.map((l) => `<option value="${esc(l.id)}">${esc(l.label)}</option>`).join("") + '<option value="custom">自设单词</option>';
    sel.value = state.level;
    applySettings(cfg);
  } catch (err) {
    toast("无法连接后端：" + err.message + "（请先运行 python backend/app.py）");
  }

  /* 视图渲染器注册（showView 激活视图时按需渲染） */
  registerView("wordbook-view", renderWordbook);
  registerView("story-pool-view", renderStoryPoolView);
  registerView("story-book-view", renderArticleBook);
  registerView("daily-view", renderDaily);
  registerView("profile-view", renderProfile);

  /* 首屏渲染 */
  renderStoryPoolView();
  renderWordbook();
  renderDaily();
  renderProfile();
  renderPractice();
  refreshLibrary("daily");

  /* 默认落在首页 */
  showView("home-view");
}

init();
