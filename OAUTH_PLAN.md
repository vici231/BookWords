# OAuth 个性化日报接入方案（后续）

当前版本只使用本地账户和知乎开放平台 Access Secret，**不会收集或上传用户的知乎登录凭证**。如果后续需要“根据用户关注、收藏和浏览偏好生成日报”，建议采用 OAuth 2.0 Authorization Code + PKCE：

1. 前端点击“连接知乎”后跳转知乎授权页，使用 `state` 和 PKCE `code_verifier` 防 CSRF 与授权码拦截。
2. 后端回调交换短期 access token，并将 refresh token 加密存储；浏览器只保存不可读的 httpOnly、Secure、SameSite 会话 Cookie。
3. 通过最小权限 scope 读取用户明确授权的关注/收藏主题，建立短期偏好摘要；不保存原始回答全文，不把私密内容发送给模型。
4. 生成请求只携带脱敏后的主题标签和最近偏好，模型仍遵守“摘要、改写、署名、不逐句复制”的规则。
5. 设置页提供“查看已授权范围”和“一键撤销”，撤销后立即删除 token 与偏好缓存。

## 需要新增的接口

- `GET /api/oauth/zhihu/start`：创建 state、PKCE 并返回授权地址。
- `GET /api/oauth/zhihu/callback`：校验 state，交换 token，创建本地会话。
- `GET /api/oauth/zhihu/scopes`：展示当前授权范围（不返回 token）。
- `POST /api/oauth/zhihu/revoke`：撤销授权并清理本地数据。

## 合规边界

- 只申请实现个性化日报所需的最小 scope，并在首次授权前解释用途。
- 任何用户内容都先做长度限制、敏感信息过滤和来源署名；无法确认的事实使用谨慎措辞。
- 生产环境必须使用 HTTPS、密钥管理服务和审计日志；本地演示继续使用 Access Secret，不伪造 OAuth 流程。
