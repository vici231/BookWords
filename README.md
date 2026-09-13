# 刊见单词 BookWords

把生词放进真实的知乎内容里：选材 → 智能配词 → 生成中英双语文章 → 练习与复习。

- **后端**：Node.js + Express，单进程、无数据库；用户数据存在浏览器 localStorage
- **前端**：原生 JS（构建为单文件 bundle `frontend/js/main.bundle.js`）+ 原生 CSS
- **运行环境**：本地开发用 Node 20+；线上部署到**知乎 AI Works**（CloudBase HTTP 云函数）

---

## 快速开始（本地）

```bash
npm install
npm start          # 或直接双击 run.bat
# 浏览器打开 http://localhost:9000
```

首次打开后，点右上角 **系统设置 → 接口凭证**，填自己的：

| 字段 | 说明 |
| --- | --- |
| Base URL | 任意 OpenAI 兼容网关，如 `https://api.deepseek.com` |
| API Key | 你自己的 key |
| 模型名 | 如 `deepseek-chat` |
| 知乎 Access Secret | 可选；用「知乎搜索 / 直答 / 选题覆盖」时需要，在知乎开放平台申请 |

填完点 **保存到本机** 即可开始使用；点 **测试连接** 会用当前填写的内容做一次真实调用。

---

## 凭证是怎么处理的（重点）

- 凭证只存在 **你自己浏览器的 localStorage**（键 `wj-credentials`），
  随每个请求放在请求头 `X-AI-Key` / `X-AI-Base-URL` / `X-AI-Model` / `X-Zhihu-Secret` 发给后端；
- 后端通过 `AsyncLocalStorage` **只在本次请求内**使用，**不写文件、不回显、不打日志**；
- **本仓库与部署包里不含任何真实凭证**：`data/settings.json` 已列入 `.gitignore`，
  仓库只保留空白模板 `data/settings.example.json`；
- 因此换电脑 / 换浏览器需要重新填写；清除浏览器数据也会清掉。

> 可选的启动种子：若你希望服务端在无人访问时也持有默认凭证（例如跑本地脚本），
> 把 `data/settings.example.json` 复制成 `data/settings.json` 并填写即可（该文件不会入库）。

---

## 词库数据（不入库）

`wordlist/json/*.json` 与 `wordlist/cache/` 体积较大且属于本地数据，**不在仓库里**。
克隆后把你的词表按下面命名放进 `wordlist/json/`：

```
1-chuzhong.json  2-gaozhong.json  3-cet4.json  4-cet6.json
5-kaoyan.json    6-tuofu.json     7-sat.json
```

`wordlist/cache/` 是可选加速缓存（把词表预映射成卡牌，冷启动更快）：
没有它时运行时会直接解析源 JSON，功能一致、只是首次加载更慢。

---

## 部署到知乎 AI Works

线上是 CloudBase HTTP 云函数，需要 `scf_bootstrap` + `cloudbaserc.json` + `_tmp/` 描述符，
这些由部署助手（`zhihu-ai-works-deploy-helper`）按项目静态探测生成，产物是一个**单根目录 ZIP**：

```bash
node build-bundle.mjs          # 改过 frontend/js 必做：index.html 加载的是 bundle
python <skill>/scripts/inspect_node_project.py --root . --output _tmp/deploy-plan.json
python <skill>/scripts/write_backend_runtime.py --project-root . --plan _tmp/deploy-plan.json
python <skill>/scripts/write_deploy_descriptors.py --output-root . --plan _tmp/deploy-plan.json --frontend-install-cmd "npm ci"
python <skill>/scripts/create_project_archive.py --project-root .
# 把生成的 <项目名>.zip 直接上传到 AI Works
```

`cloudbaserc.json` 里额外声明了 `"timeout": 60`（云函数执行超时）。**不要删掉**：
CloudBase HTTP 云函数默认只有 3 秒，会在模型还没返回时就掐断请求。

---

## 平台限制与对应设计（重要）

知乎 AI Works 预览网关对**单次请求**有约 **12–15 秒**的硬上限，超时返回裸 `HTTP 554`；
它还会**整体缓冲响应**（流式响应无效），失败时**自行重试一次**（客户端约 32 秒后才看到错误）。
一次完整的「配词 + 写作 + 翻译」需要 20 秒以上，必然被掐断。因此：

| 功能 | 拆分方式 |
| --- | --- |
| 生成文章 | 智能配词 → 英文草稿（`stage=draft`）→ 中文与总结（`stage=localize`） |
| 知乎选题覆盖 | 选关键词 → 知乎搜索 → 选题审核 → **逐篇**概括 → 组装（组装纯本地、毫秒级） |

每个请求都在 10 秒内完成；中间结果由前端携带回传，**服务端不保存任何跨请求状态**
（线上会同时跑多个实例，进程内存不能作为共享状态）。前端在请求被网关掐断时还会自动重试一次。

---

## 目录结构

```
server.js            Express 入口：静态资源 + 全部 /api 路由
lib/
  settings.js        设置与凭证（含 per-request 凭证上下文）
  ai.js              文章生成：分步草稿 / 翻译、校验与归一化
  grouping.js        智能配词（词组划分）
  planner.js         知乎选题覆盖（分阶段）
  zhihu.js           知乎官方接口：搜索 / 热榜 / 故事 / 知识 / 直答
  llm.js             OpenAI 兼容网关与调用指标
  jobs.js            进程内任务表（提交即返回 + 轮询）
  words.js           词库加载与检索
prompts/             提示词（运行时读取，不打包进 bundle）
frontend/            原生前端；index.html 加载 js/main.bundle.js
  js/views/          各视图（settings.js 内含「接口凭证」表单）
wordlist/            词库数据目录（数据不入库，只保留 .gitkeep）
data/                可选启动种子（settings.example.json 为模板）
```

## 许可

仅用于学习与研究。文章内容由大模型基于所选素材改写生成，不代表原平台立场。
