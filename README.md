# Folio

个人网站仓库。目前包含由 Markdown 驱动的静态简历，所有相关内容和实现位于 [`resume/`](resume/README.md)。

```sh
npm ci
npm run dev
```

生产构建：`npm run build`，将 `resume/dist/` 部署到静态托管服务即可。

ECS 一键部署：按 [`resume/DEPLOY.md`](resume/DEPLOY.md) 在 `~/.zshrc` 中导出部署环境变量后运行 `npm run deploy`。支持密码或密钥登录；服务器与登录配置仅保存在项目外，不提交实际凭据。
