import { NextRequest } from 'next/server';
import { checkRateLimit } from '@vercel/firewall';
import type { Organization, User } from '@kilocode/db/schema';
import {
  addUserToOrganization,
  createOrganization,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { __test__ as rateLimitTest } from '@/lib/auth/firewall-rate-limit';
import { createPagesAuthCode } from '@/lib/pages-auth/pages-auth-code';
import { createPagesMemberSearchProof } from '@/lib/pages-auth/pages-member-search-proof';
import { POST } from './route';

jest.mock('@vercel/firewall');
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/config.server'),
  PAGES_AUTH_SECRET: 'p'.repeat(40),
  PAGES_DEV_AUTH_SECRET: 'd'.repeat(40),
}));

const mockCheckRateLimit = jest.mocked(checkRateLimit);

const PAGES = 'pages';
const PAGES_DEV = 'pages-dev';
const SECRET = 'p'.repeat(40);
const DEV_SECRET = 'd'.repeat(40);

function call(body: unknown, secret: string | null = SECRET) {
  return POST(
    new NextRequest('http://localhost:3000/api/pages-auth/organization-members', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        ...(secret === null ? {} : { Authorization: `Bearer ${secret}` }),
      },
    })
  );
}

let organization: Organization;
let searcher: User;
let colleague: User;

function searchBody(overrides: Record<string, unknown> = {}) {
  return {
    audience: PAGES,
    searcher_id: searcher.id,
    organization_id: organization.id,
    proof: createPagesMemberSearchProof({ userId: searcher.id, audience: PAGES }),
    query: 'jes',
    ...overrides,
  };
}

describe('POST /api/pages-auth/organization-members', () => {
  beforeAll(async () => {
    searcher = await insertTestUser({ google_user_name: 'Sam Searcher' });
    organization = await createOrganization(`Org ${crypto.randomUUID()}`, searcher.id);
    colleague = await insertTestUser({
      google_user_name: 'Jessica Alvarez',
      google_user_image_url: 'https://example.com/jessica.png',
    });
    await addUserToOrganization(organization.id, colleague.id, 'member');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimitTest.resetReportThrottle();
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
  });

  test('searches the organization for the person the proof names', async () => {
    const response = await call(searchBody());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      members: [
        { id: colleague.id, name: 'Jessica Alvarez', image_url: 'https://example.com/jessica.png' },
      ],
    });
  });

  test('resolves one member by id, or nobody', async () => {
    const { query: _query, ...rest } = searchBody();

    const found = await call({ ...rest, member_id: colleague.id });
    expect(await found.json()).toEqual({
      members: [
        { id: colleague.id, name: 'Jessica Alvarez', image_url: 'https://example.com/jessica.png' },
      ],
    });

    const outsider = await insertTestUser({ google_user_name: 'Jessie Outside' });
    const missing = await call({ ...rest, member_id: outsider.id });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ members: [] });
  });

  test.each([
    ['no body', 'not json'],
    ['a query and a member id', { member_id: 'someone' }],
    ['a one-character query', { query: ' j ' }],
    ['a 101-character query', { query: 'x'.repeat(101) }],
    ['an organization id that is not a uuid', { organization_id: 'org-1' }],
    ['an extra field', { email: 'x@example.com' }],
  ])('refuses %s with 400', async (_label, overrides) => {
    const response = await call(typeof overrides === 'string' ? overrides : searchBody(overrides));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });

  test.each([
    ['no secret', null, PAGES],
    ['another deployment secret', DEV_SECRET, PAGES],
    ['an unknown audience', SECRET, 'pages-other'],
  ])('refuses %s with 401 before any rate limit', async (_label, secret, audience) => {
    const response = await call(searchBody({ audience }), secret);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_client' });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  test('refuses a proof for another person, another deployment, or another purpose', async () => {
    const proofs = [
      createPagesMemberSearchProof({ userId: colleague.id, audience: PAGES }),
      createPagesMemberSearchProof({ userId: searcher.id, audience: PAGES_DEV }),
      createPagesAuthCode({ userId: searcher.id, audience: PAGES, state: 'A'.repeat(43) }),
    ];

    for (const proof of proofs) {
      const response = await call(searchBody({ proof }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'invalid_proof' });
    }
  });

  test('refuses a searcher with no membership of their own', async () => {
    const kiloAdmin = await insertTestUser({ is_admin: true });

    const response = await call(
      searchBody({
        searcher_id: kiloAdmin.id,
        proof: createPagesMemberSearchProof({ userId: kiloAdmin.id, audience: PAGES }),
      })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'not_a_member' });
  });

  test('counts per searcher on the deployment, then per deployment', async () => {
    await call(searchBody());

    expect(mockCheckRateLimit.mock.calls).toEqual([
      [
        'pages-member-search-searcher',
        expect.objectContaining({ rateLimitKey: `${PAGES}:${searcher.id}` }),
      ],
      ['pages-member-search-deployment', expect.objectContaining({ rateLimitKey: PAGES })],
    ]);
  });

  test('a request the searcher limit refuses never spends the deployment budget', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ rateLimited: true });

    const response = await call(searchBody());

    expect(response.status).toBe(429);
    expect(mockCheckRateLimit.mock.calls.map(([id]) => id)).toEqual([
      'pages-member-search-searcher',
    ]);
  });

  test('answers 429 with Retry-After when either limit is exceeded', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ rateLimited: true });
    const searcherLimited = await call(searchBody());
    expect(searcherLimited.status).toBe(429);
    expect(searcherLimited.headers.get('retry-after')).toBe('60');
    expect(await searcherLimited.json()).toEqual({ error: 'RATE_LIMITED' });

    mockCheckRateLimit
      .mockResolvedValueOnce({ rateLimited: false })
      .mockResolvedValueOnce({ rateLimited: true });
    const deploymentLimited = await call(searchBody());
    expect(deploymentLimited.status).toBe(429);
    expect(deploymentLimited.headers.get('retry-after')).toBe('60');
  });

  test('fails closed with 503 when a firewall rule is missing', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'not-found' });

    const response = await call(searchBody());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'RATE_LIMIT_UNAVAILABLE' });
  });

  test('spends no rate limit on an invalid proof', async () => {
    const response = await call(searchBody({ proof: 'forged.proof' }));

    expect(response.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});
