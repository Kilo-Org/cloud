// Every route module loads its own dependency graph. Mock the database, the
// provider clients, and the service helpers so a route call only exercises the
// wrapped handler and the timing line it emits.
jest.mock('@/lib/drizzle', () => ({
  db: {},
  readDb: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        limit: jest.fn(async () => [{ ios: '1.0.0', android: '1.0.0' }]),
      })),
    })),
  },
}));
jest.mock('@/lib/auth/native-admission', () => ({
  ...jest.requireActual('@/lib/auth/native-admission'),
  issueAdmissionChallenge: jest.fn(),
}));
jest.mock('@/lib/user/server', () => ({
  getUserFromBearerForCredentialExchange: jest.fn(),
  getUserFromSessionForCredentialIssuance: jest.fn(),
}));
jest.mock('@/lib/auth/magic-link-tokens', () => ({
  createSignInCode: jest.fn(),
  deleteSignInCode: jest.fn(),
  reserveSignInCode: jest.fn(),
  commitSignInCode: jest.fn(),
  releaseSignInCode: jest.fn(),
  consumeSignInCode: jest.fn(),
}));
jest.mock('@/lib/email', () => ({ sendSignInCodeEmail: jest.fn() }));
jest.mock('@/lib/auth/email-signin-eligibility', () => ({
  checkEmailSignInEligibility: jest.fn(),
  checkDomainSignInEligibility: jest.fn(),
}));
jest.mock('@/lib/auth/device-sessions', () => ({
  rotateRefreshToken: jest.fn(),
  createDeviceSession: jest.fn(),
  issueSessionCredentials: jest.fn(),
  createDeviceSessionWithAttestedKey: jest.fn(),
}));
jest.mock('@/lib/user', () => ({
  createOrUpdateUser: jest.fn(),
  findUserById: jest.fn(),
  findUserByNormalizedEmail: jest.fn(),
  findUserIdByAuthProvider: jest.fn(),
}));
jest.mock('@/lib/tokens', () => ({
  generateApiToken: jest.fn(),
  TOKEN_EXPIRY: { oneHour: 3600 },
}));
jest.mock('@/lib/organizations/verified-domain-membership', () => ({
  ensureVerifiedDomainOrganizationMembership: jest.fn(),
}));
jest.mock('@/lib/auth/native-id-tokens', () => ({
  ...jest.requireActual('@/lib/auth/native-id-tokens'),
  verifyNativeAppleIdToken: jest.fn(),
  verifyNativeGoogleIdToken: jest.fn(),
  exchangeNativeGoogleAuthCode: jest.fn(),
}));
jest.mock('@/lib/config.server', () => ({ GOOGLE_CLIENT_ID: 'web-client-id' }));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/lib/posthog', () => ({
  __esModule: true,
  default: jest.fn(() => ({ capture: jest.fn() })),
}));

import { GET as minVersionGet } from '@/app/api/app/min-version/route';
import { POST as admissionChallengePost } from '@/app/api/auth/native/admission-challenge/route';
import { POST as exchangePost } from '@/app/api/auth/native/exchange/route';
import { POST as otpPost } from '@/app/api/auth/native/otp/route';
import { POST as refreshPost } from '@/app/api/auth/native/refresh/route';
import { POST as tokenPost } from '@/app/api/auth/native/token/route';

import { issueAdmissionChallenge } from '@/lib/auth/native-admission';
import { rotateRefreshToken } from '@/lib/auth/device-sessions';
import { createSignInCode } from '@/lib/auth/magic-link-tokens';
import { sendSignInCodeEmail } from '@/lib/email';
import { checkEmailSignInEligibility } from '@/lib/auth/email-signin-eligibility';

const mockIssueAdmissionChallenge = jest.mocked(issueAdmissionChallenge);
const mockRotateRefreshToken = jest.mocked(rotateRefreshToken);
const mockCreateSignInCode = jest.mocked(createSignInCode);
const mockSendSignInCodeEmail = jest.mocked(sendSignInCodeEmail);
const mockCheckEmailSignInEligibility = jest.mocked(checkEmailSignInEligibility);

const MOBILE_HEADERS = {
  'x-kilo-client': 'mobile',
  'x-kilo-app-platform': 'ios',
  'x-kilo-app-version': '1.0.11',
  'x-kilo-request-id': 'r-1',
};

let logSpy: jest.SpiedFunction<typeof console.log>;

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Parses only the structured `api_timing` lines the REST wrapper emits. */
function timingLines(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const call of logSpy.mock.calls) {
    try {
      const parsed = JSON.parse(String(call[0])) as Record<string, unknown>;
      if (parsed?.type === 'api_timing') lines.push(parsed);
    } catch {
      // Non-JSON output on the console is not a timing line.
    }
  }
  return lines;
}

/**
 * Calls one wrapped route the way Next does, under the console spy, and asserts
 * the single `api_timing` line. A rejecting handler is caught so the assertion
 * still runs (the wrapper emits its line in `finally`).
 */
async function callRoute({
  method,
  route,
  handler,
  body,
}: {
  method: 'GET' | 'POST';
  route: string;
  handler: (request: Request) => Promise<Response> | Response;
  body?: unknown;
}): Promise<{ response?: Response; rejected: boolean }> {
  logSpy.mockClear();
  const headers: Record<string, string> = { ...MOBILE_HEADERS };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const request = new Request(`https://x${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let response: Response | undefined;
  let rejected = false;
  try {
    response = await handler(request);
  } catch {
    rejected = true;
  }

  const lines = timingLines();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    type: 'api_timing',
    surface: 'rest',
    route,
    method,
    client: 'mobile',
    platform: 'ios',
    version: '1.0.11',
    requestId: 'r-1',
  });
  expect(lines[0].durationMs).toEqual(expect.any(Number));

  return { response, rejected };
}

describe('REST timing on the native auth and min-version routes', () => {
  test('GET /api/app/min-version emits one api_timing line', async () => {
    const { response, rejected } = await callRoute({
      method: 'GET',
      route: '/api/app/min-version',
      handler: minVersionGet,
    });

    expect(rejected).toBe(false);
    expect(response?.status).toBe(200);
  });

  test('POST /api/auth/native/admission-challenge emits one api_timing line', async () => {
    mockIssueAdmissionChallenge.mockResolvedValue({ challenge: 'challenge-1', expiresIn: 120 });

    const { response, rejected } = await callRoute({
      method: 'POST',
      route: '/api/auth/native/admission-challenge',
      handler: admissionChallengePost,
      body: { platform: 'ios' },
    });

    expect(rejected).toBe(false);
    expect(response?.status).toBe(200);
  });

  test('POST /api/auth/native/admission-challenge still logs when the handler rejects', async () => {
    mockIssueAdmissionChallenge.mockRejectedValue(new Error('admission provider exploded'));

    const { rejected } = await callRoute({
      method: 'POST',
      route: '/api/auth/native/admission-challenge',
      handler: admissionChallengePost,
      body: { platform: 'android' },
    });

    expect(rejected).toBe(true);
  });

  test('POST /api/auth/native/exchange emits one api_timing line', async () => {
    const { response, rejected } = await callRoute({
      method: 'POST',
      route: '/api/auth/native/exchange',
      handler: exchangePost,
    });

    expect(rejected).toBe(false);
    expect(response?.status).toBe(403);
  });

  test('POST /api/auth/native/otp emits one api_timing line', async () => {
    mockCheckEmailSignInEligibility.mockResolvedValue({ ok: true });
    mockCreateSignInCode.mockResolvedValue({ code: '123456', challengeId: 'challenge-1' });
    mockSendSignInCodeEmail.mockResolvedValue({ sent: true });

    const { response, rejected } = await callRoute({
      method: 'POST',
      route: '/api/auth/native/otp',
      handler: otpPost,
      body: { email: 'user@example.com' },
    });

    expect(rejected).toBe(false);
    expect(response?.status).toBe(200);
  });

  test('POST /api/auth/native/refresh emits one api_timing line', async () => {
    mockRotateRefreshToken.mockResolvedValue({
      ok: true,
      token: 'access',
      refreshToken: 'refresh',
      expiresIn: 3600,
    });

    const { response, rejected } = await callRoute({
      method: 'POST',
      route: '/api/auth/native/refresh',
      handler: refreshPost,
      body: { refreshToken: 'valid-refresh' },
    });

    expect(rejected).toBe(false);
    expect(response?.status).toBe(200);
  });

  test('POST /api/auth/native/token emits one api_timing line', async () => {
    const { response, rejected } = await callRoute({
      method: 'POST',
      route: '/api/auth/native/token',
      handler: tokenPost,
      body: {},
    });

    expect(rejected).toBe(false);
    expect(response?.status).toBe(400);
  });
});
