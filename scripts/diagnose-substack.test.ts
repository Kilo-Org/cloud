import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { diagnoseSubstack } from './diagnose-substack';
import { USER_DELETION_SUBSTACK_USER_AGENT } from '@kilocode/web-shared/lib/user/deletion-queue/deletion-constants';

const options = { cookie: 'connect.sid=private-cookie', email: ' Person@Example.com ' };
const subscriber = { user_email_address: 'person@example.com' };
const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(body, { status, headers });

function mockRequests(t: TestContext, responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    calls.push({ url: input, init });
    const response = responses.shift();
    assert.ok(response, `Unexpected request: ${input}`);
    return response;
  });
  return calls;
}

test('lookup-only uses admin headers and payload without deleting or logging secrets', async t => {
  const calls = mockRequests(t, [
    json({ cookie: options.cookie }),
    json({ count: 1, subscribers: [subscriber] }),
  ]);
  const events: Record<string, unknown>[] = [];
  await diagnoseSubstack(options, event => events.push(event));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://blog.kilo.ai/api/v1/user/profile/self');
  assert.equal(new Headers(calls[0].init.headers).has('User-Agent'), false);
  assert.equal(calls[1].url, 'https://blog.kilo.ai/api/v1/subscriber-stats');
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(
    new Headers(calls[1].init.headers).get('User-Agent'),
    USER_DELETION_SUBSTACK_USER_AGENT
  );
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    filters: { search: 'person@example.com', order_by_desc_nulls_last: 'subscription_created_at' },
    limit: 50,
    offset: 0,
    includeTags: true,
  });
  assert.equal(events.at(-1)?.exactMatch, true);
  assert.equal(JSON.stringify(events).includes('private-cookie'), false);
  assert.equal(JSON.stringify(events).includes('person@example.com'), false);
});

test('valid session does not hide a forbidden lookup or Cloudflare challenge', async t => {
  const calls = mockRequests(t, [
    json({}),
    new Response('<html>cf-chl-private-cookie</html>', {
      status: 403,
      headers: { 'cf-mitigated': 'challenge' },
    }),
  ]);
  const events: Record<string, unknown>[] = [];
  await assert.rejects(
    diagnoseSubstack(options, event => events.push(event)),
    /subscriber-lookup: HTTP 403.*does not establish session expiry/
  );
  assert.equal(calls.length, 2);
  assert.equal(events.at(-1)?.cloudflareChallenge, true);
  assert.equal(events.at(-1)?.cloudflarePage, true);
  assert.equal(JSON.stringify(events).includes('private-cookie'), false);
});

test('reauthentication uses shared TOTP implementation and rotated cookies', async t => {
  const calls = mockRequests(t, [
    json({}),
    json({ type: 'reauthentication_required' }, 403),
    json({ method: 'totp' }, 200, { 'set-cookie': 'connect.sid=rotated; Path=/' }),
    json({ success: true }),
    json({ count: 1, subscribers: [subscriber] }),
  ]);
  const events: Record<string, unknown>[] = [];
  await diagnoseSubstack({ ...options, totpSecret: 'JBSWY3DPEHPK3PXP' }, event =>
    events.push(event)
  );
  assert.equal(calls[2].url, 'https://blog.kilo.ai/api/v1/reauthenticate/start');
  assert.equal(calls[3].url, 'https://blog.kilo.ai/api/v1/reauthenticate/complete');
  assert.match(JSON.parse(String(calls[3].init.body)).code, /^\d{6}$/);
  assert.equal(new Headers(calls[3].init.headers).get('Cookie'), 'connect.sid=rotated');
  assert.equal(new Headers(calls[4].init.headers).get('Cookie'), 'connect.sid=rotated');
  assert.equal(calls[4].init.body, calls[1].init.body);
  assert.equal(JSON.stringify(events).includes('JBSWY3DPEHPK3PXP'), false);
  assert.equal(JSON.stringify(events).includes('rotated'), false);
});

test('does not retry repeated reauthentication challenges indefinitely', async t => {
  const challenge = () => json({ type: 'reauthentication_required' }, 403);
  const calls = mockRequests(t, [
    json({}),
    challenge(),
    json({ method: 'totp' }),
    json({ success: true }),
    challenge(),
  ]);
  await assert.rejects(
    diagnoseSubstack({ ...options, totpSecret: 'JBSWY3DPEHPK3PXP' }, () => {}),
    /persisted after one retry/
  );
  assert.equal(calls.length, 5);
});

test('missing TOTP stops at the challenge without attempting deletion', async t => {
  const calls = mockRequests(t, [json({}), json({ type: 'reauthentication_required' }, 403)]);
  await assert.rejects(
    diagnoseSubstack({ ...options, deleteSubscriber: true }, () => {}),
    /requires SUBSTACK_TOTP_SECRET/
  );
  assert.equal(calls.length, 2);
});

test('reports a denied reauthentication without leaking the response body', async t => {
  const calls = mockRequests(t, [
    json({}),
    json({ type: 'reauthentication_required' }, 403),
    json({ error: 'private-cookie' }, 403),
  ]);
  const events: Record<string, unknown>[] = [];
  await assert.rejects(
    diagnoseSubstack({ ...options, totpSecret: 'JBSWY3DPEHPK3PXP' }, event => events.push(event)),
    /reauthentication failed/
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(events.at(-1)?.failure, { kind: 'http', status: 403 });
  assert.equal(JSON.stringify(events).includes('private-cookie'), false);
});

test('network errors are sanitized and redirects remain blocked', async t => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('private-cookie', {
      cause: new Error('unexpected redirect private-cookie'),
    });
  });
  await assert.rejects(
    diagnoseSubstack(options, () => {}),
    { message: 'profile: redirect blocked.' }
  );
});

test('profile fallback cannot overwrite publication cookies', async t => {
  const calls = mockRequests(t, [
    json({}, 404, { 'set-cookie': 'connect.sid=publication; Path=/' }),
    json({}, 200, { 'set-cookie': 'connect.sid=fallback; Path=/' }),
    json({ count: 0, subscribers: [] }),
  ]);
  await diagnoseSubstack(options, () => {});
  assert.equal(calls[1].url, 'https://substack.com/api/v1/user/profile/self');
  assert.equal(new Headers(calls[2].init.headers).get('Cookie'), 'connect.sid=publication');
});

test('explicit deletion removes only the normalized exact match', async t => {
  const calls = mockRequests(t, [
    json({}),
    json({ count: 1, subscribers: [subscriber] }),
    new Response(null, { status: 204 }),
  ]);
  const events: Record<string, unknown>[] = [];
  await diagnoseSubstack({ ...options, deleteSubscriber: true }, event => events.push(event));
  assert.equal(calls[2].init.method, 'DELETE');
  assert.equal(
    calls[2].url,
    'https://blog.kilo.ai/api/v1/subscriber/person%40example.com?disable_email=true'
  );
  assert.equal(events.at(-1)?.result, 'removed');
});

test('partial matches are never deleted', async t => {
  const calls = mockRequests(t, [
    json({}),
    json({ count: 1, subscribers: [{ user_email_address: 'otherperson@example.com' }] }),
  ]);
  await diagnoseSubstack({ ...options, deleteSubscriber: true }, () => {});
  assert.equal(calls.length, 2);
});

test('deletion permission failures are reported separately from lookup', async t => {
  const calls = mockRequests(t, [
    json({}),
    json({ count: 1, subscribers: [subscriber] }),
    json({}, 403),
  ]);
  await assert.rejects(
    diagnoseSubstack({ ...options, deleteSubscriber: true }, () => {}),
    /subscriber-delete: HTTP 403/
  );
  assert.equal(calls.length, 3);
});

test('already-removed deletion responses match admin behavior', async t => {
  mockRequests(t, [
    json({}),
    json({ count: 1, subscribers: [subscriber] }),
    json({ error: 'Subscription not found' }, 400),
  ]);
  const events: Record<string, unknown>[] = [];
  await diagnoseSubstack({ ...options, deleteSubscriber: true }, event => events.push(event));
  assert.equal(events.at(-1)?.result, 'already-removed');
});

test('incomplete pages refuse deletion', async t => {
  const calls = mockRequests(t, [json({}), json({ count: 2, subscribers: [subscriber] })]);
  await assert.rejects(
    diagnoseSubstack({ ...options, deleteSubscriber: true }, () => {}),
    /incomplete or inconsistent/
  );
  assert.equal(calls.length, 2);
});

test('pagination completes before deletion', async t => {
  const firstPage = Array.from({ length: 50 }, (_, i) => ({
    user_email_address: `subscriber${i}@example.com`,
  }));
  const calls = mockRequests(t, [
    json({}),
    json({ count: 51, subscribers: firstPage }),
    json({ count: 51, subscribers: [subscriber] }),
    json({}),
  ]);
  await diagnoseSubstack({ ...options, deleteSubscriber: true }, () => {});
  assert.equal(JSON.parse(String(calls[2].init.body)).offset, 50);
  assert.equal(calls[3].init.method, 'DELETE');
});

test('rejects untrusted publication hosts and invalid TOTP before sending credentials', async t => {
  const calls = mockRequests(t, []);
  for (const publication of [
    'https://attacker.example',
    'https://user:pass@substack.com',
    'http://blog.kilo.ai',
  ]) {
    await assert.rejects(
      diagnoseSubstack({ ...options, publication }, () => {}),
      /Publication must/
    );
  }
  await assert.rejects(
    diagnoseSubstack({ ...options, totpSecret: '123456' }, () => {}),
    /Base32 authenticator secret/
  );
  assert.equal(calls.length, 0);
});
