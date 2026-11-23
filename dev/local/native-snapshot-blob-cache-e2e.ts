/**
 * Local-only proof that a native snapshot keeps its attachment bytes across reads.
 *
 * Runs against a real `wrangler dev` session-sync worker on this machine: real Durable
 * Object, real R2, real HTTP routes. It mints a sync grant directly with the worker's own
 * local `SESSION_SYNC_SECRET`, so no account, exchange, or Postgres row is involved.
 *
 * Both sides of the change run in one process against the same stored session:
 *   - without a blob cache, the reader repeats every attachment download on the second read
 *     (the behaviour before the change);
 *   - with `NativeSnapshotBlobCache`, the second read repeats none of them.
 *
 * Usage, with the worker started from this checkout:
 *   pnpm --filter cloudflare-session-sync exec wrangler dev --env local --port 8817
 *   SESSION_SYNC_SECRET=<the worker's local value> \
 *     node --import tsx dev/local/native-snapshot-blob-cache-e2e.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { syncGrant } from './native-sync-grant.ts';
import { NativeSnapshotBlobCache } from '../../packages/cloud-agent-sdk/src/native-snapshot-blobs';
import { fetchNativeSnapshot } from '../../packages/cloud-agent-sdk/src/native-sync-snapshot';

const origin = process.env.SESSION_SYNC_ORIGIN ?? 'http://127.0.0.1:8817';
const secret = process.env.SESSION_SYNC_SECRET;
assert(secret && Buffer.byteLength(secret) >= 32, 'Set SESSION_SYNC_SECRET to the worker value');
const out = process.env.E2E_OUT ?? '/tmp/pr-proof/blob-cache-e2e';

const userID = `user_${randomUUID().replaceAll('-', '')}`;
const sessionID = `ses_${randomUUID().replaceAll('-', '')}`;
const sourceID = randomUUID();

const grant = syncGrant({ secret, userID, environment: 'development', ttlSeconds: 300 });

const authorization = { authorization: `Bearer ${grant}` };

function request<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(`${origin}${path}`, {
    ...init,
    headers: { ...authorization, ...init?.headers },
  }).then(async response => {
    const text = await response.text();
    assert(response.ok, `${init?.method ?? 'GET'} ${path} failed ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  });
}

// Seed one session with one attachment, exactly as the native producer does: a private
// content-addressed blob, the message that references it, and the authorizing mapping.
const attachment = new TextEncoder().encode(`proof ${randomUUID()}`);
const hash = createHash('sha256').update(attachment).digest('hex');
const reference = `media:${hash}`;
const message = {
  id: 'msg_proof',
  type: 'user' as const,
  time: { created: 1 },
  text: 'proof',
  files: [{ mime: 'image/png', name: 'proof.png', uri: reference, source: { type: 'inline' } }],
};
await request(`/v1/sessions/${sessionID}`, {
  method: 'PUT',
  body: JSON.stringify({ version: 1, sourceID }),
});
const upload = await fetch(`${origin}/v1/sessions/${sessionID}/blobs/${hash}`, {
  method: 'PUT',
  headers: authorization,
  body: attachment,
});
assert(upload.ok, `Blob upload failed ${upload.status}: ${await upload.text()}`);
await request(`/v1/sessions/${sessionID}/batches`, {
  method: 'POST',
  body: JSON.stringify({
    version: 1,
    sourceID,
    batchID: randomUUID(),
    after: 0,
    through: 2,
    changes: [
      {
        op: 'put',
        kind: 'session',
        id: sessionID,
        value: { id: sessionID, origin: { directory: '/proof' }, time: { created: 1, updated: 1 } },
      },
      { op: 'put', kind: 'message', id: message.id, value: { seq: 0, message } },
      {
        op: 'put',
        kind: 'asset',
        id: 'asset_proof',
        value: {
          entity: { kind: 'message', id: message.id },
          pointer: '/message/files/0',
          reference,
          mime: 'image/png',
          blob: { hash, bytes: attachment.byteLength },
        },
      },
    ],
  }),
});

/** Every attachment download the snapshot reader makes, in order. */
const downloads: string[] = [];
async function readAsset(path: string, advertisedBytes: number, init?: RequestInit) {
  downloads.push(path);
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { ...authorization, ...init?.headers },
  });
  assert(response.ok, `Attachment read failed ${response.status}: ${path}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.byteLength, advertisedBytes, 'The attachment body does not match its size');
  return bytes.buffer;
}
// Without a cache the second read repeats the download: the behaviour before the change.
const plainFirst = await fetchNativeSnapshot(request, sessionID, undefined, readAsset);
const plainSecond = await fetchNativeSnapshot(request, sessionID, undefined, readAsset);
const uncached = downloads.length;
assert.equal(uncached, 2, `Two uncached reads made ${uncached} downloads, expected 2`);
const key = Object.keys(plainFirst.assetURLs ?? {})[0];
assert(key, 'The snapshot did not resolve the attachment');
assert.equal(plainSecond.assetURLs?.[key], plainFirst.assetURLs?.[key], 'Cached bytes differ');

// With one client cache, two reads download the immutable body once.
downloads.length = 0;
const cache = new NativeSnapshotBlobCache(32 * 1024 * 1024);
const cachedFirst = await fetchNativeSnapshot(request, sessionID, undefined, readAsset, cache);
const afterFirst = downloads.length;
const cachedSecond = await fetchNativeSnapshot(request, sessionID, undefined, readAsset, cache);
const repeat = downloads.length - afterFirst;
assert.equal(cachedFirst.assetURLs?.[key], plainFirst.assetURLs?.[key], 'Cached bytes differ');
assert.equal(cachedSecond.assetURLs?.[key], cachedFirst.assetURLs?.[key], 'Cached bytes differ');
assert.equal(afterFirst, 1, `The first cached read made ${afterFirst} downloads, expected 1`);

// Closing the session drops its retained bytes, so the next read downloads again.
cache.forgetSession(sessionID);
downloads.length = 0;
await fetchNativeSnapshot(request, sessionID, undefined, readAsset, cache);
const afterClose = downloads.length;

const result = {
  sessionID,
  downloadsWithoutCache: uncached,
  downloadsFirstCachedRead: afterFirst,
  downloadsSecondCachedRead: repeat,
  downloadsAfterSessionClose: afterClose,
  bytes: attachment.byteLength,
  passed: repeat === 0 && uncached === 2 && afterClose === 1,
};
await mkdir(out, { recursive: true });
await writeFile(`${out}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
assert.ok(result.passed, 'The cache did not change the repeat download count');
