# 刊见单词 BookWords

> 把零散生词组织进同一语境，用一篇真正读得下去的双语文章完成记忆、阅读与练习。

BookWords 是一款本地优先的英语词汇学习工具。用户可以从词库或单词本选择目标词，也可以延续近三天的学习节奏；系统会先判断哪些单词适合在同一篇文章中自然表达，再结合原创主题或知乎内容素材，生成双语英语日报和填空练习。

## 核心体验

- **语境记忆**：根据词义和共同场景进行成文分组，而不是机械按词性或难度分类。
- **连续学习**：支持当前词汇池与近 3 日学习词汇，避免每天打乱后从头记忆。
- **双语呈现**：生成前可选择英文或中文主视图，同时保存完整英文正文和中文对照。
- **知乎选材**：支持知乎搜索、热榜、故事与知识内容，保留来源归属和原链接。
- **记忆闭环**：从选词、生文、阅读，到目标词填空练习和学习记录归档。
- **周期刊物**：日报可自动聚合为周刊和月刊词汇地图，聚合过程不调用模型。
- **本地优先**：学习记录默认保存在浏览器；登录后可保存到本机 AES-GCM 加密账户。

## 工作流程

```text
词库 / 单词本 / 近三日学习记录
              │
              ▼
     语境排序 Skill
  判断哪些词能够共同成文
              │
              ▼
       题材约束选择
 原创 / 知乎搜索 / 热榜 / 故事 / 知识
              │
              ▼
       生文 Skill
 生成英文正文、中文对照与记忆句
              │
              ▼
 阅读器 / 填空练习 / 日报存档
              │
              ▼
       周刊与月刊聚合
```

正式文章生成使用设置页配置的 OpenAI 兼容接口。知乎开放平台目前仅用于文章题材选取，知乎直答生成暂未启用。

## AI 与成本策略

- 正式流程最多执行一次语境排序和一次文章生成。
- 排序 Skill 失败时，使用本地语义关键词规则继续分组；不会生成占位文章。
- 单篇文章最多使用 20 个目标词，候选词较多时自动选择最适合共同成文的一组。
- 文章正文目标长度为 180–260 个英文词。
- 只有通过目标词、双语结构、长度和内容安全校验的文章才会保存。
- 合格结果使用短时缓存，避免相同请求重复消耗额度。
- 周刊和月刊只做本地聚合，模型调用数为零。

## 技术栈

- Python 3.11+
- Flask
- 原生 HTML、CSS 与 JavaScript ES Modules
- OpenAI 兼容 Chat Completions API
- 知乎开放平台内容接口
- AES-GCM 本地账户加密

## 快速开始

### Windows

克隆仓库后，可直接运行：

```powershell
.\run.bat
```

脚本会创建虚拟环境、安装依赖并启动服务。浏览器访问：

```text
http://127.0.0.1:5000
```

### 手动启动

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe backend\app.py
```

macOS 或 Linux：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python backend/app.py
```

## API 配置

打开应用右上角的“系统设置”，填写文章生成 API：

| 配置项 | 说明 |
| --- | --- |
| AI 供应商 | DeepSeek、OpenAI 或自定义 OpenAI 兼容接口 |
| Base URL | 例如 `https://api.deepseek.com` 或 `https://api.openai.com/v1` |
| API Key | 对应供应商的密钥 |
| 模型 | 可从接口实时获取，也可手动填写 |

也可使用环境变量：

```text
OPENAI_BASE_URL
OPENAI_API_KEY
OPENAI_MODEL
ZHIHU_ACCESS_SECRET
```

知乎 Access Secret 仅用于搜索、热榜等选材能力，不影响纯原创文章生成。

## 数据与隐私

以下文件只保存在本机，并已加入 `.gitignore`：

```text
backend/settings.json
backend/data/users.json
backend/custom_words.json
backend/runtime/*.jsonl
```

- API Key 不会进入前端状态、Git 仓库或模型调用日志。
- 未登录时，词汇池和文章记录主要存放在浏览器 `localStorage`。
- 登录后，账户学习数据以 AES-GCM 加密形式保存到本机。
- 仓库提供 `backend/settings.example.json` 作为配置结构参考。

## 测试

运行后端测试：

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s backend -p "test_*.py"
```

检查 Python 与 JavaScript 语法：

```powershell
Get-ChildItem backend -Filter *.py -Recurse | ForEach-Object { .\.venv\Scripts\python.exe -m py_compile $_.FullName }
Get-ChildItem frontend -Filter *.js -Recurse | ForEach-Object { node --check $_.FullName }
```

## 项目结构

```text
backend/       Flask API、AI 网关、语境分组、知乎内容与测试
frontend/      应用界面、阅读器、练习和本地状态管理
prompts/       正式生文提示词及版本说明
wordlist/      分级英语词库
run.bat        Windows 一键启动脚本
```

完整词库 JSON 作为本地数据使用，不随仓库分发。请将有权使用的词库文件放入 `wordlist/json/`；仓库只保留目录结构。应用仍可使用“自设单词”功能添加个人词汇。

## 内容说明

- AI 生成文章用于英语学习，不构成新闻、事实判断或专业建议。
- 使用知乎内容作为题材时，应用只提取标题、摘要、作者、标签和链接，并在结果中展示来源。
- 仓库不包含与项目运行无关或权属不明确的第三方角色素材。
