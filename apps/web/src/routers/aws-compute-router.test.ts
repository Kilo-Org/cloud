import type * as NodeCryptoModule from 'node:crypto';
jest.mock('@kilocode/web-shared/lib/config.server', () => {
  const actual = jest.requireActual('@kilocode/web-shared/lib/config.server');
  const keys = jest
    .requireActual<typeof NodeCryptoModule>('node:crypto')
    .generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  return {
    ...actual,
    AGENT_ENV_VARS_PUBLIC_KEY: Buffer.from(keys.publicKey).toString('base64'),
    INTERNAL_API_SECRET: 'test-internal-api-key',
    awsTestPrivateKey: keys.privateKey,
  };
});
import { decryptKeyedEnvelope } from '@kilocode/encryption';
import { and, eq, or } from 'drizzle-orm';
import {
  byoc_connections,
  organizations,
  organization_memberships,
  type User,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import {
  awsEc2ConfigurationEnvelope,
  awsEc2SetupEnvelope,
  AWS_SETUP_ERRORS,
} from '@kilocode/worker-utils/aws-onboarding';
import { awsStatusFromRow } from '@/lib/byoc/aws-connection';
import { personalAwsComputeRouter, organizationAwsComputeRouter } from './aws-compute-router';

const personalCaller = createCallerFactory(personalAwsComputeRouter);
const orgCaller = createCallerFactory(organizationAwsComputeRouter);
const accountId = '999999999999';
const hash = 'a'.repeat(64);
const roleArn = `arn:aws:iam::${accountId}:role/customer`;
const stackId = `arn:aws:cloudformation:us-east-1:${accountId}:stack/kilo-test/11111111-1111-4111-8111-111111111111`;
const ecsConfiguration = {
  region: 'us-east-1',
  roleArn,
  externalId: 'secret-external-id-'.repeat(4),
  stackId,
  bucket: 'customer-artifacts',
  templateVersion: 1,
  proxyProtocolVersion: 1,
  proxy: {
    generation: crypto.randomUUID(),
    hostname: 'proxy.internal.example.com',
    caFingerprint: hash,
  },
  clusterArn: `arn:aws:ecs:us-east-1:${accountId}:cluster/customer`,
  taskDefinitionArn: `arn:aws:ecs:us-east-1:${accountId}:task-definition/customer:1`,
  capacityProvider: 'customer-managed',
  subnetId: 'subnet-0123456789abcdef0',
  securityGroupId: 'sg-0123456789abcdef0',
  executionRoleArn: `arn:aws:iam::${accountId}:role/execution`,
  runtimeImage: `123456789012.dkr.ecr.us-east-1.amazonaws.com/runtime@sha256:${hash}`,
};
const ec2Configuration = {
  region: 'us-east-1',
  roleArn,
  externalId: ecsConfiguration.externalId,
  stackId,
  bucket: ecsConfiguration.bucket,
  templateVersion: 1,
  subnetId: ecsConfiguration.subnetId,
  securityGroupId: ecsConfiguration.securityGroupId,
  imageId: 'ami-0123456789abcdef0',
  instanceProfileArn: `arn:aws:iam::${accountId}:instance-profile/customer`,
  launchTemplateId: 'lt-0123456789abcdef0',
  launchTemplateVersion: 1,
  installation: crypto.randomUUID(),
};
const ec2Release = {
  format: 1,
  templateVersion: 1,
  template: { bucket: 'kilo-releases', key: `${hash}/template.json`, sha256: hash },
  imageId: ec2Configuration.imageId,
  customerAccounts: [accountId],
};
let wrongEngineReply = false;
let user: User;
let admin: User;
let member: User;
const organizationId = crypto.randomUUID();
let beforeReply: (input: Record<string, unknown>) => Promise<void>;
let remoteFailure: string | undefined;
let requests: Record<string, unknown>[];

beforeAll(async () => {
  user = await insertTestUser({ id: `oauth/aws-test/${crypto.randomUUID()}` });
  admin = await insertTestUser();
  member = await insertTestUser();
  await db.insert(organizations).values({ id: organizationId, name: 'AWS onboarding test' });
  await db.insert(organization_memberships).values([
    { organization_id: organizationId, kilo_user_id: admin.id, role: 'admin' },
    { organization_id: organizationId, kilo_user_id: member.id, role: 'member' },
  ]);
  process.env.CLOUD_AGENT_NEXT_API_URL = 'https://worker.example.com';
});
beforeEach(async () => {
  await db
    .delete(byoc_connections)
    .where(
      and(
        eq(byoc_connections.provider, 'aws-ec2'),
        or(
          eq(byoc_connections.user_id, user.id),
          eq(byoc_connections.organization_id, organizationId)
        )
      )
    );
  wrongEngineReply = false;
  requests = [];
  remoteFailure = undefined;
  beforeReply = async () => {};
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const input = JSON.parse(String(options?.body)) as Record<string, unknown>;
    requests.push(input);
    await beforeReply(input);
    if (remoteFailure) return Response.json({ error: remoteFailure }, { status: 422 });
    if (input.action === 'enrollment') return Response.json({ enrolled: true, available: true });
    if (input.action === 'prepare')
      return Response.json({
        format: 1,
        accountId,
        stackName: `kilo-${String(input.credentialId).replaceAll('-', '')}`,
        externalId: ec2Configuration.externalId,
        kiloRoleArn: 'arn:aws:iam::123456789012:role/kilo',
        installation: input.generation,
        provider: 'aws-ec2',
        release: ec2Release,
      });
    if (input.action === 'validate')
      return Response.json(wrongEngineReply ? ecsConfiguration : ec2Configuration);
    if (input.action === 'revalidate') return Response.json({ verified: true });
    return Response.json({
      launchUrl: 'https://us-east-1.console.aws.amazon.com/cloudformation/home',
      accountId,
      stackName: `kilo-${String(input.credentialId).replaceAll('-', '')}`,
      templateVersion: 1,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
  });
});
afterEach(() => jest.restoreAllMocks());
async function connectionRow() {
  const result = await db.query.byoc_connections.findFirst({
    where: and(eq(byoc_connections.provider, 'aws-ec2'), eq(byoc_connections.user_id, user.id)),
  });
  if (!result) throw new Error('Missing test AWS row');
  return result;
}
function decrypt(envelope: unknown, scheme: string, aad: string) {
  const { awsTestPrivateKey } = jest.requireMock('@kilocode/web-shared/lib/config.server') as {
    awsTestPrivateKey: string;
  };
  return JSON.parse(
    decryptKeyedEnvelope(
      JSON.stringify(envelope),
      scheme,
      { active: { keyId: 'agent-env-vars-v1', privateKeyPem: awsTestPrivateKey } },
      aad
    )
  );
}

describe('EC2 owner and persistence contracts', () => {
  const configuration = ec2Configuration;
  const row = () => connectionRow();
  it('persists an owner-bound encrypted draft before launch and redacts browser status', async () => {
    const caller = personalCaller({ user });
    const status = await caller.prepare({ accountId });
    const stored = await row();
    expect(stored.setup_status).toBe('pending');
    expect(JSON.stringify(stored.credentials_encrypted)).not.toContain(configuration.externalId);
    const purpose = awsEc2SetupEnvelope({
      owner: { userId: user.id },
      credentialId: stored.id,
      generation: stored.build_generation,
    });
    const intent = decrypt(stored.credentials_encrypted, purpose.scheme, purpose.aad);
    expect(intent.externalId).toBe(configuration.externalId);
    expect(Object.keys(status).sort()).toEqual([
      'accountId',
      'generation',
      'stackName',
      'state',
      'templateVersion',
    ]);
    await caller.instructions();
    expect(requests.at(-1)?.envelope).toEqual(stored.credentials_encrypted);
    expect(requests.at(-1)?.owner).toEqual({ userId: user.id });
  });
  it('concurrent preparation returns the same persisted winner', async () => {
    const caller = personalCaller({ user });
    const statuses = await Promise.all(
      Array.from({ length: 5 }, () => caller.prepare({ accountId }))
    );
    expect(new Set(statuses.map(status => status.generation)).size).toBe(1);
    const stored = await row();
    expect(statuses[0].generation).toBe(stored.build_generation);
  });
  it('saves ready credentials with the runtime purpose and exposes only public metadata', async () => {
    const caller = personalCaller({ user });
    await caller.prepare({ accountId });
    const status = await caller.validate({ roleArn });
    const stored = await row();
    expect(status.state).toBe('ready');
    const purpose = awsEc2ConfigurationEnvelope({ userId: user.id }, stored.id);
    expect(decrypt(stored.credentials_encrypted, purpose.scheme, purpose.aad)).toEqual(
      configuration
    );
    expect(Object.keys(status).sort()).toEqual([
      'accountId',
      'lastVerifiedAt',
      'region',
      'roleArn',
      'stackId',
      'state',
      'templateVersion',
    ]);
    expect(JSON.stringify(status)).not.toContain(configuration.externalId);
  });
  it('failed validation preserves the draft and returns fixed recovery text', async () => {
    const caller = personalCaller({ user });
    await caller.prepare({ accountId });
    const previous = await row();
    remoteFailure = 'byoc_aws_external_id_not_enforced';
    await expect(caller.validate({ roleArn })).rejects.toThrow('must require the ExternalId');
    expect((await row()).credentials_encrypted).toEqual(previous.credentials_encrypted);
    remoteFailure = undefined;
    await expect(caller.validate({ roleArn })).resolves.toMatchObject({ state: 'ready' });
  });
  it('generation CAS refuses a stale validation response', async () => {
    const caller = personalCaller({ user });
    await caller.prepare({ accountId });
    beforeReply = async input => {
      if (input.action === 'validate')
        await db
          .update(byoc_connections)
          .set({ build_generation: crypto.randomUUID() })
          .where(eq(byoc_connections.user_id, user.id));
    };
    await expect(caller.validate({ roleArn })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await row()).setup_status).toBe('pending');
  });
  it('ready revalidation preserves ciphertext and pins, including on failure', async () => {
    const caller = personalCaller({ user });
    await caller.prepare({ accountId });
    await caller.validate({ roleArn });
    const ready = await row();
    await caller.validate({ roleArn });
    expect((await row()).credentials_encrypted).toEqual(ready.credentials_encrypted);
    expect((await row()).config).toEqual(ready.config);
    remoteFailure = 'byoc_aws_setup_changed';
    await expect(caller.validate({ roleArn })).rejects.toThrow(
      AWS_SETUP_ERRORS.byoc_aws_setup_changed
    );
    expect((await row()).credentials_encrypted).toEqual(ready.credentials_encrypted);
  });
  it('ready revalidation keeps runtime keys written during the AWS check', async () => {
    const caller = personalCaller({ user });
    await caller.prepare({ accountId });
    await caller.validate({ roleArn });
    beforeReply = async input => {
      if (input.action === 'revalidate')
        await db
          .update(byoc_connections)
          .set({ runtime: { last_verified_at: '2000-01-01T00:00:00.000Z', concurrent: 'kept' } })
          .where(
            and(eq(byoc_connections.provider, 'aws-ec2'), eq(byoc_connections.user_id, user.id))
          );
    };
    await caller.validate({ roleArn });
    const runtime = (await row()).runtime;
    expect(runtime.concurrent).toBe('kept');
    expect(runtime.last_verified_at).not.toBe('2000-01-01T00:00:00.000Z');
  });
  it('normalizes production PostgreSQL verification timestamps', async () => {
    const caller = personalCaller({ user });
    await caller.prepare({ accountId });
    await caller.validate({ roleArn });
    const stored = await row();
    expect(
      awsStatusFromRow({ ...stored, runtime: { last_verified_at: '2026-04-29 01:16:12.945+00' } })
    ).toMatchObject({ lastVerifiedAt: '2026-04-29T01:16:12.945Z' });
  });
  it('discards only the current unfinished draft, never ready credentials', async () => {
    const caller = personalCaller({ user });
    const status = await caller.prepare({ accountId });
    await expect(caller.discardDraft({ generation: crypto.randomUUID() })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await caller.discardDraft({ generation: status.generation });
    expect(await caller.getStatus()).toBeNull();
    const next = await caller.prepare({ accountId });
    await caller.validate({ roleArn });
    await expect(caller.discardDraft({ generation: next.generation })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
  it('rejects browser-supplied ciphertext and other owner fields', async () => {
    await expect(
      personalCaller({ user }).prepare({ accountId, envelope: {} } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(requests).toHaveLength(0);
  });
  it('isolates personal credentials and requires organization admin authorization', async () => {
    await personalCaller({ user }).prepare({ accountId });
    expect(await personalCaller({ user: member }).getStatus()).toBeNull();
    await expect(
      orgCaller({ user: member }).prepare({ organizationId, accountId })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const status = await orgCaller({ user: admin }).prepare({
      organizationId,
      accountId,
    });
    expect(status.accountId).toBe(accountId);
    expect(requests.at(-1)?.owner).toEqual({ organizationId });
    const orgRow = await db.query.byoc_connections.findFirst({
      where: and(
        eq(byoc_connections.provider, 'aws-ec2'),
        eq(byoc_connections.organization_id, organizationId)
      ),
    });
    expect(orgRow?.user_id).toBeNull();
    expect((await row()).organization_id).toBeNull();
  });
  it('rejects a successful reply containing another engine configuration', async () => {
    const caller = personalCaller({ user });
    await caller.prepare({ accountId });
    const previous = await row();
    wrongEngineReply = true;
    await expect(caller.validate({ roleArn })).rejects.toThrow();
    expect((await row()).credentials_encrypted).toEqual(previous.credentials_encrypted);
    expect((await row()).setup_status).toBe('pending');
  });
  it('sanitizes an unknown upstream error body', async () => {
    remoteFailure = 'private-provider-error-must-not-return';
    await expect(personalCaller({ user }).prepare({ accountId })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'AWS setup is unavailable. Try again later.',
    });
  });
});

it('sends only EC2 setup requests and rejects a browser-selected ECS provider', async () => {
  const caller = personalCaller({ user });
  await caller.getEnrollment();
  await caller.prepare({ accountId });
  await caller.instructions();
  await caller.validate({ roleArn });
  expect(requests.map(request => request.provider)).toEqual([
    'aws-ec2',
    'aws-ec2',
    'aws-ec2',
    'aws-ec2',
  ]);
  await expect(caller.prepare({ accountId, provider: 'aws-ecs' } as never)).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});
