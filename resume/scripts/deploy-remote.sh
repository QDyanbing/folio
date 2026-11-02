#!/usr/bin/env bash
# Invoked over SSH by deploy.mjs. No credentials or environment files are uploaded.
set -Eeuo pipefail
umask 022

fail() { printf '%s\n' "$*" >&2; exit 1; }

preflight() {
  [[ $EUID == 0 ]] || fail '需要 root 或 sudo -n 权限。'
  for tool in tar sha256sum curl systemctl; do command -v "$tool" >/dev/null || fail "服务器缺少 $tool。"; done
  [[ ! -L $BASE ]] || fail '部署根目录不能是符号链接。'
  [[ $(readlink -m "$BASE") == "$BASE" ]] || fail '部署路径包含符号链接，请使用真实的独立目录。'
  if [[ -e $BASE ]]; then
    [[ -f $BASE/.folio-deploy && $(cat "$BASE/.folio-deploy") == "$DOMAIN" ]] || fail '目标目录已存在且不属于本脚本；请使用新的 DEPLOY_ROOT，现有文件未修改。'
  fi
  if [[ -e $BASE/current || -L $BASE/current ]]; then
    [[ -L $BASE/current && $(readlink "$BASE/current") == "$BASE/releases/"* ]] || fail 'current 不是本脚本的版本链接，已停止。'
  fi
  if [[ -n $TLS_CERT ]]; then
    [[ -s $TLS_CERT && -r $TLS_CERT && -s $TLS_KEY && -r $TLS_KEY ]] || fail '服务器上的 TLS 证书或私钥不可读。'
  fi
  if [[ $MANAGE == 1 ]]; then
    command -v systemctl >/dev/null || fail '自动配置需要 systemd 管理的 Nginx。'
    if command -v nginx >/dev/null; then
      [[ $(nginx -V 2>&1) == *'--conf-path=/etc/nginx/nginx.conf'* ]] || fail '检测到面板或自定义 Nginx，请设置 DEPLOY_MANAGE_NGINX=0，并将站点根目录配置为 DEPLOY_ROOT/current。'
      nginx -t || fail '现有 Nginx 配置检查失败，未修改站点。'
      [[ ! -L $CONF ]] || fail '同名 Nginx 配置是符号链接，请复用已有站点配置。'
      if [[ -e $CONF ]]; then
        [[ $(head -n 1 "$CONF") == "# folio-managed: $DOMAIN $BASE" ]] || fail '同名 Nginx 配置不属于本脚本，已停止。'
      fi
      local conflict
      conflict=$(nginx -T 2>/dev/null | awk -v domain="$DOMAIN" -v own="$CONF:" '
        /^# configuration file / { file=$4 }
        /^[[:space:]]*server_name[[:space:]]/ && file != own {
          gsub(/;/, " "); for (i=2; i<=NF; i++) if ($i == domain) found=1
        }
        END { if (found) print "yes" }')
      [[ -z $conflict ]] || fail '域名已有其他 Nginx 站点配置，请复用现有配置并设置 DEPLOY_MANAGE_NGINX=0。'
    else
      [[ ! -d /www/server/panel && ! -d /opt/1panel && ! -x /usr/local/nginx/sbin/nginx ]] || fail '检测到面板/自定义安装，请先配置现有站点，再使用 DEPLOY_MANAGE_NGINX=0。'
      [[ $INSTALL == 1 ]] || fail '未安装 Nginx；允许使用系统软件源安装时设置 DEPLOY_INSTALL_NGINX=1。'
      printf '%s\n' '尚未安装 Nginx，部署时将尝试系统软件源；不会改写 yum/apt 源。'
    fi
  fi
}

install_nginx() {
  [[ $MANAGE == 1 ]] || return 0
  command -v nginx >/dev/null && return 0
  if command -v apt-get >/dev/null; then
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y nginx || fail 'Nginx 安装失败，请检查系统软件源。'
  elif command -v yum >/dev/null; then
    yum install -y nginx || fail 'Nginx 安装失败。CentOS 7 可能缺少有效的 Nginx 软件源；请修复软件源或在已有面板中安装 Nginx 后重试。没有改写系统软件源。'
  else
    fail '未找到支持的包管理器，请先安装 Nginx。'
  fi
  preflight
}

make_config() {
  local listener=80
  [[ -z $TLS_CERT ]] || listener='443 ssl'
  printf '# folio-managed: %s %s\n' "$DOMAIN" "$BASE"
  if [[ -n $TLS_CERT ]]; then
    cat <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://$DOMAIN\$request_uri;
}
EOF
  fi
  cat <<EOF
server {
    listen $listener;
    server_name $DOMAIN;
    root $BASE/current;
    index index.html;
    charset utf-8;
    add_header Cache-Control "no-cache";
    location / { try_files \$uri \$uri/ =404; }
    location /_astro/ {
        alias $BASE/assets/;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
EOF
  if [[ -n $TLS_CERT ]]; then
    printf '    ssl_certificate %s;\n    ssl_certificate_key %s;\n    ssl_protocols TLSv1.2 TLSv1.3;\n' "$TLS_CERT" "$TLS_KEY"
  fi
  printf '}\n'
}

switch_current() {
  ln -s "$1" "$BASE/.current-next"
  mv -Tf "$BASE/.current-next" "$BASE/current"
}

cleanup() {
  local code=$?
  trap - EXIT
  set +e
  if [[ ${ROLLBACK:-0} == 1 ]]; then
    printf '%s\n' '验证失败，正在恢复上一版…' >&2
    rm -f "$BASE/.current-next"
    if [[ -n $OLD_CURRENT ]]; then switch_current "$OLD_CURRENT"; else rm -f "$BASE/current"; fi
    if [[ $MANAGE == 1 ]]; then
      if [[ $HAD_CONF == 1 ]]; then cp -p "$WORK/previous.conf" "$CONF"; else rm -f "$CONF"; fi
      if [[ $WAS_ACTIVE == 1 ]]; then
        nginx -t && systemctl reload nginx || printf '%s\n' '恢复配置后 Nginx 重载失败，请检查服务。' >&2
      else
        systemctl stop nginx || true
      fi
    fi
  fi
  [[ -z ${WORK:-} ]] || rm -rf -- "$WORK"
  [[ ${LOCKED:-0} != 1 ]] || rmdir "$BASE/.deploy-lock"
  exit "$code"
}

healthy() {
  local protocol=http body
  [[ -z $TLS_CERT ]] || protocol=https
  for attempt in 1 2 3 4 5; do
    body=$(curl --silent --show-error --fail --location --noproxy '*' --max-redirs 3 --connect-timeout 3 --max-time 10 \
      --resolve "$DOMAIN:80:127.0.0.1" --resolve "$DOMAIN:443:127.0.0.1" \
      "$protocol://$DOMAIN/__folio_release.txt" 2>/dev/null) || body=''
    [[ $body != "$RELEASE" ]] || return 0
    sleep 1
  done
  return 1
}

deploy() {
  [[ $(sha256sum "$UPLOAD/site.tar.gz" | cut -d ' ' -f 1) == "$CHECKSUM" ]] || fail '上传文件校验失败，站点未修改。'
  install_nginx
  if [[ ! -d $BASE ]]; then
    install -d -m 755 "$BASE"
    printf '%s\n' "$DOMAIN" > "$BASE/.folio-deploy"
  fi
  mkdir "$BASE/.deploy-lock" || fail '已有部署进行中；如上次连接中断，请确认无部署进程后清理 .deploy-lock。'
  LOCKED=1
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  WORK=$(mktemp -d /tmp/folio-activate.XXXXXXXX)
  chmod 700 "$WORK"
  install -d -m 755 "$BASE/releases" "$BASE/assets"
  local target="$BASE/releases/$RELEASE"
  mkdir "$target"
  tar -xzf "$UPLOAD/site.tar.gz" --no-same-owner --no-same-permissions -C "$target"
  [[ -f $target/index.html && $(cat "$target/__folio_release.txt") == "$RELEASE" ]] || fail '上传包内容不完整。'
  find "$target" -type d -exec chmod 755 {} +
  find "$target" -type f -exec chmod 644 {} +
  [[ ! -d $target/_astro ]] || cp -an "$target/_astro/." "$BASE/assets/"
  if command -v getenforce >/dev/null && [[ $(getenforce) != Disabled ]]; then
    chcon -R -t httpd_sys_content_t "$target" "$BASE/assets" || fail 'SELinux 网站文件权限配置失败。'
    chcon -t httpd_sys_content_t "$BASE" "$BASE/releases" || fail 'SELinux 网站目录权限配置失败。'
  fi
  OLD_CURRENT=$(readlink "$BASE/current" || true)
  HAD_CONF=0
  WAS_ACTIVE=0
  if [[ $MANAGE == 1 ]]; then
    if [[ -e $CONF ]]; then cp -p "$CONF" "$WORK/previous.conf"; HAD_CONF=1; fi
    if systemctl is-active --quiet nginx; then WAS_ACTIVE=1; fi
    make_config > "$WORK/site.conf"
  fi
  ROLLBACK=1
  if [[ $MANAGE == 1 ]]; then install -m 644 "$WORK/site.conf" "$CONF"; fi
  switch_current "$target"
  if [[ $MANAGE == 1 ]]; then
    nginx -t
    if [[ $WAS_ACTIVE == 1 ]]; then systemctl reload nginx; else systemctl start nginx; fi
  fi
  healthy || fail '本机 HTTP(S) 检查未返回新版本，部署失败。请检查站点 root、证书、端口和 SELinux。'
  if [[ $MANAGE == 1 && $WAS_ACTIVE == 0 ]]; then systemctl enable nginx; fi
  ROLLBACK=0
  printf '%s\n' '新版本已启用；此前版本与带哈希的静态资源已保留。'
}

main() {
  MODE=$1 DOMAIN=$2 BASE=$3 MANAGE=$4 INSTALL=$5 TLS_CERT=$6 TLS_KEY=$7
  export PATH="/usr/local/sbin:/usr/sbin:/sbin:$PATH"
  CONF="/etc/nginx/conf.d/folio-$DOMAIN.conf"
  preflight
  if [[ $MODE == check ]]; then printf '%s\n' '远端预检查通过。'; return; fi
  [[ $MODE == deploy ]] || fail '无效部署模式。'
  UPLOAD=$8 RELEASE=$9 CHECKSUM=${10}
  [[ $UPLOAD =~ ^/tmp/folio-upload\.[a-zA-Z0-9]{8}$ && $RELEASE =~ ^[0-9TZ]+-[a-f0-9]{12}$ && $CHECKSUM =~ ^[a-f0-9]{64}$ ]] || fail '部署参数无效。'
  deploy
}

if [[ -z ${BASH_SOURCE[0]:-} || ${BASH_SOURCE[0]:-} == "$0" ]]; then main "$@"; fi
