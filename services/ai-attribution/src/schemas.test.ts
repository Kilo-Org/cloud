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

const limit = jest.fn(async () => ({ success: true }));

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

  it('rejects an absolute file_path or project_id', () => {
    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), file_path: '/etc/passwd' })
    ).toThrow();
    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), project_id: '/abs/project' })
    ).toThrow();
  });

  it('rejects a traversal file_path or project_id', () => {
    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), file_path: '../outside/file.ts' })
    ).toThrow();
    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), file_path: 'src/../../file.ts' })
    ).toThrow();
    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), project_id: '../project' })
    ).toThrow();
  });

  it('rejects empty path segments', () => {
    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), file_path: 'src//file.ts' })
    ).toThrow();
  });

  it('rejects backslashes and control characters in paths', () => {
    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), file_path: 'src\\file.ts' })
    ).toThrow();
    expect(() =>
      AttributionsTrackRequestBody.parse({ ...validPayload(), project_id: 'pro\u0000ject' })
    ).toThrow();
  });

  it('rejects a long task_id', () => {
    const payload = { ...validPayload(), task_id: 't'.repeat(MAX_TRACK_ID_LENGTH + 1) };

    expect(() => AttributionsTrackRequestBody.parse(payload)).toThrow();
  });
});

describe('attribution tracking request validation', () => {
  const env = () =>
    ({
      ENVIRONMENT: 'development',
      ATTRIBUTION_TRACK_RATE_LIMITER: { limit },
      NEXTAUTH_SECRET: { get: async () => 'secret' },
    }) as unknown as HonoContext['Bindings'];

  const trackRequest = async (init: RequestInit) => {
    // Imported after the jest.mock hoisting above so the mocks are in place.
    const { default: app } = await import('./ai-attribution.worker');
    return app.request('/attributions/track', init, env());
  };

  beforeEach(() => {
    limit.mockClear().mockResolvedValue({ success: true });
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

  it('returns 429 when the rate limit is at capacity for the org and user', async () => {
    limit.mockResolvedValueOnce({ success: false });

    const response = await trackRequest({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload()),
    });

    expect(response.status).toBe(429);
    expect(trackAttribution).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledWith({ key: `${ORGANIZATION_ID}:${USER_ID}` });
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
