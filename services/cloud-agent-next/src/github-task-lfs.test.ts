import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubLfsDownloadUrl, githubLfsUploadUrl } from '@kilocode/worker-utils/github-task-lfs';
import { forwardGitHubTaskLfs } from './github-task-lfs.js';

const batchUrl =
  'https://github.com/na2-org/cloud-agent-security-test-a.git/info/lfs/objects/batch';
const object = { oid: 'a'.repeat(64), size: 17 };
const storageUrl = `https://github-cloud.s3.amazonaws.com/alambic/media/${object.oid}?signed=synthetic-storage-secret`;
const authorization = 'Basic synthetic-upstream-secret';
const capability = 'kgh3.synthetic-container-capability';
const batch = { operation: 'download', objects: [object] };
const batchResult = () => ({
  transfer: 'basic',
  objects: [
    {
      ...object,
      authenticated: true,
      actions: {
        download: {
          href: storageUrl,
          header: { Authorization: 'Bearer synthetic-storage-secret' },
        },
      },
    },
  ],
});
const input = () => ({
  request: new Request(batchUrl, { method: 'POST' }),
  policyBody: new TextEncoder().encode(JSON.stringify(batch)),
  authorization,
  capability,
});
const download = () =>
  forwardGitHubTaskLfs({
    ...input(),
    request: new Request(githubLfsDownloadUrl(batchUrl, object)),
  });

afterEach(() => vi.unstubAllGlobals());

describe('GitHub task LFS forwarding', () => {
  it('fetches a public LFS batch without GitHub authorization', async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json(batchResult()));
    vi.stubGlobal('fetch', upstream);
    const response = await forwardGitHubTaskLfs({ ...input(), authorization: null });
    expect(response.status).toBe(200);
    expect(new Headers(upstream.mock.calls[0][1].headers).has('authorization')).toBe(false);
    expect(await response.text()).not.toContain('synthetic-storage-secret');
  });

  it('exposes only the managed upload action and keeps verification inside the broker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          objects: [
            {
              ...object,
              actions: {
                upload: { href: storageUrl },
                verify: { href: batchUrl.replace('objects/batch', 'verify') },
              },
            },
          ],
        })
      )
    );
    const ref = 'refs/heads/kilo/task';
    const response = await forwardGitHubTaskLfs({
      ...input(),
      policyBody: new TextEncoder().encode(
        JSON.stringify({ ...batch, operation: 'upload', ref: { name: ref } })
      ),
    });
    const text = await response.text();
    expect(text).not.toContain('synthetic-storage-secret');
    expect(text).not.toContain('verify');
    expect(JSON.parse(text).objects[0].actions).toEqual({
      upload: {
        href: githubLfsUploadUrl(batchUrl, object, ref),
        header: { Authorization: `Bearer ${capability}` },
      },
    });
  });

  // Shape captured from a real GitHub upload batch response; values are synthetic.
  const githubVerify = (oid = object.oid, repository = 'na2-org/cloud-agent-security-test-a') => ({
    href: `https://lfs.github.com/${repository}/objects/${oid}/verify`,
    header: {
      Authorization: 'RemoteAuth synthetic-verify-secret',
      Accept: 'application/vnd.git-lfs+json',
    },
  });
  const githubUploadBatch = (verify: unknown) => ({
    objects: [
      {
        ...object,
        actions: {
          upload: {
            href: storageUrl,
            header: {
              Authorization: 'AWS4-HMAC-SHA256 synthetic-storage-secret',
              'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
              'x-amz-date': '20261015T120000Z',
            },
            expires_at: '2026-10-15T13:00:00Z',
            expires_in: 3600,
          },
          verify,
        },
      },
    ],
  });
  const uploadBatch = () =>
    forwardGitHubTaskLfs({
      ...input(),
      policyBody: new TextEncoder().encode(
        JSON.stringify({ ...batch, operation: 'upload', ref: { name: 'refs/heads/kilo/task' } })
      ),
    });

  it('accepts the repository-bound GitHub verification endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json(githubUploadBatch(githubVerify())))
    );
    const text = await (await uploadBatch()).text();
    expect(text).not.toContain('synthetic-verify-secret');
    expect(text).not.toContain('lfs.github.com');
    expect(JSON.parse(text).objects[0].actions.upload.href).toBe(
      githubLfsUploadUrl(batchUrl, object, 'refs/heads/kilo/task')
    );
  });

  it.each([
    ['another repository', githubVerify(object.oid, 'na2-org/cloud-agent-security-test-b')],
    ['another object', githubVerify('b'.repeat(64))],
    ['an extra header', { ...githubVerify(), header: { ...githubVerify().header, Cookie: 'x' } }],
    [
      'another host',
      { ...githubVerify(), href: githubVerify().href.replace('lfs.github.com', 'lfs.example.com') },
    ],
  ])('rejects GitHub verification for %s', async (_case, verify) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(githubUploadBatch(verify))));
    await expect(uploadBatch()).rejects.toThrow();
  });

  it('preserves an already stored upload object without an action', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ objects: [object] })));
    const response = await forwardGitHubTaskLfs({
      ...input(),
      policyBody: new TextEncoder().encode(
        JSON.stringify({ ...batch, operation: 'upload', ref: { name: 'refs/heads/kilo/task' } })
      ),
    });
    expect(await response.json()).toEqual({
      transfer: 'basic',
      objects: [{ ...object, authenticated: true }],
    });
  });

  it('preserves lock ownership and pagination without arbitrary upstream fields', async () => {
    const lock = {
      id: '1',
      path: 'fixture.bin',
      locked_at: '2026-10-15T00:00:00Z',
      owner: { name: 'Other' },
    };
    const upstream = vi
      .fn()
      .mockResolvedValue(
        Response.json({ ours: [], theirs: [lock], next_cursor: 'next', secret: 'synthetic' })
      );
    vi.stubGlobal('fetch', upstream);
    const body = { ref: { name: 'refs/heads/kilo/task' }, cursor: 'previous', limit: 100 };
    const response = await forwardGitHubTaskLfs({
      ...input(),
      request: new Request(batchUrl.replace('objects/batch', 'locks/verify'), { method: 'POST' }),
      policyBody: new TextEncoder().encode(JSON.stringify(body)),
    });
    expect(await response.json()).toEqual({ ours: [], theirs: [lock], next_cursor: 'next' });
    expect(JSON.parse(upstream.mock.calls[0][1].body)).toEqual(body);
  });

  it.each(['header', 'verify-repository', 'download', 'verify-only'])(
    'rejects unsafe upload authority: %s',
    async mode => {
      const actions = {
        upload: { href: storageUrl },
        verify: { href: batchUrl.replace('objects/batch', 'verify') },
      };
      if (mode === 'header')
        Object.assign(actions.upload, { header: { 'x-amz-copy-source': '/other/object' } });
      if (mode === 'verify-repository')
        actions.verify.href = actions.verify.href.replace('test-a', 'test-b');
      if (mode === 'download') Object.assign(actions, { download: actions.upload });
      const resultActions = mode === 'verify-only' ? { verify: actions.verify } : actions;
      const upstream = vi
        .fn()
        .mockResolvedValue(Response.json({ objects: [{ ...object, actions: resultActions }] }));
      vi.stubGlobal('fetch', upstream);
      await expect(
        forwardGitHubTaskLfs({
          ...input(),
          policyBody: new TextEncoder().encode(
            JSON.stringify({ ...batch, operation: 'upload', ref: { name: 'refs/heads/kilo/task' } })
          ),
        })
      ).rejects.toThrow();
      expect(upstream).toHaveBeenCalledOnce();
    }
  );

  it('replaces storage authority with an allocation-bound managed download', async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json(batchResult()));
    vi.stubGlobal('fetch', upstream);
    const response = await forwardGitHubTaskLfs(input());
    const text = await response.text();
    expect(text).not.toContain('synthetic-storage-secret');
    expect(text).not.toContain(authorization);
    expect(text).not.toContain('amazonaws.com');
    expect(JSON.parse(text)).toEqual({
      transfer: 'basic',
      objects: [
        {
          ...object,
          authenticated: true,
          actions: {
            download: {
              href: githubLfsDownloadUrl(batchUrl, object),
              header: { Authorization: `Bearer ${capability}` },
            },
          },
        },
      ],
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(upstream.mock.calls[0]?.[0]).toBe(batchUrl);
    expect(upstream.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: authorization },
    });
    const body = upstream.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(body)).toEqual({
      ...batch,
      transfers: ['basic'],
    });
  });

  it('revalidates one object with GitHub and streams only its bytes without the GitHub token', async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(batchResult()))
      .mockResolvedValueOnce(
        new Response('synthetic payload', {
          headers: {
            'Set-Cookie': 'synthetic-storage-secret',
            'X-Secret': 'synthetic-storage-secret',
          },
        })
      );
    vi.stubGlobal('fetch', upstream);
    const response = await download();
    expect(await response.text()).toBe('synthetic payload');
    expect(response.headers.get('content-length')).toBe('17');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has('x-secret')).toBe(false);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect((upstream.mock.calls[1]?.[0] as URL | undefined)?.href).toBe(storageUrl);
    const storageHeaders = new Headers(upstream.mock.calls[1]?.[1]?.headers);
    expect(storageHeaders.get('authorization')).toBe('Bearer synthetic-storage-secret');
    expect(storageHeaders.get('authorization')).not.toBe(authorization);
    expect(upstream.mock.calls[1]?.[1]?.redirect).toBe('manual');
  });

  it('downloads from the GitHub LFS media host returned by real batch responses', async () => {
    // Captured host shape: a presigned URL without storage headers.
    const href = `https://github-cloud.githubusercontent.com/alambic/media/1/aa/aa/${object.oid}?X-Amz-Signature=synthetic`;
    const result = { objects: [{ ...object, actions: { download: { href, header: {} } } }] };
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(result))
      .mockResolvedValueOnce(new Response('synthetic payload'));
    vi.stubGlobal('fetch', upstream);
    expect(await (await download()).text()).toBe('synthetic payload');
    expect((upstream.mock.calls[1]?.[0] as URL | undefined)?.href).toBe(href);
    expect(new Headers(upstream.mock.calls[1]?.[1]?.headers).has('authorization')).toBe(false);
  });

  it('keeps uploads on the storage host even when downloads use the media host', async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        objects: [
          {
            ...object,
            actions: {
              upload: { href: `https://github-cloud.githubusercontent.com/alambic/${object.oid}` },
            },
          },
        ],
      })
    );
    vi.stubGlobal('fetch', upstream);
    await expect(
      forwardGitHubTaskLfs({
        ...input(),
        policyBody: new TextEncoder().encode(
          JSON.stringify({ ...batch, operation: 'upload', ref: { name: 'refs/heads/kilo/task' } })
        ),
      })
    ).rejects.toThrow('Unsupported GitHub LFS upload target');
  });

  it.each([
    'https://github-cloud.githubusercontent.com.evil.test/object',
    'http://github-cloud.s3.amazonaws.com/object',
    'https://github-cloud.s3.amazonaws.com.evil.test/object',
    'https://other.s3.amazonaws.com/object',
    'https://127.0.0.1/object',
    'https://github-cloud.s3.amazonaws.com:8443/object',
    'https://user:password@media.githubusercontent.com/object',
    'https://media.githubusercontent.com/object#fragment',
  ])('rejects an unsafe storage destination %s', async href => {
    const result = batchResult();
    result.objects[0].actions.download.href = href;
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
    vi.stubGlobal('fetch', upstream);
    await expect(download()).rejects.toThrow('Unsupported GitHub LFS storage target');
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('rejects response-supplied routing headers', async () => {
    const result = batchResult();
    Object.assign(result.objects[0].actions.download.header, { Host: 'other.example' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(result)));
    await expect(download()).rejects.toThrow('Unsupported GitHub LFS storage header');
  });

  it.each(['batch', 'storage'])('does not follow or expose a %s redirect', async stage => {
    const upstream = vi.fn<typeof fetch>();
    if (stage === 'storage') upstream.mockResolvedValueOnce(Response.json(batchResult()));
    upstream.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://other.example/?secret=synthetic' },
      })
    );
    vi.stubGlobal('fetch', upstream);
    await expect(download()).rejects.toThrow('unavailable');
    expect(upstream).toHaveBeenCalledTimes(stage === 'batch' ? 1 : 2);
  });

  it.each(['different-oid', 'different-size', 'duplicate', 'missing', 'upload'])(
    'rejects a %s batch object',
    async mode => {
      const result = batchResult();
      if (mode === 'different-oid') result.objects[0].oid = 'b'.repeat(64);
      if (mode === 'different-size') result.objects[0].size++;
      if (mode === 'duplicate') result.objects.push(result.objects[0]);
      if (mode === 'missing') result.objects = [];
      if (mode === 'upload')
        Object.assign(result.objects[0].actions, { upload: result.objects[0].actions.download });
      const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
      vi.stubGlobal('fetch', upstream);
      await expect(download()).rejects.toThrow();
      expect(upstream).toHaveBeenCalledOnce();
    }
  );

  it('retains object errors but removes upstream error text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        Response.json({
          objects: [{ ...object, error: { code: 404, message: 'synthetic-upstream-secret' } }],
        })
      )
    );
    const response = await forwardGitHubTaskLfs(input());
    expect(await response.json()).toEqual({
      transfer: 'basic',
      objects: [{ ...object, error: { code: 404, message: 'GitHub LFS object unavailable' } }],
    });
    expect((await download()).status).toBe(404);
  });

  it('bounds the batch response before parsing it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(' '.repeat(1024 * 1024 + 1))));
    await expect(download()).rejects.toThrow('exceeds limit');
  });

  it.each(['short', 'long'])('rejects a %s object stream', async size => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(batchResult()))
        .mockResolvedValueOnce(new Response('x'.repeat(size === 'short' ? 16 : 18)))
    );
    const response = await download();
    await expect(response.text()).rejects.toThrow('size mismatch');
  });
});
