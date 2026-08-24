import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emailForIssue,
  scenarioFromEmail,
  startDeletionProviderMock,
  type DeletionProviderMockHandle,
} from './deletion-provider-mock';

async function withMock(
  run: (origin: string, handle: DeletionProviderMockHandle) => Promise<void>
): Promise<void> {
  const handle = await startDeletionProviderMock({ host: '127.0.0.1', port: 0 });
  try {
    await run(handle.origin, handle);
  } finally {
    await handle.close();
  }
}

async function requestJson(
  origin: string,
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

test('maps #1001 to ok@local.test', () => {
  assert.equal(emailForIssue(1001), 'ok@local.test');
  assert.equal(scenarioFromEmail('ok@local.test'), 'ok');
});

test('maps unknown numeric tickets to ok+<number>@local.test', () => {
  assert.equal(emailForIssue(9999), 'ok+9999@local.test');
});

test('maps extra happy-path tickets to ok2/ok3/ok4', () => {
  assert.equal(emailForIssue(2001), 'ok2@local.test');
  assert.equal(emailForIssue(2002), 'ok3@local.test');
  assert.equal(emailForIssue(2003), 'ok4@local.test');
  assert.equal(scenarioFromEmail('ok2@local.test'), 'ok');
});

test('GET /issues/1 has no requester email', async () => {
  await withMock(async origin => {
    const { status, body } = await requestJson(origin, '/issues/1');
    assert.equal(status, 200);
    const data = (body as { data?: { requester?: { email?: string } } }).data;
    assert.equal(data?.requester?.email, undefined);
  });
});

test('GET /issues/1001 requester is ok@local.test', async () => {
  await withMock(async origin => {
    const { status, body } = await requestJson(origin, '/issues/1001');
    assert.equal(status, 200);
    assert.ok(body && typeof body === 'object');
    const data = (body as { data?: { requester?: { email?: string } } }).data;
    assert.equal(data?.requester?.email, 'ok@local.test');
  });
});

test('GET / returns a plaintext cheat sheet', async () => {
  await withMock(async origin => {
    const response = await fetch(`${origin}/`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
    assert.match(text, /#1001/);
    assert.match(text, /ok@local.test/);
  });
});

test('PostHog lookup returns uuid for ok@local.test', async () => {
  await withMock(async origin => {
    const { status, body } = await requestJson(
      origin,
      '/api/projects/proj/persons?email=ok%40local.test'
    );
    assert.equal(status, 200);
    const results = (body as { results: Array<Record<string, unknown>> }).results;
    const person = results[0];
    assert.equal(results.length, 1);
    assert.ok(person);
    assert.equal(typeof person.uuid, 'string');
    assert.equal((person.properties as { email?: string }).email, 'ok@local.test');
  });
});

test('PostHog environments lookup and bulk_delete use trailing slashes and uuid ids', async () => {
  await withMock(async origin => {
    const distinct = await requestJson(
      origin,
      '/api/environments/proj/persons/?distinct_id=ok%40local.test'
    );
    const byEmail = await requestJson(
      origin,
      '/api/environments/proj/persons/?email=ok%40local.test'
    );
    assert.equal(distinct.status, 200);
    assert.equal(byEmail.status, 200);
    const person = (byEmail.body as { results: Array<{ uuid: string }> }).results[0];
    assert.ok(person?.uuid);

    const deleted = await requestJson(origin, '/api/environments/proj/persons/bulk_delete/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ids: [person.uuid],
        delete_events: true,
        delete_recordings: true,
        keep_person: false,
      }),
    });
    assert.equal(deleted.status, 202);
    assert.deepEqual(deleted.body, {
      id: 'deletion-mock',
      persons_found: 1,
      persons_deleted: 1,
      events_queued_for_deletion: true,
      recordings_queued_for_deletion: true,
      deletion_errors: [],
    });

    const gone = await requestJson(origin, `/api/environments/proj/persons/${person.uuid}/`);
    assert.equal(gone.status, 404);
    const status = await requestJson(
      origin,
      `/api/environments/proj/persons/deletion_status/?person_uuid=${person.uuid}&status=all`
    );
    const results = (status.body as { results: Array<{ status: string; person_uuid: string }> })
      .results;
    assert.equal(results[0]?.status, 'completed');
    assert.equal(results[0]?.person_uuid, person.uuid);
  });
});

test('PostHog fail-posthog lookup is 500 and 429-posthog bulk delete is 429', async () => {
  await withMock(async origin => {
    const failed = await requestJson(
      origin,
      '/api/projects/proj/persons?email=fail-posthog%40local.test'
    );
    assert.equal(failed.status, 500);

    const lookedUp = await requestJson(
      origin,
      '/api/projects/proj/persons?email=429-posthog%40local.test'
    );
    const person = (lookedUp.body as { results: Array<{ uuid: string; distinct_ids: string[] }> })
      .results[0];
    assert.ok(person);
    const deleted = await requestJson(origin, '/api/projects/proj/persons/bulk_delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ distinct_ids: person.distinct_ids, delete_events: true }),
    });
    assert.equal(deleted.status, 429);
  });
});

test('slow-posthog person GET stays 200 for two polls then 404', async () => {
  await withMock(async origin => {
    const lookedUp = await requestJson(
      origin,
      '/api/projects/proj/persons?email=slow-posthog%40local.test'
    );
    const person = (lookedUp.body as { results: Array<{ id: string; distinct_ids: string[] }> })
      .results[0];
    assert.ok(person);

    const submitted = await requestJson(origin, '/api/projects/proj/persons/bulk_delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ distinct_ids: person.distinct_ids, delete_events: true }),
    });
    assert.equal(submitted.status, 202);

    const first = await requestJson(origin, `/api/projects/proj/persons/${person.id}`);
    const second = await requestJson(origin, `/api/projects/proj/persons/${person.id}`);
    const third = await requestJson(origin, `/api/projects/proj/persons/${person.id}`);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 404);
  });
});

test('missing@local.test is empty or 404 across providers', async () => {
  await withMock(async origin => {
    const posthog = await requestJson(
      origin,
      '/api/projects/proj/persons?email=missing%40local.test'
    );
    assert.deepEqual((posthog.body as { results: unknown[] }).results, []);

    const pylon = await requestJson(origin, '/contacts/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filter: { field: 'email', operator: 'equals', value: 'missing@local.test' },
      }),
    });
    assert.deepEqual((pylon.body as { data: unknown[] }).data, []);

    const cio = await requestJson(origin, '/api/v1/customers/missing%40local.test', {
      method: 'DELETE',
    });
    assert.equal(cio.status, 404);

    const substack = await requestJson(origin, '/api/v1/subscriber?offset=0&limit=50');
    const subscribers = (substack.body as { subscribers: Array<{ email: string }> }).subscribers;
    assert.ok(!subscribers.some(row => row.email === 'missing@local.test'));
  });
});

test('Pylon #1430 contact delete is 429 and #1431 reply is 429', async () => {
  await withMock(async origin => {
    const searched = await requestJson(origin, '/contacts/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filter: { field: 'email', operator: 'equals', value: '429-pylon@local.test' },
      }),
    });
    const contact = (searched.body as { data: Array<{ id: string }> }).data[0];
    assert.ok(contact);
    const deleted = await requestJson(origin, `/contacts/${contact.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 429);

    const replied = await requestJson(origin, '/issues/1431/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body_html: '<p>done</p>', message_id: 'msg' }),
    });
    assert.equal(replied.status, 429);
  });
});

test('Substack first page includes exact matches plus decoys without prior priming', async () => {
  await withMock(async origin => {
    const listed = await requestJson(origin, '/api/v1/subscriber?offset=0&limit=50');
    const subscribers = (listed.body as { subscribers: Array<{ id: string; email: string }> })
      .subscribers;
    assert.ok(subscribers.some(row => row.email === 'ok@local.test' && row.id));
    assert.ok(subscribers.some(row => row.email === 'expired-substack@local.test'));
    assert.ok(!subscribers.some(row => row.email === 'missing@local.test'));
    assert.ok(!subscribers.some(row => row.email === 'no-substack@local.test'));
    const decoys = subscribers.filter(row => row.id.startsWith('partial-'));
    assert.ok(decoys.length >= 2);
    const refused = await requestJson(origin, `/api/v1/subscriber/${decoys[0]?.id}`, {
      method: 'DELETE',
    });
    assert.equal(refused.status, 409);
    const unknownDecoy = await requestJson(origin, '/api/v1/subscriber/partial-never-created', {
      method: 'DELETE',
    });
    assert.equal(unknownDecoy.status, 409);
  });
});

test('Substack delete-by-email uses disable_email=true and already-gone bodies', async () => {
  await withMock(async origin => {
    const deleted = await requestJson(
      origin,
      '/api/v1/subscriber/ok%40local.test?disable_email=true',
      { method: 'DELETE' }
    );
    assert.equal(deleted.status, 200);

    const missing = await requestJson(
      origin,
      '/api/v1/subscriber/missing%40local.test?disable_email=true',
      { method: 'DELETE' }
    );
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { error?: string }).error, 'User not found');

    const goneUser = await requestJson(
      origin,
      '/api/v1/subscriber/gone-user%40local.test?disable_email=true',
      { method: 'DELETE' }
    );
    assert.equal(goneUser.status, 400);
    assert.equal((goneUser.body as { error?: string }).error, 'User not found');

    const goneSub = await requestJson(
      origin,
      '/api/v1/subscriber/gone-sub%40local.test?disable_email=true',
      { method: 'DELETE' }
    );
    assert.equal(goneSub.status, 400);
    assert.equal((goneSub.body as { error?: string }).error, 'Subscription not found');
  });
});

test('Substack deletes the exact match and 401s expired-substack', async () => {
  await withMock(async origin => {
    const listed = await requestJson(origin, '/api/v1/subscriber?offset=0&limit=50');
    const subscribers = (listed.body as { subscribers: Array<{ id: string; email: string }> })
      .subscribers;
    const ok = subscribers.find(row => row.email === 'ok@local.test');
    const expired = subscribers.find(row => row.email === 'expired-substack@local.test');
    assert.ok(ok);
    assert.ok(expired);
    const deleted = await requestJson(origin, `/api/v1/subscriber/${ok.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    const unauthorized = await requestJson(origin, `/api/v1/subscriber/${expired.id}`, {
      method: 'DELETE',
    });
    assert.equal(unauthorized.status, 401);
    const profile = await requestJson(origin, '/api/v1/user/profile/self');
    assert.equal(profile.status, 200);
  });
});

test('Customer.io DELETE follows 429-cio / fail-cio / ok scenarios', async () => {
  await withMock(async origin => {
    const limited = await requestJson(origin, '/api/v1/customers/429-cio%40local.test', {
      method: 'DELETE',
    });
    assert.equal(limited.status, 429);
    const failed = await requestJson(origin, '/api/v1/customers/fail-cio%40local.test', {
      method: 'DELETE',
    });
    assert.equal(failed.status, 500);
    const ok = await requestJson(origin, '/api/v1/customers/ok%40local.test', { method: 'DELETE' });
    assert.equal(ok.status, 200);
  });
});

test('does not implement CSA Kilo support user routes', async () => {
  await withMock(async origin => {
    const { status } = await requestJson(
      origin,
      '/api/internal/support/users?email=ok%40local.test'
    );
    assert.equal(status, 404);
  });
});

test('unknown numeric tickets map to ok+<number>@local.test', async () => {
  await withMock(async origin => {
    const { status, body } = await requestJson(origin, '/issues/9999');
    assert.equal(status, 200);
    const data = (body as { data?: { requester?: { email?: string } } }).data;
    assert.equal(data?.requester?.email, 'ok+9999@local.test');
  });
});

test('fail-pylon contact search is 500 and no-substack is absent from Substack', async () => {
  await withMock(async origin => {
    const failed = await requestJson(origin, '/contacts/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filter: { field: 'email', operator: 'equals', value: 'fail-pylon@local.test' },
      }),
    });
    assert.equal(failed.status, 500);

    const posthog = await requestJson(
      origin,
      '/api/projects/proj/persons?email=no-substack%40local.test'
    );
    assert.equal((posthog.body as { results: unknown[] }).results.length, 1);
    const listed = await requestJson(origin, '/api/v1/subscriber?offset=0&limit=50');
    const subscribers = (listed.body as { subscribers: Array<{ email: string }> }).subscribers;
    assert.ok(!subscribers.some(row => row.email === 'no-substack@local.test'));
  });
});

test('Pylon messages, reply, and close succeed for #1001', async () => {
  await withMock(async origin => {
    const issue = await requestJson(origin, '/issues/1001');
    const issueId = (issue.body as { data: { id: string } }).data.id;
    const messages = await requestJson(origin, `/issues/${issueId}/messages`);
    assert.equal(messages.status, 200);
    assert.ok(Array.isArray((messages.body as { data: unknown[] }).data));

    const replied = await requestJson(origin, `/issues/${issueId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body_html: '<p>done</p>', message_id: 'msg-1001-customer' }),
    });
    assert.equal(replied.status, 200);

    const closed = await requestJson(origin, `/issues/${issueId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'closed' }),
    });
    assert.equal(closed.status, 200);
    assert.equal((closed.body as { data: { state: string } }).data.state, 'closed');
  });
});

test('binds 127.0.0.1 only', async () => {
  await withMock(async (_origin, handle) => {
    assert.equal(handle.host, '127.0.0.1');
  });
});
