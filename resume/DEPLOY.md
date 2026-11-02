# 一键部署到 ECS

部署在本机执行，服务器只托管静态文件，不运行 Node.js。第一次配置完成后，每次更新运行：

```sh
npm run deploy
```

## 一次性配置

本机使用项目要求的 Node.js 24，并准备 `ssh`、`tar`。将部署环境变量添加到项目之外的 `~/.zshrc`，把示例值替换为实际配置：

```sh
export DEPLOY_HOST='你的ECS公网IP'
export DEPLOY_USER='root'
export DEPLOY_DOMAIN='gaoyanbing.com'
export DEPLOY_AUTH='password'
export DEPLOY_PASSWORD='你的ECS登录密码'
```

在当前终端加载配置，或重新打开一个终端：

```sh
source ~/.zshrc
```

密码模式自动读取 `DEPLOY_PASSWORD`，无需配置 SSH 私钥。这里是 ECS 登录账号的密码，不是阿里云控制台密码。脚本通过 OpenSSH 的 askpass 通道提供密码，不把密码拼进命令参数或临时脚本；临时脚本只引用环境变量，结束后删除。密码错误时单次连接只尝试一次。需要本机 OpenSSH 支持 `SSH_ASKPASS_REQUIRE=force`，以及 ECS 的 SSH 服务允许密码认证。

如需密钥模式，改为 `export DEPLOY_AUTH='key'`，并设置 `export DEPLOY_SSH_KEY="$HOME/.ssh/你的SSH私钥"`。只填本机路径，**不填私钥正文**。私钥保存在仓库之外，权限为 `600`；路径也可以留空，复用 `~/.ssh/config` 或 `ssh-agent`。带密码的私钥先用 `ssh-add` 加入 agent。

先使用终端正常连接一次 ECS，核对服务器指纹并让 SSH 保存到 `known_hosts`。例如将下面的地址替换为实际地址：

```sh
ssh root@你的ECS公网IP
```

脚本启用严格主机密钥校验，不会跳过指纹检查。首次未信任的服务器、指纹变化、SSH 身份验证失败都会停止。非 root 账号仍需要 `sudo -n` 权限；登录密码不会用于 sudo，也不会修改服务器 SSH 登录设置。无需阿里云 AccessKey 或 GitHub Token。

脚本只读取启动进程继承的环境变量，不读取项目中的 `.env` 文件，也不会自行加载或修改 `~/.zshrc`。使用 `export` 才能让 `npm run deploy` 继承配置。以下可选配置也统一在 `~/.zshrc` 中导出。

| 配置 | 默认值 / 用途 |
| --- | --- |
| `DEPLOY_HOST` | 必填，公网 IPv4、域名或 SSH 配置别名 |
| `DEPLOY_USER` | `root` |
| `DEPLOY_PORT` | `22`；使用 SSH 别名的非标准端口时也需要设置 |
| `DEPLOY_AUTH` | `password` 或 `key`；未设置时有密码则用密码，否则用密钥 |
| `DEPLOY_PASSWORD` | 密码模式必填，ECS 登录账号的密码，只放在本机 `~/.zshrc` |
| `DEPLOY_DOMAIN` | `gaoyanbing.com` |
| `DEPLOY_ROOT` | `/var/www/folio`；必须是独立的新目录，脚本会自行创建 |
| `DEPLOY_SSH_KEY` | 仅密钥模式使用；可选，本机 SSH 私钥的绝对路径 |
| `DEPLOY_MANAGE_NGINX` | `1` 自动管理独立站点；面板/已有站点设为 `0` |
| `DEPLOY_INSTALL_NGINX` | `1` 缺少 Nginx 时通过现有系统软件源安装；设为 `0` 禁止安装 |
| `DEPLOY_TLS_CERT` | 可选，服务器上已安装的证书链文件绝对路径 |
| `DEPLOY_TLS_KEY` | 可选，服务器上已安装的证书私钥绝对路径 |
| `DEPLOY_SITE_URL` | 默认依据 TLS 配置生成 HTTP/HTTPS 地址；已有 HTTPS 代理时可显式指定 |

## 预检查与正式部署

```sh
# 本地配置检查：不联网、不构建、不修改服务器
npm run deploy -- --dry-run

# SSH、权限和站点冲突检查：不修改服务器
npm run deploy -- --check

# 正式部署
npm run deploy
```

正式部署会依次执行：

1. 检查 SSH、root/sudo、现有站点和 TLS 文件路径。
2. 在本机运行 `npm ci`、`npm run build`，根据部署域名生成 SEO 地址。
3. 检查 `resume/dist`，拒绝隐藏文件、符号链接、私钥内容和非静态文件，只上传静态产物。
4. 校验上传包的 SHA-256，生成独立版本目录，通过 `current` 链接切换版本。
5. 检查 Nginx 配置，重载或启动服务，并通过本机 HTTP(S) 请求确认实际返回的是新版本。
6. 验证失败时恢复原来的版本链接和站点配置。成功后保留历史版本及哈希资源，避免已打开页面的延迟加载资源失效。

目标目录若已存在但没有脚本的所有权标记，部署会停止；已有同域名站点也会停止，避免覆盖其他业务。安装 Nginx 的软件包不会在失败后卸载。部署不会删除历史版本；低频更新占用较少，长期使用后可按需清理不再使用的版本。

`--check` 通过只表示当前预检查通过。它不会安装缺失的软件，也不能保证软件源可用、域名已解析或公网端口已放行。正式部署的健康检查验证本机站点，不代表公网已连通。

## CentOS 7 与已有面板

支持使用 CentOS 7 上已有的标准 Nginx。自动安装只使用服务器已配置的 `yum` 源；没有 Nginx 包、软件源过期或依赖异常时会明确失败，**不会替换全局 yum 源、升级操作系统或安装面板**。CentOS 7 已停止维护，详情见 [阿里云说明](https://help.aliyun.com/zh/ecs/user-guide/options-for-dealing-with-centos-linux-end-of-life)。

如果使用宝塔、1Panel、自定义 Nginx，或域名已有站点，设置：

```sh
export DEPLOY_MANAGE_NGINX=0
export DEPLOY_INSTALL_NGINX=0
# 已有 HTTPS 网站时设置
export DEPLOY_SITE_URL=https://gaoyanbing.com
```

修改后执行 `source ~/.zshrc`，再运行部署命令。

在现有站点中一次性配置根目录与哈希资源目录（路径对应 `DEPLOY_ROOT`）：

```nginx
root /var/www/folio/current;
index index.html;
location / {
    try_files $uri $uri/ =404;
}
location /_astro/ {
    alias /var/www/folio/assets/;
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

此模式只切换静态文件，不写 Nginx 配置、不安装/重载服务。已有服务需监听本机 80 或 443 端口，允许根据部署域名访问 `__folio_release.txt`。如果站点强制 HTTPS 跳转，证书必须有效。后续更新仍然只运行 `npm run deploy`。

## 域名、端口与 HTTPS

- 将域名的 `A` 记录指向 ECS 公网 IP，放行安全组和系统防火墙的 80/443 端口。脚本不操作云账号或修改服务器防火墙。
- 首次没有证书时以 HTTP 部署，构建的 canonical 也会使用 HTTP。
- 已有证书时，在 `DEPLOY_TLS_CERT` / `DEPLOY_TLS_KEY` 填服务器路径，重新部署会开启 HTTPS、HTTP 跳转与 HTTPS canonical。证书及其私钥不会通过本机上传。
- 证书申请与续期由现有面板/证书工具负责，脚本不会申请证书或自动续期；已有 HTTPS 代理用 `DEPLOY_SITE_URL` 指定实际公网地址。
- 中国大陆 ECS 对外提供网站服务前需完成域名备案，见 [阿里云备案说明](https://www.alibabacloud.com/help/en/icp-filing/basic-icp-service/product-overview/icp-filing-requirements-for-a-regular-website)。

## 开源仓库中的敏感信息

实际部署配置保存在项目之外的 `~/.zshrc`，仓库中只保留文档里的占位示例。`.env.*` 与常见私钥文件名仍加入 `.gitignore` 作为误放文件时的额外保护；这不会撤回过去已经提交的文件，因此不要把实际密钥存进仓库。

部署配置不会传给 npm/Astro 构建进程，上传包只来自 `resume/dist`。登录密码仅用于 SSH 认证，不写入命令参数、临时脚本、日志或构建产物；SSH 私钥由本机 OpenSSH 读取，不会发送到服务器；服务器的 TLS 私钥也只按路径引用。脚本不打印部署环境变量，不使用 `set -x`，不把个人服务器地址写入源码或 GitHub 工作流。

当前 GitHub Actions 继续只负责检查和构建，不会在公开仓库的 PR 上连接 ECS。
