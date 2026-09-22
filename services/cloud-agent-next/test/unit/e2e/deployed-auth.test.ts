import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';

// Count file reads without changing behaviour: the mock delegates to the real
// implementation, so `loadDeployedAuthFile` and every other reader keep working.
const fsMocks = vi.hoisted(() => ({ readFileSync: vi.fn() }));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMocks.readFileSync.mockImplementation(actual.readFileSync);
  return { ...actual, readFileSync: fsMocks.readFileSync };
});

import {
  assertDeployedProfileEnv,
  bootstrapDeployedProfile,
  decodeOrdinaryPersonalToken,
  fetchStreamTicket,
  loadDeployedAuthFile,
} from '../../e2e/deployed-auth.js';
import { fetchFakeRequests } from '../../e2e/client.js';
import { LOCAL_FAKE_LLM_ADMIN_TOKEN } from '../../e2e/fake-llm-admin.js';
import { LOCAL_E2E_INTERNAL_API_SECRET } from '../../e2e/e2e-internal-secret.js';

const SECRET = 'deployed-auth-test-secret';
const USER_ID = 'usr_test_deployed';
const PEPPER = 'pepper_test_deployed';

function ordinaryToken(extra: Record<string, unknown> = {}, secret = SECRET): string {
  return jwt.sign(
    { env: 'test', kiloUserId: USER_ID, apiTokenPepper: PEPPER, version: 3, ...extra },
    secret
  );
}

const tempDirs: string[] = [];

function writeAuthFile(contents: unknown, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'deployed-auth-'));
  tempDirs.push(dir);
  const file = join(dir, 'auth.json');
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  chmodSync(file, mode);
  return file;
}

afterEach(() => {
  vi.unstubAllGlobals();
  fsMocks.readFileSync.mockClear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('decodeOrdinaryPersonalToken', () => {
  it('accepts a generateApiToken-shaped payload with no policy claims', () => {
    expect(decodeOrdinaryPersonalToken(ordinaryToken())).toEqual({ kiloUserId: USER_ID });
  });

  it.each([
    'aud',
    'runtimeAdmission',
    'runtimeAuthorization',
    'tokenPurpose',
    'credentialExchange',
    'organizationId',
    'organizationRole',
  ])('fails closed on the %s claim', claim => {
    const token = ordinaryToken({ [claim]: claim === 'credentialExchange' ? false : 'value' });
    expect(() => decodeOrdinaryPersonalToken(token)).toThrow(
      new RegExp(`policy claim "${claim}"`, 'i')
    );
  });

  it('fails closed when kiloUserId is missing', () => {
    const token = jwt.sign({ env: 'test', apiTokenPepper: PEPPER, version: 3 }, SECRET);
    expect(() => decodeOrdinaryPersonalToken(token)).toThrow(/kiloUserId/);
  });

  it('fails closed when apiTokenPepper is missing', () => {
    const token = jwt.sign({ env: 'test', kiloUserId: USER_ID, version: 3 }, SECRET);
    expect(() => decodeOrdinaryPersonalToken(token)).toThrow(/apiTokenPepper/);
  });

  it('accepts a payload whose apiTokenPepper claim is explicitly null', () => {
    expect(decodeOrdinaryPersonalToken(ordinaryToken({ apiTokenPepper: null }))).toEqual({
      kiloUserId: USER_ID,
    });
  });

  it.each([
    ['a Bearer-prefixed value', `Bearer ${ordinaryToken()}`],
    ['a quoted/serialised value', JSON.stringify(ordinaryToken())],
    ['a two-segment value', 'aaaaaaaa.bbbbbbbb'],
    ['garbage', 'not-a-jwt'],
  ])('fails closed on %s', (_name, token) => {
    expect(() => decodeOrdinaryPersonalToken(token)).toThrow(/bare three-segment JWT/i);
  });

  it('never includes the token value in the diagnostic', () => {
    const token = ordinaryToken({ aud: 'some-audience' });
    let thrown: unknown;
    try {
      decodeOrdinaryPersonalToken(token);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(token);
  });
});

describe('loadDeployedAuthFile', () => {
  it('accepts a mode-600 file with an ordinary token', () => {
    const token = ordinaryToken();
    const file = writeAuthFile({
      token,
      userId: USER_ID,
      email: 'deployed@example.test',
    });
    expect(loadDeployedAuthFile(file)).toEqual({
      token,
      identity: { userId: USER_ID, email: 'deployed@example.test' },
      fakeLlmAdminToken: undefined,
      e2eInternalApiSecret: undefined,
    });
  });

  it('reads an optional e2eInternalApiSecret field', () => {
    const token = ordinaryToken();
    const file = writeAuthFile({
      token,
      userId: USER_ID,
      e2eInternalApiSecret: 'file-internal-secret-0123456789',
    });
    expect(loadDeployedAuthFile(file).e2eInternalApiSecret).toBe('file-internal-secret-0123456789');
  });

  it('refuses a non-string e2eInternalApiSecret field', () => {
    const file = writeAuthFile({
      token: ordinaryToken(),
      userId: USER_ID,
      e2eInternalApiSecret: 42,
    });
    expect(() => loadDeployedAuthFile(file)).toThrow(/e2eInternalApiSecret/);
  });

  it.each([0o644, 0o640])('refuses a group/other-accessible mode %o', mode => {
    const file = writeAuthFile(
      { token: ordinaryToken(), userId: USER_ID, email: 'deployed@example.test' },
      mode
    );
    expect(() => loadDeployedAuthFile(file)).toThrow(/permissions|chmod 600/i);
  });

  it('refuses invalid JSON', () => {
    const file = writeAuthFile('{not json');
    expect(() => loadDeployedAuthFile(file)).toThrow(/valid JSON/i);
  });

  it.each(['token'])('refuses a missing %s field', field => {
    const record: Record<string, unknown> = {
      token: ordinaryToken(),
      userId: USER_ID,
      email: 'deployed@example.test',
    };
    delete record[field];
    const file = writeAuthFile(record);
    expect(() => loadDeployedAuthFile(file)).toThrow(new RegExp(`"${field}"`));
  });

  it('derives the identity userId when the file omits it', () => {
    const token = ordinaryToken();
    const file = writeAuthFile({ token, email: 'deployed@example.test' });
    expect(loadDeployedAuthFile(file)).toEqual({
      token,
      identity: { userId: USER_ID, email: 'deployed@example.test' },
      fakeLlmAdminToken: undefined,
      e2eInternalApiSecret: undefined,
    });
  });

  it('yields an undefined email when the file omits it', () => {
    const token = ordinaryToken();
    const file = writeAuthFile({ token, userId: USER_ID });
    expect(loadDeployedAuthFile(file).identity).toEqual({ userId: USER_ID, email: undefined });
  });

  it('refuses a present but empty userId', () => {
    const file = writeAuthFile({ token: ordinaryToken(), userId: '' });
    expect(() => loadDeployedAuthFile(file)).toThrow(/"userId" must be a non-empty string/);
  });

  it('refuses when the decoded kiloUserId differs from the file userId', () => {
    const file = writeAuthFile({
      token: ordinaryToken(),
      userId: 'usr_someone_else',
      email: 'deployed@example.test',
    });
    expect(() => loadDeployedAuthFile(file)).toThrow(/does not match the file "userId"/);
  });

  it('refuses a policy-bearing token', () => {
    const file = writeAuthFile({
      token: ordinaryToken({ tokenPurpose: 'runtime' }),
      userId: USER_ID,
      email: 'deployed@example.test',
    });
    expect(() => loadDeployedAuthFile(file)).toThrow(/tokenPurpose/);
  });
});

describe('assertDeployedProfileEnv', () => {
  const EMAIL = 'deployed@example.test';
  const ENV_ADMIN_TOKEN = 'deployed-admin-token';
  const ENV_INTERNAL_SECRET = 'deployed-internal-secret-0123456789';

  function deployedEnv(options: {
    fileFields?: Record<string, unknown>;
    overrides?: Record<string, string | undefined>;
  }): { env: Record<string, string | undefined>; token: string; authFile: string } {
    const token = ordinaryToken();
    const authFile = writeAuthFile({
      token,
      userId: USER_ID,
      email: EMAIL,
      ...options.fileFields,
    });
    const env: Record<string, string | undefined> = {
      WORKER_URL: 'https://worker.example.test',
      E2E_BACKEND_URL: 'https://api.kilo.ai',
      FAKE_LLM_URL: 'https://fake.example.test',
      E2E_AUTH_FILE: authFile,
      FAKE_LLM_ADMIN_TOKEN: ENV_ADMIN_TOKEN,
      E2E_INTERNAL_API_SECRET: ENV_INTERNAL_SECRET,
      ...options.overrides,
    };
    return { env, token, authFile };
  }

  it('accepts three https URLs, an auth file, the admin bearer, and the e2e secret', () => {
    const { env, token, authFile } = deployedEnv({});
    expect(assertDeployedProfileEnv(env)).toEqual({
      workerUrl: env.WORKER_URL,
      backendUrl: env.E2E_BACKEND_URL,
      fakeLlmUrl: env.FAKE_LLM_URL,
      authFile,
      fakeLlmAdminToken: ENV_ADMIN_TOKEN,
      e2eInternalApiSecret: ENV_INTERNAL_SECRET,
      auth: { token, identity: { userId: USER_ID, email: EMAIL } },
    });
  });

  it.each([
    'WORKER_URL',
    'E2E_BACKEND_URL',
    'FAKE_LLM_URL',
    'E2E_AUTH_FILE',
    'FAKE_LLM_ADMIN_TOKEN',
    'E2E_INTERNAL_API_SECRET',
  ])('refuses a missing %s variable', key => {
    const { env } = deployedEnv({});
    const rest: Record<string, string | undefined> = { ...env };
    delete rest[key];
    expect(() => assertDeployedProfileEnv(rest)).toThrow(new RegExp(key));
  });

  it('refuses an http:// URL', () => {
    const { env } = deployedEnv({});
    expect(() =>
      assertDeployedProfileEnv({ ...env, E2E_BACKEND_URL: 'http://api.kilo.ai' })
    ).toThrow(/E2E_BACKEND_URL/);
  });

  it('refuses an empty FAKE_LLM_ADMIN_TOKEN', () => {
    const { env } = deployedEnv({ overrides: { FAKE_LLM_ADMIN_TOKEN: '' } });
    expect(() => assertDeployedProfileEnv(env)).toThrow(/FAKE_LLM_ADMIN_TOKEN/);
  });

  it('refuses a whitespace-padded FAKE_LLM_ADMIN_TOKEN', () => {
    const { env } = deployedEnv({});
    expect(() => assertDeployedProfileEnv({ ...env, FAKE_LLM_ADMIN_TOKEN: ' token ' })).toThrow(
      /whitespace/
    );
  });

  it('refuses the insecure development default', () => {
    const { env } = deployedEnv({});
    expect(() =>
      assertDeployedProfileEnv({ ...env, FAKE_LLM_ADMIN_TOKEN: 'local-fake-llm-admin' })
    ).toThrow(/insecure development default/);
  });

  it('prefers the env var over a different valid file fakeLlmAdminToken', () => {
    const { env } = deployedEnv({ fileFields: { fakeLlmAdminToken: 'file-admin-token' } });
    expect(assertDeployedProfileEnv(env).fakeLlmAdminToken).toBe(ENV_ADMIN_TOKEN);
  });

  it('accepts a file fakeLlmAdminToken when the env var is unset', () => {
    const { env } = deployedEnv({
      fileFields: { fakeLlmAdminToken: 'file-admin-token' },
      overrides: { FAKE_LLM_ADMIN_TOKEN: undefined },
    });
    expect(assertDeployedProfileEnv(env).fakeLlmAdminToken).toBe('file-admin-token');
  });

  it('names both options when neither the env var nor the file supplies a token', () => {
    const { env, authFile } = deployedEnv({ overrides: { FAKE_LLM_ADMIN_TOKEN: undefined } });
    let thrown: unknown;
    try {
      assertDeployedProfileEnv(env);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = String(thrown);
    expect(message).toMatch(/FAKE_LLM_ADMIN_TOKEN/);
    expect(message).toMatch(/fakeLlmAdminToken/);
    expect(message).toContain(authFile);
  });

  it('refuses the insecure development default from the file', () => {
    const { env } = deployedEnv({
      fileFields: { fakeLlmAdminToken: LOCAL_FAKE_LLM_ADMIN_TOKEN },
      overrides: { FAKE_LLM_ADMIN_TOKEN: undefined },
    });
    expect(() => assertDeployedProfileEnv(env)).toThrow(/insecure development default/);
  });

  it('refuses a whitespace-padded file fakeLlmAdminToken', () => {
    const { env } = deployedEnv({
      fileFields: { fakeLlmAdminToken: ' file-admin-token ' },
      overrides: { FAKE_LLM_ADMIN_TOKEN: undefined },
    });
    expect(() => assertDeployedProfileEnv(env)).toThrow(/whitespace/);
  });

  it('refuses a non-string file fakeLlmAdminToken', () => {
    const { env } = deployedEnv({
      fileFields: { fakeLlmAdminToken: 42 },
      overrides: { FAKE_LLM_ADMIN_TOKEN: undefined },
    });
    expect(() => assertDeployedProfileEnv(env)).toThrow(/fakeLlmAdminToken/);
  });

  it('prefers the env E2E_INTERNAL_API_SECRET over a different valid file value', () => {
    const { env } = deployedEnv({
      fileFields: { e2eInternalApiSecret: 'file-internal-secret-0123456789' },
    });
    expect(assertDeployedProfileEnv(env).e2eInternalApiSecret).toBe(ENV_INTERNAL_SECRET);
  });

  it('accepts a file e2eInternalApiSecret when the env var is unset', () => {
    const { env } = deployedEnv({
      fileFields: { e2eInternalApiSecret: 'file-internal-secret-0123456789' },
      overrides: { E2E_INTERNAL_API_SECRET: undefined },
    });
    expect(assertDeployedProfileEnv(env).e2eInternalApiSecret).toBe(
      'file-internal-secret-0123456789'
    );
  });

  it('names both options when neither the env var nor the file supplies the e2e secret', () => {
    const { env, authFile } = deployedEnv({ overrides: { E2E_INTERNAL_API_SECRET: undefined } });
    let thrown: unknown;
    try {
      assertDeployedProfileEnv(env);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = String(thrown);
    expect(message).toMatch(/E2E_INTERNAL_API_SECRET/);
    expect(message).toMatch(/e2eInternalApiSecret/);
    expect(message).toContain(authFile);
  });

  it('treats an empty E2E_INTERNAL_API_SECRET as unset and falls back to the file', () => {
    const { env } = deployedEnv({
      fileFields: { e2eInternalApiSecret: 'file-internal-secret-0123456789' },
      overrides: { E2E_INTERNAL_API_SECRET: '' },
    });
    expect(assertDeployedProfileEnv(env).e2eInternalApiSecret).toBe(
      'file-internal-secret-0123456789'
    );
  });

  it('refuses a whitespace-padded E2E_INTERNAL_API_SECRET instead of trimming it', () => {
    const { env } = deployedEnv({});
    expect(() =>
      assertDeployedProfileEnv({ ...env, E2E_INTERNAL_API_SECRET: ` ${ENV_INTERNAL_SECRET} ` })
    ).toThrow(/whitespace/);
  });

  it('refuses an E2E_INTERNAL_API_SECRET shorter than 16 characters', () => {
    const { env } = deployedEnv({});
    expect(() =>
      assertDeployedProfileEnv({ ...env, E2E_INTERNAL_API_SECRET: 'short-secret' })
    ).toThrow(/at least 16/);
  });

  it('accepts a non-alphabet secret: the dotenv alphabet is a local-renderer rule only', () => {
    // A base64 value with `+` and `/` is valid for the Worker secret upload and
    // the driver. The renderer rejects it because it writes a `.dev.vars` line;
    // no deployed path may re-impose that alphabet.
    const base64Secret = 'AbC+/e2e-internal-secret-0123456789==';
    const { env } = deployedEnv({});
    expect(
      assertDeployedProfileEnv({ ...env, E2E_INTERNAL_API_SECRET: base64Secret })
        .e2eInternalApiSecret
    ).toBe(base64Secret);
  });

  it('refuses the insecure development default e2e secret', () => {
    const { env } = deployedEnv({});
    expect(() =>
      assertDeployedProfileEnv({ ...env, E2E_INTERNAL_API_SECRET: LOCAL_E2E_INTERNAL_API_SECRET })
    ).toThrow(/insecure development default/);
  });

  it('refuses the insecure development default from the file', () => {
    const { env } = deployedEnv({
      fileFields: { e2eInternalApiSecret: LOCAL_E2E_INTERNAL_API_SECRET },
      overrides: { E2E_INTERNAL_API_SECRET: undefined },
    });
    expect(() => assertDeployedProfileEnv(env)).toThrow(/insecure development default/);
  });

  it('refuses a whitespace-padded file e2eInternalApiSecret', () => {
    const { env } = deployedEnv({
      fileFields: { e2eInternalApiSecret: ' file-internal-secret-0123456789 ' },
      overrides: { E2E_INTERNAL_API_SECRET: undefined },
    });
    expect(() => assertDeployedProfileEnv(env)).toThrow(/whitespace/);
  });

  it('accepts E2E_USER_TOKEN alone and derives the identity from it', () => {
    const envToken = ordinaryToken();
    const env: Record<string, string | undefined> = {
      WORKER_URL: 'https://worker.example.test',
      E2E_BACKEND_URL: 'https://api.kilo.ai',
      FAKE_LLM_URL: 'https://fake.example.test',
      FAKE_LLM_ADMIN_TOKEN: ENV_ADMIN_TOKEN,
      E2E_USER_TOKEN: envToken,
      E2E_INTERNAL_API_SECRET: ENV_INTERNAL_SECRET,
    };
    expect(assertDeployedProfileEnv(env)).toEqual({
      workerUrl: env.WORKER_URL,
      backendUrl: env.E2E_BACKEND_URL,
      fakeLlmUrl: env.FAKE_LLM_URL,
      authFile: undefined,
      fakeLlmAdminToken: ENV_ADMIN_TOKEN,
      e2eInternalApiSecret: ENV_INTERNAL_SECRET,
      auth: { token: envToken, identity: { userId: USER_ID, email: undefined } },
    });
  });

  it('prefers E2E_USER_TOKEN over the auth-file token and derives the env identity', () => {
    const envUserId = 'usr_env_owner';
    const envToken = jwt.sign(
      { env: 'test', kiloUserId: envUserId, apiTokenPepper: PEPPER, version: 3 },
      SECRET
    );
    const { env, token: fileToken } = deployedEnv({ overrides: { E2E_USER_TOKEN: envToken } });

    const resolved = assertDeployedProfileEnv(env);

    expect(resolved.auth).toEqual({
      token: envToken,
      identity: { userId: envUserId, email: undefined },
    });
    expect(resolved.auth.token).not.toBe(fileToken);
    expect(resolved.authFile).toBeUndefined();
  });

  it('treats an empty E2E_USER_TOKEN as unset and falls back to the auth file', () => {
    const { env, token } = deployedEnv({ overrides: { E2E_USER_TOKEN: '' } });
    const resolved = assertDeployedProfileEnv(env);
    expect(resolved.auth).toEqual({ token, identity: { userId: USER_ID, email: EMAIL } });
    expect(resolved.authFile).toBe(env.E2E_AUTH_FILE);
  });

  it('refuses a policy-bearing E2E_USER_TOKEN', () => {
    const { env } = deployedEnv({
      overrides: { E2E_USER_TOKEN: ordinaryToken({ tokenPurpose: 'runtime' }) },
    });
    expect(() => assertDeployedProfileEnv(env)).toThrow(/tokenPurpose/);
  });

  it('refuses a whitespace-padded E2E_USER_TOKEN instead of trimming it', () => {
    const { env } = deployedEnv({ overrides: { E2E_USER_TOKEN: ` ${ordinaryToken()} ` } });
    expect(() => assertDeployedProfileEnv(env)).toThrow(/bare three-segment JWT/i);
  });

  it('does not read the auth file when both env tokens are present', () => {
    const { env } = deployedEnv({
      overrides: {
        E2E_USER_TOKEN: ordinaryToken(),
        E2E_AUTH_FILE: '/nonexistent/deployed-auth.json',
      },
    });
    const resolved = assertDeployedProfileEnv(env);
    expect(resolved.authFile).toBeUndefined();
  });

  it('resolves the file admin token when E2E_USER_TOKEN supplies the user token', () => {
    const { env } = deployedEnv({
      fileFields: { fakeLlmAdminToken: 'file-admin-token' },
      overrides: { E2E_USER_TOKEN: ordinaryToken(), FAKE_LLM_ADMIN_TOKEN: undefined },
    });
    const resolved = assertDeployedProfileEnv(env);
    expect(resolved.fakeLlmAdminToken).toBe('file-admin-token');
    expect(resolved.authFile).toBe(env.E2E_AUTH_FILE);
  });

  it('selects the file admin token exactly once when FAKE_LLM_ADMIN_TOKEN is empty', () => {
    const { env, authFile } = deployedEnv({
      fileFields: { fakeLlmAdminToken: 'file-admin-token' },
      overrides: { E2E_USER_TOKEN: ordinaryToken(), FAKE_LLM_ADMIN_TOKEN: '' },
    });
    fsMocks.readFileSync.mockClear();

    const resolved = assertDeployedProfileEnv(env);

    expect(resolved.fakeLlmAdminToken).toBe('file-admin-token');
    expect(fsMocks.readFileSync.mock.calls.filter(([path]) => path === authFile)).toHaveLength(1);
  });

  it('names both E2E_USER_TOKEN and E2E_AUTH_FILE when neither supplies a user token', () => {
    const { env } = deployedEnv({
      overrides: { E2E_USER_TOKEN: undefined, E2E_AUTH_FILE: undefined },
    });
    let thrown: unknown;
    try {
      assertDeployedProfileEnv(env);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = String(thrown);
    expect(message).toMatch(/E2E_USER_TOKEN/);
    expect(message).toMatch(/E2E_AUTH_FILE/);
  });
});

describe('bootstrapDeployedProfile', () => {
  const EMAIL = 'deployed@example.test';
  const FILE_ADMIN_TOKEN = 'file-sourced-admin-token';
  const FILE_INTERNAL_SECRET = 'file-sourced-internal-secret-0123456789';
  const KEYS = [
    'WORKER_URL',
    'E2E_BACKEND_URL',
    'FAKE_LLM_URL',
    'E2E_AUTH_FILE',
    'E2E_USER_TOKEN',
    'FAKE_LLM_ADMIN_TOKEN',
    'E2E_INTERNAL_API_SECRET',
  ] as const;

  it('publishes the auth-file secrets so the control request and the surface use them, never the development defaults', async () => {
    const saved = new Map<string, string | undefined>();
    for (const key of KEYS) saved.set(key, process.env[key]);

    const fakeLlmUrl = 'https://fake.example.test';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ chatCompletions: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const authFile = writeAuthFile({
        token: ordinaryToken(),
        userId: USER_ID,
        email: EMAIL,
        fakeLlmAdminToken: FILE_ADMIN_TOKEN,
        e2eInternalApiSecret: FILE_INTERNAL_SECRET,
      });
      process.env.WORKER_URL = 'https://worker.example.test';
      process.env.E2E_BACKEND_URL = 'https://api.kilo.ai';
      process.env.FAKE_LLM_URL = fakeLlmUrl;
      process.env.E2E_AUTH_FILE = authFile;
      delete process.env.E2E_USER_TOKEN;
      delete process.env.FAKE_LLM_ADMIN_TOKEN;
      delete process.env.E2E_INTERNAL_API_SECRET;

      const resolved = bootstrapDeployedProfile();
      expect(resolved.fakeLlmAdminToken).toBe(FILE_ADMIN_TOKEN);
      expect(process.env.FAKE_LLM_ADMIN_TOKEN).toBe(FILE_ADMIN_TOKEN);
      expect(resolved.e2eInternalApiSecret).toBe(FILE_INTERNAL_SECRET);
      expect(process.env.E2E_INTERNAL_API_SECRET).toBe(FILE_INTERNAL_SECRET);

      await fetchFakeRequests(fakeLlmUrl);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toBe(`${fakeLlmUrl}/test/requests`);
      const headers = new Headers(init.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${FILE_ADMIN_TOKEN}`);
      expect(headers.get('Authorization')).not.toBe(`Bearer ${LOCAL_FAKE_LLM_ADMIN_TOKEN}`);
    } finally {
      for (const key of KEYS) {
        const original = saved.get(key);
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }
    }
  });
});

describe('fetchStreamTicket', () => {
  const input = {
    backendUrl: 'https://api.kilo.ai/',
    token: 'ordinary-token',
    sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
  };

  it('POSTs the bearer request and returns the ticket', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ticket: 'fresh-ticket' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchStreamTicket(input)).resolves.toBe('fresh-ticket');

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('https://api.kilo.ai/api/cloud-agent-next/sessions/stream-ticket');
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer ordinary-token',
    });
    expect(init.body).toBe(
      JSON.stringify({ cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111' })
    );
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('nope', { status: 403, statusText: 'Forbidden' }))
    );
    await expect(fetchStreamTicket(input)).rejects.toThrow(/403/);
  });

  it('throws when the response has no ticket', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ expiresAt: 'soon' }), { status: 200 }))
    );
    await expect(fetchStreamTicket(input)).rejects.toThrow(/ticket/);
  });

  it('fails as a timeout when the request stalls before the headers arrive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          })
      )
    );

    const error = (await fetchStreamTicket({ ...input, timeoutMs: 5 }).catch(e => e)) as {
      name?: string;
    };
    expect(error.name).toBe('TimeoutError');
  });

  it('reports a timeout, not invalid JSON, when the body stalls past the bound', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        const body = new ReadableStream({
          start(controller) {
            signal?.addEventListener('abort', () => controller.error(signal?.reason));
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      })
    );

    const error = (await fetchStreamTicket({ ...input, timeoutMs: 5 }).catch(e => e)) as Error;

    expect(error.message).toMatch(/timed out after 5ms/);
    expect(error.message).not.toContain('not valid JSON');
  });

  it('returns the ticket when a valid response arrives before the bound', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ticket: 'fresh-ticket' }), { status: 200 })
        )
    );

    await expect(fetchStreamTicket({ ...input, timeoutMs: 1_000 })).resolves.toBe('fresh-ticket');
  });
});
