import {
  ai_gateway_config,
  kilocode_users,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  createNamedOrganizationPolicy,
  setNamedOrganizationPolicyLink,
} from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/named-policy.server';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { GET } from './route';

let owner: User;
let member: User;
let organizationId: string;
const userIds: string[] = [];
const organizationIds: string[] = [];
let originalGatewayConfig: Record<string, unknown> | null | undefined;
const originalWriteSwitch = process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED;

async function createUser(): Promise<User> {
  const account = await insertTestUser({
    id: `oauth/${crypto.randomUUID()}`,
    api_token_pepper: crypto.randomUUID(),
  });
  userIds.push(account.id);
  return account;
}

async function createOrganization(): Promise<string> {
  const [organization] = await db
    .insert(organizations)
    .values({ name: 'Permission policy route', plan: 'enterprise' })
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

async function enable() {
  const existing = await db.query.ai_gateway_config.findFirst({
    where: eq(ai_gateway_config.id, 1),
    columns: { config: true },
  });
  if (originalGatewayConfig === undefined) originalGatewayConfig = existing?.config ?? null;
  const config = { organization_features: { org_permission_policy: [organizationId] } };
  await db
    .insert(ai_gateway_config)
    .values({ id: 1, config })
    .onConflictDoUpdate({ target: ai_gateway_config.id, set: { config } });
}

function adminAccess() {
  return { organizationId, actor: { id: owner.id, isBrowserSession: true } };
}

async function seed(
  kind: 'agent_permissions' | 'client_configuration',
  name: string,
  document: unknown
) {
  const { result } = await createNamedOrganizationPolicy(adminAccess(), { kind, name, document });
  return result.id;
}

async function link(
  scope: { type: 'default' } | { type: 'group'; groupId: string },
  kind: 'agent_permissions' | 'client_configuration',
  policyId: string | null
) {
  await setNamedOrganizationPolicyLink(adminAccess(), { scope, kind, policyId });
}

beforeEach(async () => {
  owner = await createUser();
  member = await createUser();
  organizationId = await createOrganization();
  await addMember(owner, organizationId, 'owner');
  await addMember(member, organizationId);
  process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = 'true';
});

afterEach(async () => {
  if (originalWriteSwitch === undefined) delete process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED;
  else process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = originalWriteSwitch;
  if (originalGatewayConfig === null) {
    await db.delete(ai_gateway_config).where(eq(ai_gateway_config.id, 1));
  } else if (originalGatewayConfig !== undefined) {
    await db
      .insert(ai_gateway_config)
      .values({ id: 1, config: originalGatewayConfig })
      .onConflictDoUpdate({ target: ai_gateway_config.id, set: { config: originalGatewayConfig } });
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
});

function request(
  options: { token?: string; tag?: string; query?: string; id?: string; headers?: HeadersInit } = {}
) {
  const { id = organizationId, token, tag, query = '' } = options;
  const headers = new Headers(options.headers);
  if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
  if (tag !== undefined) headers.set('If-None-Match', tag);
  return GET(
    new NextRequest(`https://example.test/api/organizations/${id}/policy/permission${query}`, {
      headers,
    }),
    { params: Promise.resolve({ id }) }
  );
}

function requireTag(response: Response): string {
  const tag = response.headers.get('ETag');
  if (!tag) throw new Error(`Missing ETag on ${response.status} response`);
  return tag;
}

test('returns a disabled envelope and matches only the exact opaque tag', async () => {
  const token = generateApiToken(member);
  const initial = await request({ token });
  expect(initial.status).toBe(200);
  expect(initial.headers.get('Cache-Control')).toBe('private, no-store');
  const tag = requireTag(initial);
  expect(tag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  expect(await initial.json()).toEqual({
    schema_version: 1,
    organization_id: organizationId,
    managed: false,
    revision: 0,
    max_age_seconds: 300,
    policy: {},
  });

  const conditional = await request({ token, tag });
  expect(conditional.status).toBe(304);
  expect(await conditional.text()).toBe('');
  for (const rejected of ['*', '0', tag.slice(1, -1), `W/${tag}`, `${tag}, "x"`]) {
    expect((await request({ token, tag: rejected })).status).toBe(200);
  }
});

test('rejects missing bearer, wrong organization binding, and non-members', async () => {
  expect((await request()).status).toBe(401);
  const outsider = await createUser();
  expect((await request({ token: generateApiToken(outsider) })).status).toBe(403);
  const bound = generateApiToken(member, { organizationId: crypto.randomUUID() });
  expect((await request({ token: bound })).status).toBe(403);
});

test('selects generic and matching OS layers from named policies', async () => {
  await enable();
  const agent = await seed('agent_permissions', 'Browser', {
    tools: { browser_open: 'ask' },
    by_os: { windows: { tools: { browser_open: 'deny' } } },
  });
  await link({ type: 'default' }, 'agent_permissions', agent);
  const token = generateApiToken(member);

  const windows = await (await request({ token, query: '?os=windows' })).json();
  expect(windows.policy.agent_permissions.layers).toEqual([
    { schema_version: 1, tools: { browser_open: 'ask' } },
    { schema_version: 1, tools: { browser_open: 'deny' } },
  ]);

  for (const query of ['', '?os=linux', '?os=other']) {
    const generic = await (await request({ token, query })).json();
    expect(generic.policy.agent_permissions.layers).toEqual([
      { schema_version: 1, tools: { browser_open: 'ask' } },
    ]);
  }
});

test('scopes the validator to the execution OS even for identical responses', async () => {
  await enable();
  const config = await seed('client_configuration', 'Privacy', { disable_telemetry: true });
  await link({ type: 'default' }, 'client_configuration', config);
  const token = generateApiToken(member);

  const windows = await request({ token, query: '?os=windows' });
  const linux = await request({ token, query: '?os=linux' });
  expect(await windows.text()).toBe(await linux.text());
  const windowsTag = requireTag(windows);
  expect(windowsTag).not.toBe(requireTag(linux));
  expect((await request({ token, query: '?os=linux', tag: windowsTag })).status).toBe(200);
  expect((await request({ token, query: '?os=windows', tag: windowsTag })).status).toBe(304);
});

test('rejects malformed, unknown, duplicate, and unexpected OS selectors with no ETag', async () => {
  const token = generateApiToken(member);
  for (const query of [
    '?os=',
    '?os=Windows',
    '?os=plan9',
    '?os=linux&os=windows',
    '?os=linux&x=1',
    '?os[]=linux',
  ]) {
    const response = await request({ token, query });
    expect(response.status).toBe(400);
    expect(response.headers.get('ETag')).toBeNull();
  }
});
