import {
  ai_gateway_config,
  device_sessions,
  kilocode_users,
  organization_group_memberships,
  organization_group_policy_settings,
  organization_groups,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { KILO_TOKEN_VERSION } from '@kilocode/worker-utils/kilo-token';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { ORGANIZATION_ID_HEADER } from '@kilocode/web-shared/lib/constants';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  generateApiToken,
  generateInternalServiceToken,
  generateOrganizationApiToken,
} from '@kilocode/web-shared/lib/tokens';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { and, eq, inArray, sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getServerSession } from 'next-auth';
import { NextRequest } from 'next/server';
import { GET } from './route';

jest.mock('next-auth', () => ({ ...jest.requireActual('next-auth'), getServerSession: jest.fn() }));

let user: User;
let organizationId: string;
const userIds: string[] = [];
const organizationIds: string[] = [];
let originalGatewayConfig: Record<string, unknown> | null | undefined;

async function createUser(overrides?: Partial<User>): Promise<User> {
  const account = await insertTestUser({
    id: `oauth/${crypto.randomUUID()}`,
    api_token_pepper: crypto.randomUUID(),
    ...overrides,
  });
  userIds.push(account.id);
  return account;
}

async function createOrganization(parentId?: string): Promise<string> {
  const [organization] = await db
    .insert(organizations)
    .values({
      name: 'Permission policy route',
      plan: 'enterprise',
      parent_organization_id: parentId,
    })
    .returning({ id: organizations.id });
  organizationIds.push(organization.id);
  return organization.id;
}

async function addMember(account: User, id: string, role: 'member' | 'owner' = 'member') {
  await db.insert(organization_memberships).values({
    organization_id: id,
    kilo_user_id: account.id,
    role,
  });
}

async function writeGatewayConfig(config: Record<string, unknown>) {
  await db
    .insert(ai_gateway_config)
    .values({ id: 1, config })
    .onConflictDoUpdate({ target: ai_gateway_config.id, set: { config } });
}

async function setPermissionPolicyFlag(allowlist: unknown) {
  if (originalGatewayConfig === undefined) {
    const existing = await db.query.ai_gateway_config.findFirst({
      where: eq(ai_gateway_config.id, 1),
      columns: { config: true },
    });
    originalGatewayConfig = existing?.config ?? null;
  }
  await writeGatewayConfig({ organization_features: { org_permission_policy: allowlist } });
}

beforeEach(async () => {
  user = await createUser();
  organizationId = await createOrganization();
  await addMember(user, organizationId);
});

afterEach(async () => {
  if (originalGatewayConfig === null) {
    await db.delete(ai_gateway_config).where(eq(ai_gateway_config.id, 1));
  } else if (originalGatewayConfig !== undefined) {
    await writeGatewayConfig(originalGatewayConfig);
  }
  originalGatewayConfig = undefined;

  await db
    .delete(organization_memberships)
    .where(inArray(organization_memberships.organization_id, organizationIds));
  for (const id of organizationIds.reverse()) {
    await db.delete(organizations).where(eq(organizations.id, id));
  }
  await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
  organizationIds.length = 0;
  userIds.length = 0;
  jest.mocked(getServerSession).mockReset();
});

function request(
  options: { id?: string; token?: string; headers?: HeadersInit; tag?: string } = {}
) {
  const { id = organizationId, token, tag } = options;
  const headers = new Headers(options.headers);
  if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
  if (tag !== undefined) headers.set('If-None-Match', tag);
  return GET(
    new NextRequest(`https://example.test/api/organizations/${id}/permission-policy`, { headers }),
    {
      params: Promise.resolve({ id }),
    }
  );
}

function requireTag(response: Response): string {
  const tag = response.headers.get('ETag');
  if (!tag) throw new Error(`Missing ETag on ${response.status} response`);
  return tag;
}

function expectDenied(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get('ETag')).toBeNull();
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
}

function signClaims(extra: Record<string, unknown>, secret = NEXTAUTH_SECRET): string {
  return jwt.sign(
    {
      version: KILO_TOKEN_VERSION,
      kiloUserId: user.id,
      apiTokenPepper: user.api_token_pepper,
      env: process.env.NODE_ENV,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...extra,
    },
    secret,
    { algorithm: 'HS256' }
  );
}

test('returns a disabled envelope and accepts only the exact opaque tag for the member', async () => {
  const token = generateApiToken(user);
  const initial = await request({ token });
  expect(initial.status).toBe(200);
  expect(initial.headers.get('Cache-Control')).toBe('private, no-store');
  const tag = requireTag(initial);
  expect(tag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  const body = await initial.json();
  expect(body).toEqual({
    schema_version: 1,
    organization_id: organizationId,
    managed: false,
    revision: 0,
    max_age_seconds: expect.any(Number),
    policy: {},
  });
  expect(Number.isInteger(body.max_age_seconds)).toBe(true);
  expect(body.max_age_seconds).toBeGreaterThan(0);
  expect(body.max_age_seconds).toBeLessThanOrEqual(300);

  const conditional = await request({ token, tag });
  expect(conditional.status).toBe(304);
  expect(conditional.headers.get('ETag')).toBe(tag);
  expect(conditional.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await conditional.text()).toBe('');

  for (const rejected of ['*', '0', '"0"', tag.slice(1, -1), `W/${tag}`, `${tag}, "another-tag"`]) {
    const response = await request({ token, tag: rejected });
    expect(response.status).toBe(200);
    expect(requireTag(response)).toBe(tag);
    expect(await response.json()).toEqual(body);
  }
});

test('does not match a validator from another account with an identical body or another organization', async () => {
  const otherAccount = await createUser();
  const otherOrganization = await createOrganization();
  await addMember(otherAccount, organizationId);
  await addMember(user, otherOrganization);

  const token = generateApiToken(user);
  const original = await request({ token });
  const tag = requireTag(original);
  const otherUserResponse = await request({ token: generateApiToken(otherAccount), tag });
  expect(otherUserResponse.status).toBe(200);
  expect(await otherUserResponse.text()).toBe(await original.text());
  expect(requireTag(otherUserResponse)).not.toBe(tag);

  const otherOrgResponse = await request({ id: otherOrganization, token, tag });
  expect(otherOrgResponse.status).toBe(200);
  expect(requireTag(otherOrgResponse)).not.toBe(tag);
  expect(await otherOrgResponse.json()).toMatchObject({ organization_id: otherOrganization });
});

test('honors legacy and modern account organization bindings independently of mutable headers', async () => {
  const otherOrganization = await createOrganization();
  await addMember(user, otherOrganization);
  const tag = requireTag(await request({ token: generateApiToken(user) }));
  const humanClaims = { aud: 'kilo-api', tokenPurpose: 'human-api', credentialExchange: false };

  for (const token of [
    generateOrganizationApiToken(user, organizationId, 'member').token,
    signClaims({ ...humanClaims, organizationId }),
    signClaims(humanClaims),
  ]) {
    const response = await request({
      token,
      tag,
      headers: { [ORGANIZATION_ID_HEADER]: otherOrganization },
    });
    expect(response.status).toBe(304);
  }

  const wrongOrgToken = generateOrganizationApiToken(user, otherOrganization, 'member').token;
  await setPermissionPolicyFlag('not-an-allowlist');
  expectDenied(
    await request({
      token: wrongOrgToken,
      tag,
      headers: { [ORGANIZATION_ID_HEADER]: organizationId },
    }),
    403
  );
});

test('refuses browser sessions, internal, delegated, and otherwise invalid credentials before matching a tag', async () => {
  const tag = requireTag(await request({ token: generateApiToken(user) }));
  const headers = { cookie: 'next-auth.session-token=session' };
  jest.mocked(getServerSession).mockResolvedValue({
    kiloUserId: user.id,
    webSessionPepper: user.web_session_pepper,
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    isNewUser: false,
    isAdmin: false,
    user: { id: user.id, name: user.google_user_name, email: user.google_user_email },
  });

  expectDenied(await request({ headers, tag }), 401);
  expectDenied(
    await request({ headers: { ...headers, Authorization: 'Basic invalid' }, tag }),
    401
  );
  for (const token of [
    'anonymous',
    generateInternalServiceToken(user.id),
    generateApiToken(user, { internalApiUse: true }),
    generateApiToken(user, { tokenSource: 'cloud-agent' }),
    generateApiToken(user, { botId: 'bot' }),
    signClaims({ aud: 'kilo-api', tokenPurpose: 'internal-service', credentialExchange: false }),
    signClaims({ aud: 'kilo-api', tokenPurpose: 'delegated-workload', credentialExchange: false }),
    signClaims({ aud: 'kilo-api', tokenPurpose: 'device-access', credentialExchange: false }),
    signClaims({ aud: 'kilo-api', tokenPurpose: 'human-api', credentialExchange: true }),
    signClaims({
      aud: 'kilo-api',
      tokenPurpose: 'human-api',
      credentialExchange: false,
      runtimeAdmission: {
        source: 'user',
        authorizationUserId: user.id,
        authorizationPepper: user.api_token_pepper,
      },
    }),
    signClaims({ aud: 'kilo-gateway' }),
    signClaims({ futureRestriction: true }),
    signClaims({ env: 'another-environment' }),
    signClaims({ iat: 1, exp: 2 }),
    signClaims({}, 'wrong-signing-secret'),
  ]) {
    expectDenied(await request({ token, headers, tag }), 401);
  }
  expect(getServerSession).not.toHaveBeenCalled();
});

test('does not grant policy access through inherited membership, platform admin, or bot identities', async () => {
  const child = await createOrganization(organizationId);
  await db
    .update(organization_memberships)
    .set({ role: 'owner' })
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, user.id)
      )
    );
  const admin = await createUser({ is_admin: true });
  const bot = await createUser({ is_bot: true });
  await addMember(bot, organizationId);

  expectDenied(await request({ id: child, token: generateApiToken(user) }), 403);
  expectDenied(await request({ token: generateApiToken(admin) }), 403);
  expectDenied(await request({ token: generateApiToken(bot) }), 401);
  expectDenied(await request({ id: crypto.randomUUID(), token: generateApiToken(user) }), 404);
  expectDenied(await request({ id: 'not-a-uuid', token: generateApiToken(user) }), 400);
});

test('conditional requests fail immediately after membership revocation, account blocking, or token rotation', async () => {
  const token = generateApiToken(user);
  const tag = requireTag(await request({ token }));
  await db
    .delete(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, user.id)
      )
    );
  expectDenied(await request({ token, tag }), 403);

  await addMember(user, organizationId);
  await db
    .update(kilocode_users)
    .set({ blocked_reason: 'Blocked test account' })
    .where(eq(kilocode_users.id, user.id));
  expectDenied(await request({ token, tag }), 403);

  await db
    .update(kilocode_users)
    .set({ blocked_reason: null, api_token_pepper: crypto.randomUUID() })
    .where(eq(kilocode_users.id, user.id));
  expectDenied(await request({ token, tag }), 401);
});

test('an active signed native device credential loses conditional access immediately upon revocation', async () => {
  const [session] = await db
    .insert(device_sessions)
    .values({ kilo_user_id: user.id, user_agent: 'policy-native-test' })
    .returning({ id: device_sessions.id });
  const token = signClaims({
    aud: 'kilo-api',
    tokenPurpose: 'device-access',
    credentialExchange: false,
    deviceSessionId: session.id,
  });
  const tag = requireTag(await request({ token }));
  expect((await request({ token, tag })).status).toBe(304);
  await db
    .update(device_sessions)
    .set({ revoked_at: new Date().toISOString() })
    .where(eq(device_sessions.id, session.id));
  expectDenied(await request({ token, tag }), 401);
});

test('distinguishes enabled-empty and disabled at the same revision', async () => {
  const token = generateApiToken(user);
  await setPermissionPolicyFlag([organizationId]);
  const enabled = await request({ token });
  expect(enabled.status).toBe(200);
  expect(await enabled.json()).toMatchObject({ managed: true, revision: 0, policy: {} });
  const tag = requireTag(enabled);

  await setPermissionPolicyFlag([]);
  const disabled = await request({ token, tag });
  expect(disabled.status).toBe(200);
  expect(await disabled.json()).toMatchObject({ managed: false, revision: 0, policy: {} });
  expect(requireTag(disabled)).not.toBe(tag);
});

test('serves only anonymous applicable policy layers and invalidates a tag after a same-revision policy change', async () => {
  await setPermissionPolicyFlag([organizationId]);
  const token = generateApiToken(user);
  const memberLayer = { schema_version: 1, tools: { websearch: 'deny' } } as const;
  const otherLayer = { schema_version: 1, tools: { external_directory: 'ask' } } as const;
  const groupId = crypto.randomUUID();
  await db.insert(organization_groups).values([
    {
      id: groupId,
      organization_id: organizationId,
      name: 'Private group name',
      policies: [{ type: 'agent_permissions', data: memberLayer }],
    },
    {
      organization_id: organizationId,
      name: 'Unassigned group',
      policies: [{ type: 'agent_permissions', data: otherLayer }],
    },
  ]);
  const original = await request({ token });
  const before = await original.json();
  expect(before.policy).toEqual({});

  await db
    .insert(organization_group_memberships)
    .values({ organization_id: organizationId, group_id: groupId, kilo_user_id: user.id });
  const updated = await request({ token, tag: requireTag(original) });
  expect(updated.status).toBe(200);
  expect(requireTag(updated)).not.toBe(requireTag(original));
  expect(await updated.json()).toEqual({
    ...before,
    policy: { agent_permissions: { layers: [memberLayer] } },
  });
});

test('fails closed instead of renewing an authorized tag when stored policy or feature config is invalid', async () => {
  await setPermissionPolicyFlag([organizationId]);
  const token = generateApiToken(user);
  const tag = requireTag(await request({ token }));
  const futurePolicy = [{ type: 'agent_permissions', data: { schema_version: 2, tools: {} } }];
  await db.insert(organization_group_policy_settings).values({
    organization_id: organizationId,
    default_policies: sql`${JSON.stringify(futurePolicy)}::jsonb`,
  });
  const invalidPolicy = await request({ token, tag });
  expectDenied(invalidPolicy, 500);
  expect(await invalidPolicy.json()).toEqual({
    error: 'Organization permission policy is unavailable',
  });

  await db
    .delete(organization_group_policy_settings)
    .where(eq(organization_group_policy_settings.organization_id, organizationId));
  await setPermissionPolicyFlag('not-an-allowlist');
  expectDenied(await request({ token, tag }), 500);
});
