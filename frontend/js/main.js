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
import { bindWordbookEvents, renderWordbook, bindWordbookMobileSearch } from "./views/wordbook.js?v=1";
import { bindPoolEvents, renderStoryPoolView } from "./views/pool.js";
import { bindGenerateEvents, bindReadingWordEvents, renderResult } from "./views/generate.js";
import { bindStorybookEvents, renderArticleBook } from "./views/storybook.js";
import { bindPracticeEvents, renderPractice } from "./views/practice.js";
import { bindDailyEvents, renderDaily } from "./views/daily.js";
import { bindProfileEvents, renderProfile } from "./views/profile.js";
import { applySettings, bindSettingsEvents } from "./views/settings.js";
import { bindSourceEvents } from "./views/source.js";
import { bindDiagnoseEvents } from "./views/diagnose.js";
import { bindWorkflowEvents, renderWorkflow, resetWorkflow } from "./views/workflow.js";
import { bindButtonPop, bindDeskStack, bindHomeHero, renderHomeProgress } from "./views/home.js?v=13";
import { bindReaderEvents } from "./newspaper/reader.js";
import { downloadWordArticle, printNewspaper } from "./newspaper/export.js";
import { activeArticle } from "./articles.js";
import { esc, toast } from "./utils.js";

/* 单文件 bundle 执行标记：index.html 的兜底引导据此判断是否需要重试加载
   （AI Works 网关限流 429 会掐断首次请求，见 build-bundle.mjs 头注释） */
window.__BOOKWORDS_BOOTED__ = true;

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
  bindWordbookMobileSearch();
  bindPoolEvents();
  bindGenerateEvents();
  bindReadingWordEvents();
  bindPracticeEvents();
  bindStorybookEvents();
  bindDailyEvents();
  bindProfileEvents();
  bindSettingsEvents();
  bindAuthEvents();
  bindSourceEvents();
  bindDiagnoseEvents();
  bindWorkflowEvents();
  bindHomeHero();
  bindDeskStack();
  renderHomeProgress();
  bindButtonPop();
  bindReaderEvents();
  /* 阅读器弹窗内的导出按钮（export 依赖 reader.openNewspaper，绑在此处避免循环引用）：
     导出「正在看的这期」（整刊 = 一周所有文章；单篇 = 该篇） */
  document.querySelector("#btn-newspaper-pdf")?.addEventListener("click", () => printNewspaper(currentOpenArticles()));
  document.querySelector("#btn-newspaper-word")?.addEventListener("click", () => downloadWordArticle(currentOpenArticles()));

  /* 域事件 → 视图刷新（跨模块联动都走事件总线） */
  on("wordbook", () => { renderWordbook(); renderLibrary(); renderHomeProgress(); });
  on("pool", () => { renderStoryPoolView(); resetWorkflow(); });
  on("articles", () => { renderArticleBook(); renderHomeProgress(); });
  on("daily", () => { renderDaily(); renderHomeProgress(); });
  on("profile", () => renderProfile());
  on("auth", () => renderProfile());

  await restoreAuth();

  /* 元信息 + 词库分级 + 设置。串行拉取（AI Works 网关限流，并发即 429）；
     失败不阻塞首屏，转入后台每 8 秒自愈重试，成功后自动补填词库下拉并刷新 */
  async function loadBootstrap() {
    const levelsRes = await Api.levels();
    const cfg = await Api.getConfig();
    const meta = await Api.meta();
    state.levels = (levelsRes.levels || []).map((l) => ({ id: l.id, label: l.label || l.id }));
    state.minCards = meta?.min_cards?.story || 3;
    if (!state.level && state.levels.length) state.level = "all";
    const sel = document.querySelector("#word-level");
    if (sel) {
      sel.innerHTML = '<option value="all">全部词库</option>' + state.levels.map((l) => `<option value="${esc(l.id)}">${esc(l.label)}</option>`).join("") + '<option value="custom">自设单词</option>';
      sel.value = state.level;
    }
    applySettings(cfg);
  }

  try {
    await loadBootstrap();
  } catch (err) {
    console.warn("bootstrap deferred:", err.message);
    toast("网络限流中，词库稍后自动加载…");
    let tries = 0;
    const heal = setInterval(async () => {
      tries++;
      try {
        await loadBootstrap();
        clearInterval(heal);
        refreshLibrary("browse");
        renderWordbook();
        toast("词库已加载");
      } catch (e) {
        console.warn(`bootstrap retry #${tries}:`, e.message);
      }
    }, 8000);
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
  renderWorkflow();
  refreshLibrary("browse");

  /* 默认落在首页 */
  showView("home-view");
}

/* 初始化兜底：任何启动异常都不能静默杀死全部交互（如 sandbox iframe 下
   localStorage 抛 SecurityError），至少给出可见提示。 */
init().catch((err) => {
  console.error("init failed:", err);
  toast("应用初始化失败：" + (err?.message || err));
});
