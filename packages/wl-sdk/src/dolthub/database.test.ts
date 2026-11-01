import { describe, expect, it } from 'vitest';
import { WlDoltHubError } from './api';
import { createDatabase, forkDatabase } from './database';

type MockResponse = { status: number; body?: unknown; text?: string };
type FetchCall = { url: string; init: RequestInit | undefined };

function makeFetch(responses: MockResponse[]): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    const stringUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: stringUrl, init });
    const r = responses[i++] ?? { status: 500, body: { error: 'no more responses' } };
    const text = r.text ?? (r.body !== undefined ? JSON.stringify(r.body) : '');
    return Promise.resolve(new Response(text, { status: r.status }));
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('createDatabase', () => {
  it('defaults visibility to public', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { status: 'Success' } }]);
    const result = await createDatabase({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      fetch: fakeFetch,
    });
    expect(result.created).toBe(true);
    expect(calls[0].url).toContain('/database');
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ ownerName: 'hop', repoName: 'wl', visibility: 'public' });
  });

  it('passes through explicit visibility=private', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { status: 'Success' } }]);
    await createDatabase({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      visibility: 'private',
      fetch: fakeFetch,
    });
    const body = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
    expect(body.visibility).toBe('private');
  });

  it('treats 409 as idempotent (created=false)', async () => {
    const { fetch: fakeFetch } = makeFetch([{ status: 409, body: { error: 'exists' } }]);
    const result = await createDatabase({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      fetch: fakeFetch,
    });
    expect(result.created).toBe(false);
  });

  it('treats "already exists" message as idempotent (created=false)', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 200, body: { status: 'Error', message: 'database already exists' } },
    ]);
    const result = await createDatabase({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      fetch: fakeFetch,
    });
    expect(result.created).toBe(false);
  });

  it('throws WlDoltHubError on a real failure', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 400, body: { status: 'Error', message: 'private requires paid account' } },
    ]);
    await expect(
      createDatabase({
        auth: { token: 't' },
        owner: 'hop',
        db: 'wl',
        visibility: 'private',
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
  });
});

describe('forkDatabase', () => {
  it('POSTs to /fork with parentOwnerName / parentDatabaseName', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { status: 'Success' } }]);
    const result = await forkDatabase({
      auth: { token: 't' },
      fromOwner: 'upstream',
      fromDb: 'wl',
      toOwner: 'me',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(result.owner).toBe('me');
    expect(result.db).toBe('wl');
    expect(result.created).toBe(true);
    expect(calls[0].url).toContain('/fork');
    const body = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      ownerName: 'me',
      parentOwnerName: 'upstream',
      parentDatabaseName: 'wl',
    });
  });

  it('polls when an operation_name is returned', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      { status: 200, body: { status: 'Pending', operation_name: 'op-fork' } },
      {
        status: 200,
        body: { owner_name: 'me', database_name: 'wl' },
      },
    ]);
    const result = await forkDatabase({
      auth: { token: 't' },
      fromOwner: 'upstream',
      fromDb: 'wl',
      toOwner: 'me',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(result.created).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('/fork?operationName=op-fork');
  });

  it('does not complete a polled fork whose body states a pending status with the names', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      { status: 200, body: { status: 'Pending', operation_name: 'op-fork' } },
      { status: 200, body: { status: 'Pending', owner_name: 'me', database_name: 'wl' } },
      { status: 200, body: { owner_name: 'me', database_name: 'wl' } },
    ]);
    const result = await forkDatabase({
      auth: { token: 't' },
      fromOwner: 'upstream',
      fromDb: 'wl',
      toOwner: 'me',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(result.created).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('refuses a polled fork that reports an error alongside the names', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 200, body: { status: 'Pending', operation_name: 'op-fork' } },
      { status: 200, body: { status: 'Error', owner_name: 'me', database_name: 'wl' } },
    ]);
    await expect(
      forkDatabase({
        auth: { token: 't' },
        fromOwner: 'upstream',
        fromDb: 'wl',
        toOwner: 'me',
        sleep: noSleep,
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
  });

  it('treats "already exists" as idempotent', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 400, body: { error: 'fork already exists under me' } },
    ]);
    const result = await forkDatabase({
      auth: { token: 't' },
      fromOwner: 'upstream',
      fromDb: 'wl',
      toOwner: 'me',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(result.created).toBe(false);
  });

  it('throws on a real failure', async () => {
    const { fetch: fakeFetch } = makeFetch([{ status: 403, body: { error: 'permission denied' } }]);
    await expect(
      forkDatabase({
        auth: { token: 't' },
        fromOwner: 'upstream',
        fromDb: 'wl',
        toOwner: 'me',
        sleep: noSleep,
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
  });

  it('throws when a 2xx body reports an error', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 200, body: { status: 'Error', message: 'user does not have access to me' } },
    ]);
    await expect(
      forkDatabase({
        auth: { token: 't' },
        fromOwner: 'upstream',
        fromDb: 'wl',
        toOwner: 'me',
        sleep: noSleep,
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
  });

  it('treats a 2xx "already exists" error body as idempotent', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 200, body: { status: 'Error', message: 'database already exists' } },
    ]);
    const result = await forkDatabase({
      auth: { token: 't' },
      fromOwner: 'upstream',
      fromDb: 'wl',
      toOwner: 'me',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(result.created).toBe(false);
  });

  it('refuses a 2xx pending fork that carries no operation to follow', async () => {
    const { fetch: fakeFetch } = makeFetch([{ status: 200, body: { status: 'Pending' } }]);
    await expect(
      forkDatabase({
        auth: { token: 't' },
        fromOwner: 'upstream',
        fromDb: 'wl',
        toOwner: 'me',
        sleep: noSleep,
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
  });

  it('accepts a sync body that names the fork it created', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 200, body: { owner_name: 'me', database_name: 'wl' } },
    ]);
    const result = await forkDatabase({
      auth: { token: 't' },
      fromOwner: 'upstream',
      fromDb: 'wl',
      toOwner: 'me',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(result.created).toBe(true);
  });

  it('refuses a 2xx status it does not recognize', async () => {
    const { fetch: fakeFetch } = makeFetch([{ status: 200, body: { status: 'Unexpected' } }]);
    await expect(
      forkDatabase({
        auth: { token: 't' },
        fromOwner: 'upstream',
        fromDb: 'wl',
        toOwner: 'me',
        sleep: noSleep,
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
  });

  it('refuses a sync non-success status that also names the fork', async () => {
    // The names must not stand in for a status the body states: only a
    // terminal success confirms the fork.
    for (const body of [
      { status: 'Pending', owner_name: 'me', database_name: 'wl' },
      { status: 'Running', owner_name: 'me', database_name: 'wl' },
      { status: 'Queued', owner_name: 'me', database_name: 'wl' },
      { status: 'Unexpected', owner_name: 'me', database_name: 'wl' },
    ]) {
      const { fetch: fakeFetch } = makeFetch([{ status: 200, body }]);
      await expect(
        forkDatabase({
          auth: { token: 't' },
          fromOwner: 'upstream',
          fromDb: 'wl',
          toOwner: 'me',
          sleep: noSleep,
          fetch: fakeFetch,
        })
      ).rejects.toBeInstanceOf(WlDoltHubError);
    }
  });

  it('accepts a sync terminal success status alongside the fork names', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 200, body: { status: 'Success', owner_name: 'me', database_name: 'wl' } },
    ]);
    const result = await forkDatabase({
      auth: { token: 't' },
      fromOwner: 'upstream',
      fromDb: 'wl',
      toOwner: 'me',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(result.created).toBe(true);
  });

  it('refuses a sync body that names a different fork', async () => {
    for (const body of [
      { status: 'Success', owner_name: 'someone-else', database_name: 'wl' },
      { owner_name: 'me', database_name: 'another-db' },
    ]) {
      const { fetch: fakeFetch } = makeFetch([{ status: 200, body }]);
      await expect(
        forkDatabase({
          auth: { token: 't' },
          fromOwner: 'upstream',
          fromDb: 'wl',
          toOwner: 'me',
          sleep: noSleep,
          fetch: fakeFetch,
        })
      ).rejects.toBeInstanceOf(WlDoltHubError);
    }
  });

  it('refuses a malformed error envelope', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 200, body: { status: 'Error', error: { message: 'denied' } } },
    ]);
    await expect(
      forkDatabase({
        auth: { token: 't' },
        fromOwner: 'upstream',
        fromDb: 'wl',
        toOwner: 'me',
        sleep: noSleep,
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
  });
});
