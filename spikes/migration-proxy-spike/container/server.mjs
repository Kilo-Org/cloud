import { createServer } from 'node:http';
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const boot = { bootId: randomUUID(), pid: process.pid, startedAt: new Date().toISOString() };
writeFileSync('/tmp/boot.json', JSON.stringify(boot));

const run = (cmd, args, input) =>
  new Promise(resolve => {
    const child = execFile(cmd, args, { timeout: 15000, maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })
    );
    child.stdin.end(input ?? '');
  });

function tcp(address, port, family) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const s = connect({ host: address, port, family, timeout: 8000 });
    s.once('connect', () => { s.destroy(); resolve({ address, ok: true, ms: Date.now() - t0 }); });
    s.once('timeout', () => { s.destroy(); resolve({ address, ok: false, error: 'timeout' }); });
    s.once('error', e => resolve({ address, ok: false, error: e.code ?? e.message }));
  });
}

async function handle(path, body) {
  if (path === '/info') {
    return { file: JSON.parse(readFileSync('/tmp/boot.json', 'utf8')), live: boot, uptimeS: process.uptime() };
  }
  if (path === '/tcp') {
    const out = { host: body.host, port: body.port, resolved: {}, attempts: [] };
    for (const family of [4, 6]) {
      try {
        const addrs = await lookup(body.host, { all: true, family });
        out.resolved[`v${family}`] = addrs.map(a => a.address);
        for (const a of addrs) out.attempts.push({ family, ...(await tcp(a.address, body.port, family)) });
      } catch (e) {
        out.resolved[`v${family}`] = e.code ?? e.message;
      }
    }
    return out;
  }
  if (path === '/tls') {
    const dir = mkdtempSync('/tmp/tls-');
    const args = ['s_client', '-starttls', 'postgres', '-showcerts', '-connect', `${body.host}:${body.port}`, '-servername', body.host];
    if (body.caPem) {
      writeFileSync(`${dir}/ca.pem`, body.caPem);
      args.push('-CAfile', `${dir}/ca.pem`, '-verify_hostname', body.host, '-verify_return_error');
    }
    const r = await run('openssl', args, '');
    const pems = r.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    const chain = [];
    for (const pem of pems) {
      const x = await run('openssl', ['x509', '-noout', '-subject', '-issuer', '-fingerprint', '-sha256', '-dates'], pem);
      chain.push({ info: x.stdout.trim(), pem });
    }
    const verify = (r.stdout.match(/Verify return code: .*/) ?? [null])[0];
    return { code: r.code, verify, chain, stderrTail: r.stderr.slice(-600) };
  }
  if (path === '/pg') {
    const client = new pg.Client({
      host: body.host, port: body.port, user: body.user, password: body.password, database: body.database ?? 'postgres',
      ssl: body.caPem ? { ca: body.caPem, rejectUnauthorized: true, servername: body.host } : undefined,
      application_name: body.appName, connectionTimeoutMillis: 10000, keepAlive: true,
    });
    try {
      await client.connect();
      const r = await client.query(
        `SELECT pid, backend_start, application_name, current_setting('application_name') AS setting,
                session_user, current_user, inet_server_addr()::text AS server_addr, ssl.ssl, ssl.version AS tls
         FROM pg_stat_activity a LEFT JOIN pg_stat_ssl ssl USING (pid) WHERE a.pid = pg_backend_pid()`
      );
      const v = await client.query('SELECT version(), pg_is_in_recovery()');
      return { ok: true, row: r.rows[0], server: v.rows[0] };
    } catch (e) {
      return { ok: false, code: e.code ?? null, message: e.message };
    } finally {
      await client.end().catch(() => {});
    }
  }
  if (path === '/http') {
    const ac = AbortSignal.timeout(10000);
    try {
      const res = await fetch(body.url, { signal: ac });
      return { ok: true, status: res.status, server: res.headers.get('server'), body: (await res.text()).slice(0, 200) };
    } catch (e) {
      return { ok: false, error: String(e.cause?.code ?? e.cause?.message ?? e.message) };
    }
  }
  return null;
}

createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const path = new URL(req.url, 'http://x').pathname;
  try {
    const out = await handle(path, raw ? JSON.parse(raw) : {});
    res.writeHead(out ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out ?? { error: 'not found' }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(8080);
process.on('SIGTERM', () => { console.log('SIGTERM'); process.exit(0); });
