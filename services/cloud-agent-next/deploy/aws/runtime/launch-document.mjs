import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const MAX_DOCUMENT_BYTES = 262_144;

export function parseLaunchEnvelope(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.url !== 'string' ||
    typeof input.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !Number.isSafeInteger(input.deadlineAt) ||
    input.deadlineAt <= Date.now() ||
    input.deadlineAt > Date.now() + 15 * 60_000
  )
    throw new Error('Invalid AWS launch envelope');
  const url = new URL(input.url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !/^[a-z0-9-]+\.s3\.us-east-1\.amazonaws\.com$/.test(url.hostname) ||
    !/^\/kilo\/launch\/[A-Za-z0-9_-]+\.json$/.test(url.pathname)
  )
    throw new Error('Invalid AWS launch location');
  let proxy;
  if (input.proxy !== undefined) {
    if (typeof input.proxy !== 'string' || input.proxy.length > 4096)
      throw new Error('Invalid AWS launch proxy');
    proxy = new URL(input.proxy);
    if (
      proxy.protocol !== 'http:' ||
      proxy.port !== '3128' ||
      proxy.pathname !== '/' ||
      proxy.search ||
      proxy.hash
    )
      throw new Error('Invalid AWS launch proxy');
  }
  return {
    url: url.href,
    sha256: input.sha256,
    deadlineAt: input.deadlineAt,
    ...(proxy ? { proxy: proxy.href } : {}),
  };
}

export async function readLaunchDocument(envelope, fetcher = fetch) {
  const response = await fetcher(envelope.url, {
    redirect: 'error',
    signal: AbortSignal.timeout(Math.min(30_000, envelope.deadlineAt - Date.now())),
  });
  if (!response.ok || !response.body) throw new Error('AWS launch download failed');
  let size = 0;
  const chunks = [];
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DOCUMENT_BYTES) throw new Error('AWS launch document is too large');
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error('AWS launch download failed');
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  if (createHash('sha256').update(bytes).digest('hex') !== envelope.sha256)
    throw new Error('AWS launch integrity check failed');
  let input;
  try {
    input = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Invalid AWS launch document');
  }
  if (
    !input ||
    input.format !== 1 ||
    input.deadlineAt !== envelope.deadlineAt ||
    Date.now() >= input.deadlineAt ||
    !Array.isArray(input.argv) ||
    input.argv.length < 1 ||
    input.argv.length > 64 ||
    !input.argv[0] ||
    input.argv.some(value => typeof value !== 'string' || value.includes('\0')) ||
    !input.env ||
    typeof input.env !== 'object' ||
    Array.isArray(input.env) ||
    Object.keys(input.env).length > 1024 ||
    Object.entries(input.env).some(
      ([name, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || value.includes('\0')
    )
  )
    throw new Error('Invalid AWS launch document');
  return { argv: input.argv, env: input.env };
}

export async function startLaunchDocument(input) {
  const envelope = parseLaunchEnvelope(input);
  const document = await readLaunchDocument(envelope);
  // Supply the complete environment explicitly. Image-build or platform credentials cannot be inherited.
  const child = spawn(document.argv[0], document.argv.slice(1), {
    env: document.env,
    stdio: 'inherit',
  });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('error', () => process.exit(1));
  child.on('exit', code => process.exit(code ?? 1));
}
