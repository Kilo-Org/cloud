/**
 * Tests for the attribution tracking request validation. Imports the worker
 * app with the Durable Object and auth middleware mocked, so the actual route
 * implementation is exercised.
 */
jest.mock('cloudflare:workers', () => ({ DurableObject: class {} }), { virtual: true });
jest.mock('./util/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const trackAttribution = jest.fn();
jest.mock('./dos/AttributionTracker.do', () => ({
  AttributionTrackerDO: class {},
  getAttributionTrackerDO: () => ({ trackAttribution }),
}));
jest.mock('./util/auth', () => ({
  authMiddleware: async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('user_id', USER_ID);
    c.set('organization_id', ORGANIZATION_ID);
    c.set('token', 'token');
    c.set('organization_role', 'owner');
    return next();
  },
}));
jest.mock('./util/admin-auth', () => ({
  adminAuthMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));

import type { HonoContext } from './ai-attribution.worker';
import {
  AdminAttributionsQueryParams,
  AttributionsTrackRequestBody,
  MAX_TRACK_BODY_BYTES,
  MAX_TRACK_LINE_ENTRIES,
  MAX_TRACK_ID_LENGTH,
  MAX_TRACK_PROJECT_ID_LENGTH,
  MAX_TRACK_FILE_PATH_LENGTH,
} from './schemas';

const USER_ID = 'user-123';
const ORGANIZATION_ID = 'org-123';

const validPayload = () => ({
  project_id: 'my-project',
  branch: 'main',
  file_path: 'src/index.ts',
  status: 'accepted' as const,
  task_id: null,
  lines_added: [{ line_number: 1, line_hash: 'a'.repeat(40) }],
  lines_removed: [],
});

const orgLimit = jest.fn(async () => ({ success: true }));
const userLimit = jest.fn(async () => ({ success: true }));

describe('AttributionsTrackRequestBody', () => {
  it('accepts a valid small payload', () => {
    expect(AttributionsTrackRequestBody.parse(validPayload())).toMatchObject({
      project_id: 'my-project',
      branch: 'main',
      file_path: 'src/index.ts',
    });
  });

  it('accepts nested relative file paths and a nullable task_id', () => {
    const payload = {
      ...validPayload(),
      file_path: 'src/lib/deep/nested/file.ts',
      task_id: 'task-abc',
    };

    expect(() => AttributionsTrackRequestBody.parse(payload)).not.toThrow();
  });

  it('rejects more entries than the array cap', () => {
    const lines = Array.from({ length: MAX_TRACK_LINE_ENTRIES + 1 }, (_, i) => ({
      line_number: i,
      line_hash: 'a'.repeat(40),
    }));

    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), lines_added: lines })
    ).toThrow();
  });

  it('accepts exactly the array cap', () => {
    const lines = Array.from({ length: MAX_TRACK_LINE_ENTRIES }, (_, i) => ({
      line_number: i,
      line_hash: 'a'.repeat(40),
    }));

    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), lines_added: lines })
    ).not.toThrow();
  });

  it('rejects a long line_hash', () => {
    const payload = {
      ...validPayload(),
      lines_added: [{ line_number: 1, line_hash: 'a'.repeat(129) }],
    };

    expect(() => AttributionsTrackRequestBody.parse(payload)).toThrow();
  });

  it('rejects an empty line_hash', () => {
    const payload = {
      ...validPayload(),
      lines_added: [{ line_number: 1, line_hash: '' }],
    };

    expect(() => AttributionsTrackRequestBody.parse(payload)).toThrow();
  });

  it('rejects a negative line_number', () => {
    const payload = {
      ...validPayload(),
      lines_added: [{ line_number: -1, line_hash: 'a'.repeat(40) }],
    };

    expect(() => AttributionsTrackRequestBody.parse(payload)).toThrow();
  });

  it('rejects a long project_id', () => {
    const payload = { ...validPayload(), project_id: 'p'.repeat(MAX_TRACK_PROJECT_ID_LENGTH + 1) };

    expect(() => AttributionsTrackRequestBody.parse(payload)).toThrow();
  });

  it('accepts a project_id at the storage length boundary', () => {
    const payload = { ...validPayload(), project_id: 'p'.repeat(MAX_TRACK_PROJECT_ID_LENGTH) };

    expect(() => AttributionsTrackRequestBody.parse(payload)).not.toThrow();
  });

  it('rejects a long branch', () => {
    const payload = { ...validPayload(), branch: 'b'.repeat(MAX_TRACK_ID_LENGTH + 1) };

    expect(() => AttributionsTrackRequestBody.parse(payload)).toThrow();
  });

  it('rejects a long file_path', () => {
    const payload = { ...validPayload(), file_path: 'f'.repeat(MAX_TRACK_FILE_PATH_LENGTH + 1) };

    expect(() => AttributionsTrackRequestBody.parse(payload)).toThrow();
  });

  it('rejects an empty project_id or branch', () => {
    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), project_id: '' })
    ).toThrow();
    expect(() => AttributionsTrackRequestBody.parse({ ...validPayload(), branch: '' })).toThrow();
  });

  it('normalizes a path to one canonical form', () => {
    const parsePath = (file_path: string) =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), file_path }).file_path;

    expect(parsePath('./src/index.ts')).toBe('src/index.ts');
    expect(parsePath('src//lib/./index.ts')).toBe('src/lib/index.ts');
    expect(parsePath('src\\lib\\index.ts')).toBe('src/lib/index.ts');
    expect(parsePath('src/lib/../index.ts')).toBe('src/index.ts');
    expect(parsePath('../../outside/file.ts')).toBe('outside/file.ts');
  });

  it('gives one file one canonical identity', () => {
    const parse = (file_path: string) =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), file_path }).file_path;

    expect(parse('/home/dev/project/src/index.ts')).toBe(
      parse('src/../../../home/dev/project/src/index.ts')
    );
  });

  it('rejects an empty path and control characters', () => {
    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), file_path: '' })
    ).toThrow();
    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), file_path: './' })
    ).toThrow();
    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), project_id: 'pro\u0000ject' })
    ).toThrow();
  });

  it('bounds the accepted path length', () => {
    const segments = Array.from({ length: 5000 }, () => '.').join('/');

    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), file_path: segments })
    ).toThrow();
  });

  it('fits a whole-file rewrite at the entry cap inside the body budget', () => {
    // One array at the cap is what a whole-file write sends; the byte budget
    // stays the tighter bound for a request that fills both arrays.
    const lines = Array.from({ length: MAX_TRACK_LINE_ENTRIES }, (_, i) => ({
      line_number: i,
      line_hash: 'a'.repeat(40),
    }));
    const body = JSON.stringify({ ...validPayload(), lines_added: lines, lines_removed: [] });

    expect(Buffer.byteLength(body)).toBeLessThan(MAX_TRACK_BODY_BYTES);
    expect(() => AttributionsTrackRequestBody.parse(JSON.parse(body))).not.toThrow();
  });

  it('rejects a long task_id', () => {
    const payload = { ...validPayload(), task_id: 't'.repeat(MAX_TRACK_ID_LENGTH + 1) };

    expect(() => AttributionsTrackRequestBody.parse(payload)).toThrow();
  });
});

describe('AdminAttributionsQueryParams', () => {
  it('uses the same path schema as tracking', () => {
    const tracked = AttributionsTrackRequestBody.parse({
      ...validPayload(),
      file_path: './src/lib/../index.ts',
    });
    const queried = AdminAttributionsQueryParams.parse({
      organization_id: 'org-123',
      project_id: 'my-project',
      file_path: 'src/index.ts',
    });

    expect(queried.file_path).toBe(tracked.file_path);
    expect(queried.project_id).toBe(tracked.project_id);
  });

  it('rejects an empty path', () => {
    expect(() =>
      AdminAttributionsQueryParams.parse({
        organization_id: 'org-123',
        project_id: 'my-project',
        file_path: './',
      })
    ).toThrow();
  });
});

describe('attribution tracking request validation', () => {
  const env = () =>
    ({
      ENVIRONMENT: 'development',
      ATTRIBUTION_TRACK_ORG_RATE_LIMITER: { limit: orgLimit },
      ATTRIBUTION_TRACK_USER_RATE_LIMITER: { limit: userLimit },
      NEXTAUTH_SECRET: { get: async () => 'secret' },
    }) as unknown as HonoContext['Bindings'];

  const trackRequest = async (init: RequestInit) => {
    // Imported after the jest.mock hoisting above so the mocks are in place.
    const { default: app } = await import('./ai-attribution.worker');
    return app.request('/attributions/track', init, env());
  };

  beforeEach(() => {
    orgLimit.mockClear().mockResolvedValue({ success: true });
    userLimit.mockClear().mockResolvedValue({ success: true });
    trackAttribution.mockClear().mockReturnValue({ id: 1 });
  });

  it('returns 413 for a declared Content-Length above the body budget', async () => {
    const response = await trackRequest({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_TRACK_BODY_BYTES + 1),
      },
      body: JSON.stringify(validPayload()),
    });

    expect(response.status).toBe(413);
    expect(trackAttribution).not.toHaveBeenCalled();
  });

  it('returns 413 for a chunked body above the body budget without Content-Length', async () => {
    const oversized = 'x'.repeat(MAX_TRACK_BODY_BYTES + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized));
        controller.close();
      },
    });

    const response = await trackRequest({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stream as unknown as BodyInit,
      // undici requires duplex when a stream body is sent
      duplex: 'half',
    } as RequestInit);

    expect(response.status).toBe(413);
    expect(trackAttribution).not.toHaveBeenCalled();
  });

  it('returns 400 for an oversized line array', async () => {
    const lines = Array.from({ length: MAX_TRACK_LINE_ENTRIES + 1 }, (_, i) => ({
      line_number: i,
      line_hash: 'a'.repeat(40),
    }));

    const response = await trackRequest({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validPayload(), lines_added: lines }),
    });

    expect(response.status).toBe(400);
    expect(trackAttribution).not.toHaveBeenCalled();
  });

  it('returns 400 for a field the schema rejects', async () => {
    const response = await trackRequest({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validPayload(), branch: 'b'.repeat(MAX_TRACK_ID_LENGTH + 1) }),
    });

    expect(response.status).toBe(400);
    expect(trackAttribution).not.toHaveBeenCalled();
  });

  it('returns 429 when the user counter is at capacity', async () => {
    userLimit.mockResolvedValueOnce({ success: false });

    const response = await trackRequest({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload()),
    });

    expect(response.status).toBe(429);
    expect(trackAttribution).not.toHaveBeenCalled();
  });

  it('counts each request on the organization and user limiters', async () => {
    await trackRequest({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload()),
    });

    expect(orgLimit).toHaveBeenCalledWith({ key: ORGANIZATION_ID });
    expect(userLimit).toHaveBeenCalledWith({ key: USER_ID });
  });

  it('returns 429 from the organization limiter alone', async () => {
    orgLimit.mockResolvedValueOnce({ success: false });

    const response = await trackRequest({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload()),
    });

    expect(response.status).toBe(429);
    expect(trackAttribution).not.toHaveBeenCalled();
  });

  it('counts the request on both limiters when one rejects', async () => {
    orgLimit.mockResolvedValueOnce({ success: false });

    await trackRequest({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload()),
    });

    expect(userLimit).toHaveBeenCalledTimes(1);
  });

  it('forwards a valid payload to the Durable Object', async () => {
    const response = await trackRequest({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload()),
    });

    expect(response.status).toBe(200);
    expect(trackAttribution).toHaveBeenCalledTimes(1);
    expect(trackAttribution).toHaveBeenCalledWith({
      ...validPayload(),
      user_id: USER_ID,
      organization_id: ORGANIZATION_ID,
    });
  });
});
