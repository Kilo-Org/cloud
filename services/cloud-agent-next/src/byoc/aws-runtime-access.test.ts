import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import { ECS_TEST_CONFIG } from '../../test/fixtures/aws-ecs.js';
import { awsEcsRuntimeAccess } from './aws-credential-resolver.js';
import { createAwsRoleSessionCache } from './aws-runtime-access.js';

afterEach(() => vi.unstubAllGlobals());
describe('shared AWS account transport', () => {
  it('uses Kilo then customer role credentials', async () => {
    const env = {
      AWS_BYOC_CREDENTIALS: JSON.stringify({
        accessKeyId: 'AKIABOOT0000000000',
        secretAccessKey: 'bootstrap',
      }),
      AWS_BYOC_KILO_ROLE_ARN: 'arn:aws:iam::999999999999:role/kilo',
    } as Env;
    let assumptions = 0;
    const fetcher = vi.fn(async (request: Request) => {
      if (request.url.includes('sts.')) {
        const input = new URLSearchParams(await request.text());
        assumptions++;
        expect(input.get('RoleArn')).toBe(
          assumptions === 1 ? env.AWS_BYOC_KILO_ROLE_ARN : ECS_TEST_CONFIG.roleArn
        );
        expect(input.get('ExternalId')).toBe(assumptions === 1 ? null : ECS_TEST_CONFIG.externalId);
        expect(request.headers.get('authorization')).toContain(
          assumptions === 1 ? 'AKIABOOT0000000000' : 'ASIAKILO0000000000'
        );
        return new Response(
          `<AssumeRoleResponse><Credentials><AccessKeyId>${assumptions === 1 ? 'ASIAKILO0000000000' : 'ASIACUSTOMER000000'}</AccessKeyId><SecretAccessKey>synthetic</SecretAccessKey><SessionToken>SyntheticToken</SessionToken><Expiration>${new Date(Date.now() + 3_600_000).toISOString()}</Expiration></Credentials></AssumeRoleResponse>`
        );
      }
      expect(request.headers.get('authorization')).toContain('ASIACUSTOMER000000');
      expect(request.url).toContain('customer-artifacts.s3.us-east-1.amazonaws.com/kilo/launch/');
      return new Response(null);
    });
    vi.stubGlobal('fetch', fetcher);
    const access = await awsEcsRuntimeAccess(env, ECS_TEST_CONFIG);
    expect(access).not.toHaveProperty('credentials');
    await access.objects.putLaunch('kilo/launch/allocation-1.json', '{}');
    expect(assumptions).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('preserves forbidden role errors without exposing AWS bodies', async () => {
    vi.stubGlobal('fetch', async () => new Response('sensitive body', { status: 403 }));
    const env = {
      AWS_BYOC_CREDENTIALS: JSON.stringify({
        accessKeyId: 'AKIABOOT0000000000',
        secretAccessKey: 'bootstrap',
      }),
      AWS_BYOC_KILO_ROLE_ARN: 'arn:aws:iam::999999999999:role/kilo',
    } as Env;
    await expect(awsEcsRuntimeAccess(env, ECS_TEST_CONFIG)).rejects.toThrow('byoc_aws_forbidden');
  });
});
describe('owner-local AWS role session cache', () => {
  it('reuses concurrent and valid access only for the same pinned configuration', async () => {
    const gate = Promise.withResolvers<void>();
    let now = 0;
    let sequence = 0;
    const resolve = vi.fn(async (config: { role: string }) => {
      sequence++;
      await gate.promise;
      return { config, expiresAt: now + 3_600_000, sequence };
    });
    const access = createAwsRoleSessionCache(resolve, () => now);
    const first = access({ role: 'one' });
    const replay = access({ role: 'one' });
    gate.resolve();
    expect(await replay).toBe(await first);
    expect(await access({ role: 'one' })).toBe(await first);
    expect(resolve).toHaveBeenCalledTimes(1);
    await access({ role: 'two' });
    expect(resolve).toHaveBeenCalledTimes(2);
    now = 3_000_000;
    await access({ role: 'two' });
    expect(resolve).toHaveBeenCalledTimes(3);
  });
  it('does not retain failed role assumptions or share sessions across owners', async () => {
    const resolve = vi.fn(async (config: { role: string }) => ({ config, expiresAt: 3_600_000 }));
    resolve.mockRejectedValueOnce(new Error('transient'));
    const firstOwner = createAwsRoleSessionCache(resolve, () => 0);
    await expect(firstOwner({ role: 'one' })).rejects.toThrow('transient');
    await firstOwner({ role: 'one' });
    await createAwsRoleSessionCache(resolve, () => 0)({ role: 'one' });
    expect(resolve).toHaveBeenCalledTimes(3);
  });
});
