import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../hono-context.js';
import type { Env } from '../types.js';
import { registerAwsSetupRoutes } from './aws-setup-routes.js';

const hash = 'a'.repeat(64);
const binding = {
  owner: { userId: 'oauth/provider/user' },
  credentialId: crypto.randomUUID(),
  generation: crypto.randomUUID(),
};
const env = {
  BYOC_AWS_IDS: binding.owner.userId,
  WORKER_URL: 'https://worker.example.com',
  AWS_BYOC_KILO_ROLE_ARN: 'arn:aws:iam::123456789012:role/kilo',
  AWS_BYOC_RELEASE: JSON.stringify({
    format: 1,
    templateVersion: 2,
    proxyProtocolVersion: 1,
    template: { bucket: 'kilo-releases', key: `${hash}/template.json`, sha256: hash },
    runtime: {
      bucket: 'kilo-releases',
      key: `${hash}/runtime.zip`,
      sha256: hash,
      repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/runtime',
    },
    proxy: {
      imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/proxy@sha256:${hash}`,
      repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/proxy',
    },
    customerAccounts: ['999999999999'],
  }),
} as Env;
function request(body: unknown, authorized = true) {
  const app = new Hono<HonoContext>();
  registerAwsSetupRoutes(app, c => (authorized ? null : c.text('Unauthorized', 401)));
  return app.request(
    '/internal/byoc/aws/setup',
    { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) },
    env
  );
}
describe('internal AWS setup authority boundary', () => {
  it('requires internal authorization before parsing or generating setup', async () => {
    expect(
      (await request({ action: 'prepare', ...binding, accountId: '999999999999' }, false)).status
    ).toBe(401);
  });
  it('passes only binding fields to strict setup contracts', async () => {
    const response = await request({ action: 'prepare', ...binding, accountId: '999999999999' });
    expect(response.status).toBe(200);
    const value = (await response.json()) as { stackName: string; externalId: string };
    expect(value.stackName).toBe(`kilo-${binding.credentialId.replaceAll('-', '')}`);
    expect(value.externalId).toMatch(/^[a-f0-9]{64}$/);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it.each([
    '{',
    'x'.repeat(65 * 1024),
    { action: 'enrollment', owner: { userId: 'x', organizationId: crypto.randomUUID() } },
    { action: 'enrollment', owner: binding.owner, credentials: 'untrusted' },
  ])('rejects malformed, oversized or extra authority fields', async value => {
    expect((await request(value)).status).toBe(400);
  });
  it('returns fixed errors for unenrolled owners and malformed envelopes', async () => {
    const denied = await request({
      action: 'prepare',
      ...binding,
      owner: { userId: 'other' },
      accountId: '999999999999',
    });
    expect(await denied.json()).toEqual({ error: 'byoc_aws_setup_unavailable' });
    const badEnvelope = await request({
      action: 'instructions',
      ...binding,
      envelope: { providerSecret: 'must-not-return' },
    });
    expect(await badEnvelope.json()).toEqual({ error: 'byoc_aws_setup_unavailable' });
  });
});
