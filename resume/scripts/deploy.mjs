import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../../', import.meta.url));
const remoteScript = new URL('./deploy-remote.sh', import.meta.url);
const allowedExtensions = new Set(['.html', '.css', '.js', '.json', '.xml', '.txt', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.pdf', '.mp4', '.webm']);
const remotePath = /^\/[a-zA-Z0-9_./-]+$/;
const domainPattern = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

export function configuration(env) {
  const required = (name) => {
    if (!env[name]?.trim()) throw new Error(`请在 ~/.zshrc 中 export ${name}，并执行 source ~/.zshrc 后重试。`);
    return env[name].trim();
  };
  const flag = (name, fallback = '1') => {
    const value = env[name] || fallback;
    if (!['0', '1'].includes(value)) throw new Error(`${name} 只能是 0 或 1。`);
    return value;
  };
  const host = required('DEPLOY_HOST');
  const user = env.DEPLOY_USER || 'root';
  const port = env.DEPLOY_PORT || '22';
  const domain = env.DEPLOY_DOMAIN || 'gaoyanbing.com';
  const auth = env.DEPLOY_AUTH || (env.DEPLOY_PASSWORD ? 'password' : 'key');
  if (!['password', 'key'].includes(auth)) throw new Error('DEPLOY_AUTH 只能是 password 或 key。');
  if (auth === 'password' && !env.DEPLOY_PASSWORD) throw new Error('请在 ~/.zshrc 中 export DEPLOY_PASSWORD，填写 ECS 登录密码后执行 source ~/.zshrc。');
  if (auth === 'password' && /[\r\n\0]/.test(env.DEPLOY_PASSWORD)) throw new Error('DEPLOY_PASSWORD 不能包含换行或空字符。');
  const base = env.DEPLOY_ROOT || '/var/www/folio';
  const cert = env.DEPLOY_TLS_CERT || '';
  const tlsKey = env.DEPLOY_TLS_KEY || '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) throw new Error('DEPLOY_HOST 必须是 IPv4、域名或 SSH 配置别名。');
  if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) throw new Error('DEPLOY_USER 格式无效。');
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('DEPLOY_PORT 格式无效。');
  if (!domainPattern.test(domain)) throw new Error('DEPLOY_DOMAIN 必须是域名，不含协议、端口或路径。');
  const validPath = (value) => remotePath.test(value) && !value.split('/').some((part) => ['.', '..'].includes(part)) && !value.includes('//') && !value.endsWith('/');
  if (!validPath(base) || !/^\/(var\/www|srv\/www|www\/wwwroot)\/[^/]+/.test(base)) throw new Error('DEPLOY_ROOT 必须是 /var/www、/srv/www 或 /www/wwwroot 下的独立网站目录。');
  if (Boolean(cert) !== Boolean(tlsKey) || [cert, tlsKey].some((value) => value && !validPath(value))) throw new Error('DEPLOY_TLS_CERT 和 DEPLOY_TLS_KEY 必须同时设置为服务器上的绝对路径。');
  const siteUrl = new URL(env.DEPLOY_SITE_URL || `${cert ? 'https' : 'http'}://${domain}`);
  if (!['http:', 'https:'].includes(siteUrl.protocol) || siteUrl.hostname !== domain.toLowerCase() || siteUrl.port || siteUrl.username || siteUrl.password || siteUrl.pathname !== '/' || siteUrl.search || siteUrl.hash) throw new Error('DEPLOY_SITE_URL 必须是部署域名的 HTTP(S) 根地址。');
  const keyPath = auth === 'key' ? env.DEPLOY_SSH_KEY || '' : '';
  if (keyPath && (!/^(\/|~\/)/.test(keyPath) || /[\r\n]|PRIVATE KEY/.test(keyPath))) throw new Error('DEPLOY_SSH_KEY 只能填写本机绝对路径或 ~/ 路径，不能填写密钥正文。');
  const identity = keyPath ? resolve(keyPath.replace(/^~\//, `${homedir()}/`)) : '';
  return { host, user, port, domain, base, cert, tlsKey, identity, auth, siteUrl: siteUrl.origin,
    manage: flag('DEPLOY_MANAGE_NGINX'), install: flag('DEPLOY_INSTALL_NGINX') };
}

export function buildEnvironment(env, siteUrl) {
  // Deployment credentials never enter npm/Astro's environment.
  const safe = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'SYSTEMROOT', 'CI']
    .filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
  return { ...safe, SITE_URL: siteUrl };
}

export function sshArguments(config) {
  return ['-T', '-p', config.port, '-o', `BatchMode=${config.auth === 'password' ? 'no' : 'yes'}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    ...(config.auth === 'password' ? ['-o', 'PreferredAuthentications=password', '-o', 'PasswordAuthentication=yes', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1'] : []),
    ...(config.identity ? ['-i', config.identity, '-o', 'IdentitiesOnly=yes'] : []), `${config.user}@${config.host}`];
}

export async function withSshEnvironment(config, action, env = process.env) {
  if (config.auth !== 'password') return action(env);
  const directory = await mkdtemp(join(tmpdir(), 'folio-askpass-'));
  try {
    const helper = join(directory, 'askpass.sh');
    // OpenSSH reads the response through its private askpass pipe. No password is
    // written to this helper or passed as a command-line argument.
    await writeFile(helper, `#!/bin/sh
case "\${1-}" in
  *"'s password: "|*"'s password:") printf '%s\\n' "$FOLIO_SSH_PASSWORD" ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
    const sshEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('DEPLOY_')));
    return await action({ ...sshEnv, DISPLAY: env.DISPLAY || 'folio-deploy', SSH_ASKPASS: helper,
      SSH_ASKPASS_REQUIRE: 'force', FOLIO_SSH_PASSWORD: env.DEPLOY_PASSWORD });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

export async function inspectArtifacts(directory) {
  const files = [];
  async function walk(folder) {
    for (const name of await readdir(folder)) {
      const path = join(folder, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || /^\.|^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i.test(name)) throw new Error('构建目录含隐藏文件、密钥文件或符号链接，已停止上传。');
      if (stat.isDirectory()) await walk(path);
      else {
        if (!stat.isFile() || !allowedExtensions.has(extname(name).toLowerCase())) throw new Error('构建目录含非静态资源文件，已停止上传。');
        const content = await readFile(path);
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content.toString('utf8'))) throw new Error('构建目录检测到私钥内容，已停止上传。');
        files.push(path);
      }
    }
  }
  await walk(directory);
  await access(join(directory, 'index.html'));
  return files;
}

function run(command, args, { env = process.env, input, capture = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: project, env, stdio: [input ? 'pipe' : 'ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
    let output = '';
    if (capture) child.stdout.on('data', (chunk) => { output += chunk; });
    if (input) {
      child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error); });
      if (typeof input === 'string' || Buffer.isBuffer(input)) child.stdin.end(input);
      else { input.on('error', reject); input.pipe(child.stdin); }
    }
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolveRun(output.trim()) : reject(new Error(`${command} 执行失败（${code}）。`)));
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('用法：npm run deploy [-- --dry-run | --check]\n配置：仅读取终端环境变量；在 ~/.zshrc 中 export 后执行 source ~/.zshrc。\n--dry-run 仅检查本地配置，不构建、不连接服务器。\n--check   检查 SSH、权限、Nginx 和站点冲突，不修改服务器。\n不带参数：本地安装依赖并构建、上传、切换版本和健康检查，失败自动回退。');
    return;
  }
  if (args.length > 1 || args.some((arg) => !['--dry-run', '--check'].includes(arg))) throw new Error('未知参数，请运行 npm run deploy -- --help。');
  const config = configuration(process.env);
  if (config.identity) {
    const stat = await lstat(config.identity).catch(() => { throw new Error('无法读取 SSH 私钥，请检查 DEPLOY_SSH_KEY 指向的本机文件。'); });
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('SSH 私钥必须是仅当前用户可读的文件，请执行 chmod 600 私钥路径。');
  }
  if (args[0] === '--dry-run') {
    console.log(`配置有效。将通过 SSH ${config.auth === 'password' ? '密码' : '密钥/agent'}认证部署静态文件；凭据不会进入构建环境或上传包。尚未连接服务器。`);
    return;
  }
  await withSshEnvironment(config, (sshEnv) => executeDeployment(config, args[0] === '--check', sshEnv));
}

async function executeDeployment(config, checkOnly, sshEnv) {
  const ssh = (command, options) => run('ssh', [...sshArguments(config), command], { ...options, env: sshEnv });
  const remote = await readFile(remoteScript, 'utf8');
  const common = [config.domain, config.base, config.manage, config.install, config.cert, config.tlsKey];
  const privileged = config.user === 'root' ? 'bash' : 'sudo -n bash';
  const invoke = (mode, more = []) => ssh(`${privileged} -s -- ${[mode, ...common, ...more].map(quote).join(' ')}`, { input: remote });
  console.log('检查 SSH 权限及远端站点环境…');
  await invoke('check');
  if (checkOnly) return;
  console.log('安装本地依赖并构建静态网站…');
  const env = buildEnvironment(process.env, config.siteUrl);
  await run('npm', ['ci', '--no-audit', '--no-fund'], { env });
  await run('npm', ['run', 'build'], { env });
  const dist = join(project, 'resume/dist');
  const work = await mkdtemp(join(tmpdir(), 'folio-deploy-'));
  let upload;
  try {
    const staging = join(work, 'site');
    await cp(dist, staging, { recursive: true });
    await inspectArtifacts(staging);
    const release = `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(6).toString('hex')}`;
    await writeFile(join(staging, '__folio_release.txt'), `${release}\n`);
    const archive = join(work, 'site.tar.gz');
    await run('tar', ['-czf', archive, '-C', staging, '.'], { env: { ...env, COPYFILE_DISABLE: '1' } });
    const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
    upload = await ssh('umask 077; mktemp -d /tmp/folio-upload.XXXXXXXX', { capture: true });
    if (!/^\/tmp\/folio-upload\.[a-zA-Z0-9]{8}$/.test(upload)) { upload = undefined; throw new Error('远端临时目录响应异常，已停止上传。'); }
    console.log('上传静态文件，切换版本并验证站点…');
    await ssh(`umask 077; cat > ${quote(`${upload}/site.tar.gz`)}`, { input: createReadStream(archive) });
    await invoke('deploy', [upload, release, checksum]);
    console.log('部署完成。请确认域名解析和 ECS 安全组已配置；动态贡献数据无需重新部署。');
  } finally {
    await rm(work, { recursive: true, force: true });
    if (upload) await ssh(`rm -f -- ${quote(`${upload}/site.tar.gz`)}; rmdir -- ${quote(upload)}`).catch(() => console.error('远端上传临时文件清理失败，可稍后清理 /tmp/folio-upload.*。'));
  }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`部署未完成：${error.message}`); process.exitCode = 1; });
}
