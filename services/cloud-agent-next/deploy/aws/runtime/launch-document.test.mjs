import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseLaunchEnvelope, readLaunchDocument } from './launch-document.mjs';

function fixture(override = {}) {
  const deadlineAt = Date.now() + 60_000;
  const document = {
    format: 1,
    deadlineAt,
    argv: ['/bin/echo', 'two words', '$(exit 79)', ''],
    env: { PATH: '/usr/bin:/bin', CALLER: 'value' },
    ...override,
  };
  const bytes = Buffer.from(JSON.stringify(document));
  const envelope = {
    url: 'https://customer-artifacts.s3.us-east-1.amazonaws.com/kilo/launch/allocation-1.json?test-signature=1',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    deadlineAt,
  };
  return { envelope, bytes, document };
}

test('the loader preserves typed argv and supplies only the launch-owned environment', async () => {
  const { envelope, bytes, document } = fixture();
  const result = await readLaunchDocument(parseLaunchEnvelope(envelope), async (url, options) => {
    assert.equal(url, envelope.url);
    assert.equal(options.redirect, 'error');
    return new Response(bytes);
  });
  assert.deepEqual(result, { argv: document.argv, env: document.env });
  assert.equal(Object.hasOwn(result.env, 'AWS_ACCESS_KEY_ID'), false);
});

test('the loader refuses integrity failure, expired data and malformed execution data', async () => {
  const original = fixture();
  await assert.rejects(
    readLaunchDocument(
      { ...original.envelope, sha256: '0'.repeat(64) },
      async () => new Response(original.bytes)
    ),
    /integrity/
  );
  for (const data of [
    { deadlineAt: 0 },
    { argv: ['/bin/sh', 'bad\0value'] },
    { env: { 'bad=value': 'value' } },
    { argv: [] },
    { env: [] },
  ]) {
    const { envelope, bytes } = fixture(data);
    await assert.rejects(
      readLaunchDocument(envelope, async () => new Response(bytes)),
      /Invalid AWS launch document/
    );
  }
});

test('the loader cancels an oversized stream before parsing it', async () => {
  const { envelope } = fixture();
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(65_536));
      },
      cancel() {
        cancelled = true;
      },
    })
  );
  await assert.rejects(
    readLaunchDocument(envelope, async () => response),
    /download failed/
  );
  assert.equal(cancelled, true);
});

test('the envelope cannot redirect launch authority to another host or storage prefix', () => {
  const { envelope } = fixture();
  for (const url of [
    'http://customer-artifacts.s3.us-east-1.amazonaws.com/kilo/launch/a.json',
    'https://127.0.0.1/kilo/launch/a.json',
    'https://customer-artifacts.s3.us-east-1.amazonaws.com/proxy/private/ca.key',
    'https://user:password@customer-artifacts.s3.us-east-1.amazonaws.com/kilo/launch/a.json',
  ])
    assert.throws(() => parseLaunchEnvelope({ ...envelope, url }));
  assert.throws(() => parseLaunchEnvelope({ ...envelope, deadlineAt: Date.now() - 1 }));
  assert.throws(() => parseLaunchEnvelope({ ...envelope, proxy: 'https://proxy:3128' }));
});
