import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readlink, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuration, buildEnvironment, sshArguments, withSshEnvironment, inspectArtifacts, quote } from '../scripts/deploy.mjs';

const script = fileURLToPath(new URL('../scripts/deploy-remote.sh', import.meta.url));
const env = { DEPLOY_HOST: 'ecs.example.com' };

test('deployment reads exported variables and ignores legacy project environment files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'folio-env-test-'));
  try {
    const entry = join(root, 'resume/scripts/deploy.mjs');
    await mkdir(join(root, 'resume/scripts'), { recursive: true });
    await writeFile(entry, await readFile(new URL('../scripts/deploy.mjs', import.meta.url)));
    await writeFile(join(root, '.env.deploy.local'), 'DEPLOY_HOST=legacy-private.example.com\n');
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEPLOY_')));
    const missing = spawnSync(process.execPath, [entry, '--dry-run'], { env: clean, encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /~\/.zshrc.*export DEPLOY_HOST/);
    const exported = spawnSync(process.execPath, [entry, '--dry-run'], { env: { ...clean, ...env }, encoding: 'utf8' });
    assert.equal(exported.status, 0, exported.stderr);
    assert.match(exported.stdout, /尚未连接服务器/);
    assert.doesNotMatch(exported.stdout + exported.stderr, /legacy-private/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deployment rejects command injection, unsafe target paths and partial TLS configuration', () => {
  for (const entry of [
    { DEPLOY_HOST: '-oProxyCommand=touch pwned' }, { DEPLOY_DOMAIN: 'example.com;id' },
    { DEPLOY_ROOT: '/etc/nginx' }, { DEPLOY_ROOT: '/var/www/../etc' },
    { DEPLOY_ROOT: '/var/www/app/../../etc' }, { DEPLOY_PORT: '99999' },
    { DEPLOY_TLS_KEY: '/etc/secret.key' }, { DEPLOY_SITE_URL: 'https://other.example.com' },
    { DEPLOY_MANAGE_NGINX: 'yes' },
    { DEPLOY_SSH_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-path' },
  ]) assert.throws(() => configuration({ ...env, ...entry }));
  assert.equal(configuration(env).siteUrl, 'http://gaoyanbing.com');
  assert.equal(configuration({ ...env, DEPLOY_TLS_CERT: '/etc/tls/fullchain.pem', DEPLOY_TLS_KEY: '/etc/tls/private.key' }).siteUrl, 'https://gaoyanbing.com');
  const escaped = quote("a'$(touch /tmp/not-executed)");
  const result = spawnSync('bash', ['-c', `printf '%s' ${escaped}`], { encoding: 'utf8' });
  assert.equal(result.stdout, "a'$(touch /tmp/not-executed)");
});

test('build receives only runtime variables and SSH retains strict host identity checking', () => {
  const build = buildEnvironment({ PATH: '/usr/bin', HOME: '/home/test', DEPLOY_SSH_KEY: 'private-path', PUBLIC_SECRET: 'never-embed', AWS_SECRET_ACCESS_KEY: 'never-embed' }, 'https://example.com');
  assert.deepEqual(build, { PATH: '/usr/bin', HOME: '/home/test', SITE_URL: 'https://example.com' });
  const args = sshArguments(configuration(env));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(!args.some((arg) => /accept-new|StrictHostKeyChecking=no/.test(arg)));
});

test('password authentication requires a usable password and does not load a private key', () => {
  for (const entry of [
    { DEPLOY_AUTH: 'unknown' },
    { DEPLOY_AUTH: 'password' },
    { DEPLOY_PASSWORD: 'line\nbreak' },
    { DEPLOY_PASSWORD: 'line\rbreak' },
    { DEPLOY_PASSWORD: 'null\0byte' },
  ]) assert.throws(() => configuration({ ...env, ...entry }));
  const password = ' fake-test-password ';
  const config = configuration({ ...env, DEPLOY_PASSWORD: password, DEPLOY_SSH_KEY: '/unused/key' });
  assert.equal(config.auth, 'password');
  assert.equal(config.identity, '');
  assert.equal(configuration({ ...env, DEPLOY_AUTH: 'key', DEPLOY_PASSWORD: password }).auth, 'key');
  const args = sshArguments(config);
  for (const value of ['BatchMode=no', 'StrictHostKeyChecking=yes', 'PreferredAuthentications=password', 'PasswordAuthentication=yes', 'PubkeyAuthentication=no', 'NumberOfPasswordPrompts=1']) {
    assert.ok(args.includes(value));
  }
  assert.ok(!args.includes('-i'));
  assert.ok(!JSON.stringify({ config, args }).includes(password));
});

test('askpass preserves special characters, refuses unrelated prompts and cleans up on success or failure', async () => {
  const password = " fake-'\"$`\\ !-test-password ";
  const sourceEnv = { PATH: process.env.PATH, ...env, DEPLOY_AUTH: 'password', DEPLOY_PASSWORD: password };
  const config = configuration(sourceEnv);
  for (const fail of [false, true]) {
    let helper;
    const action = withSshEnvironment(config, async (sshEnv) => {
      helper = sshEnv.SSH_ASKPASS;
      assert.equal(sshEnv.SSH_ASKPASS_REQUIRE, 'force');
      assert.equal(sshEnv.FOLIO_SSH_PASSWORD, password);
      assert.ok(!Object.keys(sshEnv).some((key) => key.startsWith('DEPLOY_')));
      assert.ok(!(await readFile(helper, 'utf8')).includes(password));
      assert.equal((await stat(helper)).mode & 0o777, 0o700);
      assert.equal((await stat(join(helper, '..'))).mode & 0o777, 0o700);
      for (const prompt of ["root@ecs.example.com's password: ", "root@ecs.example.com's password:"]) {
        const answer = spawnSync(helper, [prompt], { env: sshEnv, encoding: 'utf8' });
        assert.equal(answer.status, 0, answer.stderr);
        assert.equal(answer.stdout, `${password}\n`);
      }
      for (const prompt of ['Are you sure you want to continue connecting?', 'Enter new password:']) {
        const answer = spawnSync(helper, [prompt], { env: sshEnv, encoding: 'utf8' });
        assert.equal(answer.status, 1);
        assert.equal(answer.stdout + answer.stderr, '');
      }
      assert.ok(!JSON.stringify(buildEnvironment(sshEnv, config.siteUrl)).includes(password));
      if (fail) throw new Error('simulated SSH failure');
    }, sourceEnv);
    if (fail) await assert.rejects(action, /simulated SSH failure/);
    else await action;
    await assert.rejects(access(helper));
  }
});

test('upload guard rejects environment files, symlinks and private keys even disguised as text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'folio-artifact-test-'));
  try {
    await writeFile(join(root, 'index.html'), '<h1>resume</h1>');
    assert.equal((await inspectArtifacts(root)).length, 1);
    for (const name of ['.env.deploy.local', 'secret.pem', 'secret.txt']) {
      await writeFile(join(root, name), '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n');
      await assert.rejects(inspectArtifacts(root));
      await rm(join(root, name));
    }
    await symlink(join(root, 'index.html'), join(root, 'linked.html'));
    await assert.rejects(inspectArtifacts(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('HTTP and HTTPS templates preserve Nginx variables without embedding credentials', () => {
  for (const tls of [false, true]) {
    const result = spawnSync('bash', ['-c', `source ${quote(script)}
DOMAIN=resume.example.com BASE=/var/www/folio
TLS_CERT=${tls ? '/etc/tls/fullchain.pem' : "''"} TLS_KEY=${tls ? '/etc/tls/private.key' : "''"}
make_config`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /try_files \$uri \$uri\/ =404/);
    if (tls) {
      assert.match(result.stdout, /listen 443 ssl;/);
      assert.match(result.stdout, /https:\/\/resume\.example\.com\$request_uri;/);
      assert.match(result.stdout, /ssl_certificate_key \/etc\/tls\/private.key;/);
    } else assert.doesNotMatch(result.stdout, /ssl_certificate/);
  }
});

test('remote entrypoint can run through SSH stdin and rejects unprivileged execution', { skip: process.getuid?.() === 0 }, async () => {
  const result = spawnSync('bash', ['-s', '--', 'check', 'resume.example.com', '/var/www/folio', '1', '1', '', ''], {
    input: await readFile(script, 'utf8'), encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /需要 root 或 sudo -n 权限/);
  assert.doesNotMatch(result.stderr, /unbound variable/);
});

async function deploymentFixture(mode, previous = true) {
  const root = await mkdtemp(join(tmpdir(), 'folio-release-test-'));
  const base = join(root, 'site');
  const bundle = join(root, 'bundle');
  const conf = join(root, 'nginx.conf');
  const release = '20261102T000000000Z-abcdef123456';
  try {
    await mkdir(join(bundle, '_astro'), { recursive: true });
    await writeFile(join(bundle, 'index.html'), 'new site');
    await writeFile(join(bundle, '__folio_release.txt'), `${release}\n`);
    await writeFile(join(bundle, '_astro/new-hash.js'), 'new asset');
    if (previous) {
      await mkdir(join(base, 'releases/old'), { recursive: true });
      await mkdir(join(base, 'assets'), { recursive: true });
      await writeFile(join(base, 'assets/old-hash.js'), 'old asset');
      await symlink(join(base, 'releases/old'), join(base, 'current'));
      await writeFile(conf, '# previous working config\n');
    }
    const packed = spawnSync('tar', ['-czf', join(root, 'site.tar.gz'), '-C', bundle, '.']);
    assert.equal(packed.status, 0);
    const checksum = createHash('sha256').update(await readFile(join(root, 'site.tar.gz'))).digest('hex');
    // Exercise actual directory/link/config transactions. System services and HTTP are isolated stubs.
    const result = spawnSync('bash', ['-c', `source ${quote(script)}
BASE=${quote(base)} CONF=${quote(conf)} UPLOAD=${quote(root)}
DOMAIN=resume.example.com MANAGE=1 TLS_CERT='' TLS_KEY=''
RELEASE=${quote(release)} CHECKSUM=${quote(checksum)}
install_nginx() { :; }
getenforce() { printf Disabled; }
sleep() { :; }
sha256sum() { ${quote(process.execPath)} -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex")+"  archive\\n")' "$1"; }
mv() {
  if [[ $(uname) == Darwin ]]; then
    ${quote(process.execPath)} -e 'require("fs").renameSync(process.argv[1],process.argv[2])' "$2" "$3"
  else command mv "$@"; fi
}
nginx() {
  if [[ ${quote(mode)} == nginx && $(head -n 1 "$CONF") != '# previous working config' ]]; then return 1; fi
}
systemctl() {
  printf '%s\\n' "$*" >> ${quote(join(root, 'service.log'))}
  if [[ $1 == is-active ]]; then ${previous ? 'return 0' : 'return 1'}; fi
}
curl() {
  if [[ ${quote(mode)} == health ]]; then printf wrong-version; else cat "$BASE/current/__folio_release.txt"; fi
}
deploy`], { encoding: 'utf8', timeout: 20_000 });
    if (mode === 'success') {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readlink(join(base, 'current')), join(base, 'releases', release));
      assert.match(await readFile(conf, 'utf8'), /root .*\/current;/);
      assert.equal(await readFile(join(base, 'assets/new-hash.js'), 'utf8'), 'new asset');
      if (previous) assert.equal(await readFile(join(base, 'assets/old-hash.js'), 'utf8'), 'old asset');
    } else {
      assert.notEqual(result.status, 0);
      if (previous) {
        assert.equal(await readlink(join(base, 'current')), join(base, 'releases/old'));
        assert.equal(await readFile(conf, 'utf8'), '# previous working config\n');
        assert.match(await readFile(join(root, 'service.log'), 'utf8'), /reload nginx/);
      } else {
        await assert.rejects(access(join(base, 'current')));
        await assert.rejects(access(conf));
        assert.match(await readFile(join(root, 'service.log'), 'utf8'), /stop nginx/);
        assert.doesNotMatch(await readFile(join(root, 'service.log'), 'utf8'), /enable nginx/);
      }
    }
    await assert.rejects(access(join(base, '.deploy-lock')));
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('successful deployment switches the release and retains assets needed by old pages', () => deploymentFixture('success'));
test('Nginx rejection restores both previous release and configuration', () => deploymentFixture('nginx'));
test('health check failure restores both previous release and configuration', () => deploymentFixture('health'));
test('failed first deployment removes its active link and config and stops its new service', () => deploymentFixture('health', false));
