# 黑客松提交前检查清单

## Demo 主路径

1. 双击 `run.bat` 启动 Flask 服务。
2. 在「系统设置」配置 OpenAI 兼容模型；知乎故事/知识列表无需 Access Secret，可直接演示。
3. 词汇池加入 3–30 个单词，选择「知乎知识」或「知乎故事」，挑选一个主题后生成日报。
4. 展示英文正文、目标词加粗、Takeaway、中文词义、填空练习和日报存档。
5. 若演示热榜，提前在后端配置 `ZHIHU_ACCESS_SECRET`；未配置时应展示友好降级提示，不影响主路径。

## 安全与合规

- 不将 `backend/settings.json`、API Key、Access Secret 提交到仓库。
- 知乎内容只做摘要和改写，页面保留来源署名；不逐句翻译或伪装为原作者/真实新闻。
- 生成请求限制为最多 30 张词卡、单卡短字段和 512KB JSON body。
- AI 输出经过 JSON、长度、目标词、敏感内容和文章结构校验；失败时返回可解释错误。
- 当前版本不模拟知乎 OAuth、不保存用户知乎登录凭证；后续设计见 `OAUTH_PLAN.md`。

## 自动检查

```powershell
python -m compileall -q backend
Get-ChildItem frontend/js -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
```
