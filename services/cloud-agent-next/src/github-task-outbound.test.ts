import { describe, expect, it, vi } from 'vitest';
import { isGitHubTaskDestination, prepareGitHubTaskRequest } from './github-task-outbound.js';

const git = 'https://github.com/na2-org/cloud-agent-security-test-a.git/git-receive-pack';
const api = 'https://api.github.com/repos/na2-org/cloud-agent-security-test-a/pulls';
const encoder = new TextEncoder();
const packet = (line: string) =>
  `${(encoder.encode(line).length + 4).toString(16).padStart(4, '0')}${line}`;
const command = packet(`${'0'.repeat(40)} ${'1'.repeat(40)} refs/heads/kilo/task\0report-status\n`);

function streamedRequest(url: string, chunks: string[], cancel = vi.fn()) {
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
      cancel,
    },
    { highWaterMark: 0 }
  );
  return new Request(url, { method: 'POST', body, ...{ duplex: 'half' } });
}

describe('GitHub task outbound body boundary', () => {
  it('streams all push refs without interpreting branch commands', async () => {
    const chunks = [command.slice(0, 2), command.slice(2), command, '0000PACK', 'synthetic pack'];
    const prepared = await prepareGitHubTaskRequest(streamedRequest(git, [...chunks]));
    expect(prepared?.policyBody).toBeUndefined();
    expect(await prepared?.request.text()).toBe(chunks.join(''));
  });

  it('does not consume the Git push before authorization', async () => {
    const chunks = [command, '0000PACKsynthetic'];
    const cancel = vi.fn();
    const prepared = await prepareGitHubTaskRequest(streamedRequest(git, chunks, cancel));
    expect(chunks).toContain('0000PACKsynthetic');
    await prepared?.request.body?.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('canonicalizes JSON once and strips alternate authorization headers', async () => {
    const request = new Request(api, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'synthetic',
        'PRIVATE-TOKEN': 'synthetic',
        Authorization: 'Bearer synthetic',
      },
      body: '{"head":"main","head":"kilo/task","title":"Synthetic PR"}',
    });
    const prepared = await prepareGitHubTaskRequest(request);
    expect(prepared?.request.headers.get('content-type')).toBe('application/json');
    expect(prepared?.request.headers.has('authorization')).toBe(false);
    expect(prepared?.request.headers.has('cookie')).toBe(false);
    expect(prepared?.request.headers.has('private-token')).toBe(false);
    const forwarded = await prepared?.request.text();
    expect(forwarded).toBe(new TextDecoder().decode(prepared?.policyBody));
    expect(JSON.parse(forwarded ?? '')).toEqual({ head: 'kilo/task', title: 'Synthetic PR' });
  });

  it('prepares LFS JSON and denies unscoped upload batches', async () => {
    const url = 'https://github.com/na2-org/cloud-agent-security-test-a.git/info/lfs/objects/batch';
    const body = { operation: 'download', objects: [{ oid: 'a'.repeat(64), size: 17 }] };
    const prepared = await prepareGitHubTaskRequest(
      new Request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.git-lfs+json',
          Authorization: 'Bearer synthetic',
        },
        body: JSON.stringify(body),
      })
    );
    expect(prepared).not.toBeNull();
    expect(prepared?.request.headers.has('authorization')).toBe(false);
    expect(await prepared?.request.text()).toBe(new TextDecoder().decode(prepared?.policyBody));
    expect(
      await prepareGitHubTaskRequest(
        new Request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/vnd.git-lfs+json' },
          body: JSON.stringify({ ...body, operation: 'upload' }),
        })
      )
    ).toBeNull();
  });

  it('does not buffer upload bytes and removes guest storage headers', async () => {
    const read = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: read, cancel }, { highWaterMark: 0 });
    const url = `https://github.com/na2-org/cloud-agent-security-test-a.git/info/lfs/kilo-upload/${'a'.repeat(64)}?size=17&ref=refs%2Fheads%2Fkilo%2Ftask`;
    const prepared = await prepareGitHubTaskRequest(
      new Request(url, {
        method: 'PUT',
        body,
        ...{ duplex: 'half' },
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: 'synthetic',
          'x-amz-copy-source': '/other/object',
          Cookie: 'synthetic',
        },
      })
    );
    // Request construction can prefetch once. The preparer must not drain the body.
    expect(read.mock.calls.length).toBeLessThanOrEqual(1);
    expect(prepared?.policyBody).toBeUndefined();
    expect([...prepared!.request.headers]).toEqual([['content-type', 'application/octet-stream']]);
    await prepared?.request.body?.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['{', ' '.repeat(256 * 1024 + 1), '\ufeff{}'])(
    'rejects malformed or oversized JSON',
    async body => {
      expect(await prepareGitHubTaskRequest(new Request(api, { method: 'POST', body }))).toBeNull();
    }
  );

  it.each([
    new Headers({ 'Content-Encoding': 'gzip' }),
    new Headers({ 'X-HTTP-Method-Override': 'DELETE' }),
  ])('rejects ambiguous request interpretation', async headers => {
    expect(
      await prepareGitHubTaskRequest(new Request(api, { method: 'POST', headers, body: '{}' }))
    ).toBeNull();
  });

  it('cancels a JSON body that never completes within the deadline', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const pending = prepareGitHubTaskRequest(
        new Request(api, { method: 'POST', body, ...{ duplex: 'half' } })
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toBeNull();
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GitHub resource host boundary', () => {
  it.each([
    'https://github.com',
    'https://api.github.com',
    'https://github.com.',
    'https://raw.githubusercontent.com',
    'https://media.githubusercontent.com',
    'https://gist.githubusercontent.com',
    'https://gist.github.com',
    'https://npm.pkg.github.com',
    'https://github-cloud.s3.amazonaws.com',
  ])('requires managed task authorization at %s', value => {
    expect(isGitHubTaskDestination(new URL(value))).toBe(true);
  });
  it('preserves unrelated dependency registry access', () => {
    expect(isGitHubTaskDestination(new URL('https://registry.npmjs.org'))).toBe(false);
  });
  it('does not classify a suffix lookalike as a GitHub resource', () => {
    expect(isGitHubTaskDestination(new URL('https://api.github.com.example.org'))).toBe(false);
  });
});
