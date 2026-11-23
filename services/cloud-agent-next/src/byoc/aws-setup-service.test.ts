import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { encryptKeyedEnvelope, parseKeyedEnvelope } from '@kilocode/encryption';
import {
  AWS_BYOC_ENVELOPE_KEY_ID,
  AWS_BYOC_ENVELOPE_SCHEME,
} from '@kilocode/worker-utils/aws-byoc';
import {
  AWS_BYOC_SETUP_ENVELOPE_SCHEME,
  awsSetupEnvelopeAad,
} from '@kilocode/worker-utils/aws-onboarding';
import { AWS_EGRESS_PUBLIC_KEY, AWS_EGRESS_SHARED_KEY } from '@kilocode/worker-utils/aws-egress';
import { sha256Hex } from '@kilocode/worker-utils/sha256';
import {
  createAwsSetupIntent,
  readReadyAwsConfiguration,
  type AwsSetupEnvironment,
} from './aws-setup-intent.js';
import { awsSetupParameters } from './aws-stack-validation.js';
import { createAwsSetupService } from './aws-setup-service.js';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const hash = 'a'.repeat(64);
const roleArn = 'arn:aws:iam::999999999999:role/customer';
const escape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
async function fixture() {
  const now = Date.now();
  let template = '{"AWSTemplateFormatVersion":"2010-09-09"}';
  const templateHash = await sha256Hex(template);
  const binding = {
    owner: { userId: 'oauth/provider/user' },
    credentialId: '11111111-1111-4111-8111-111111111111',
    generation: '22222222-2222-4222-8222-222222222222',
  };
  const env: AwsSetupEnvironment = {
    BYOC_AWS_IDS: binding.owner.userId,
    AWS_BYOC_CREDENTIALS: JSON.stringify({
      accessKeyId: 'AKIATEST000000000000',
      secretAccessKey: 'BootstrapSecret00000000000',
    }),
    AWS_BYOC_KILO_ROLE_ARN: 'arn:aws:iam::123456789012:role/kilo',
    WORKER_URL: 'https://worker.example.com',
    AGENT_ENV_VARS_PRIVATE_KEY: keys.privateKey,
    AWS_BYOC_RELEASE: JSON.stringify({
      format: 1,
      templateVersion: 2,
      proxyProtocolVersion: 1,
      template: {
        bucket: 'kilo-releases',
        key: `aws/${templateHash}/template.json`,
        sha256: templateHash,
      },
      runtime: {
        bucket: 'kilo-releases',
        key: `aws/${hash}/runtime.zip`,
        sha256: hash,
        repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/runtime',
      },
      proxy: {
        imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/proxy@sha256:${hash}`,
        repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/proxy',
      },
      customerAccounts: ['999999999999'],
    }),
  };
  const intent = createAwsSetupIntent(env, binding, '999999999999');
  const seal = (value: unknown, scheme: string, aad: string) =>
    parseKeyedEnvelope(
      encryptKeyedEnvelope(
        JSON.stringify(value),
        scheme,
        { keyId: AWS_BYOC_ENVELOPE_KEY_ID, publicKeyPem: keys.publicKey },
        aad
      ),
      scheme
    );
  const envelope = seal(intent, AWS_BYOC_SETUP_ENVELOPE_SCHEME, awsSetupEnvelopeAad(binding));
  const stackId = `arn:aws:cloudformation:us-east-1:999999999999:stack/${intent.stackName}/12345678-abcd`;
  const outputs: Record<string, string> = {
    RoleArn: roleArn,
    Bucket: 'customer-artifacts',
    TemplateVersion: '2',
    ProxyProtocolVersion: '1',
    ImageArn: 'arn:aws:lambda:us-east-1:999999999999:microvm-image:customer',
    ImageVersion: '2.0',
    ConnectorArn: 'arn:aws:lambda:us-east-1:999999999999:network-connector:customer:1',
    ProxyHostname: 'proxy.customer.internal',
  };
  let returnedStackId = stackId;
  let acceptWrongExternalId = false;
  let customerRoleStatus: number | undefined;
  let metadataReads = 0;
  const roleExternalIds: Array<string | null> = [];
  const publicCa = 'synthetic-public-ca'.repeat(12);
  const deployment = {
    protocolVersion: 1,
    generation: '33333333-3333-4333-8333-333333333333',
    stackId,
    hostname: outputs.ProxyHostname,
    port: 3128,
    caCertificate: publicCa,
    caFingerprint: await sha256Hex(publicCa),
    expiresAt: new Date(now + 86_400_000).toISOString(),
  };
  const identity = {
    protocolVersion: 1,
    generation: deployment.generation,
    stackId,
    secret: 'e'.repeat(64),
  };
  const sts = (key: string) =>
    new Response(
      `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>${key}</AccessKeyId><SecretAccessKey>KiloSecret0000000000000000000000000000000</SecretAccessKey><SessionToken>syntheticsessiontoken</SessionToken><Expiration>${new Date(now + 3_600_000).toISOString()}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`
    );
  const api = createAwsSetupService(env, {
    now: () => now,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.hostname.startsWith('sts.')) {
        const body = new URLSearchParams(await request.text());
        if (body.get('RoleArn') === env.AWS_BYOC_KILO_ROLE_ARN) return sts('ASIAKILO000000000000');
        expect(body.get('RoleArn')).toBe(roleArn);
        const externalId = body.get('ExternalId');
        roleExternalIds.push(externalId);
        if (customerRoleStatus !== undefined)
          return new Response(null, { status: customerRoleStatus });
        return externalId === intent.externalId || acceptWrongExternalId
          ? sts('ASIACUSTOMER00000000')
          : new Response(null, { status: 403 });
      }
      if (url.hostname.startsWith('cloudformation.')) {
        const body = new URLSearchParams(await request.text());
        expect([intent.stackName, stackId]).toContain(body.get('StackName'));
        const parameters = Object.entries(awsSetupParameters(intent))
          .map(
            ([key, value]) =>
              `<member><ParameterKey>${key}</ParameterKey><ParameterValue>${escape(value)}</ParameterValue></member>`
          )
          .join('');
        const values = Object.entries(outputs)
          .map(
            ([key, value]) =>
              `<member><OutputKey>${key}</OutputKey><OutputValue>${escape(value)}</OutputValue></member>`
          )
          .join('');
        return new Response(
          `<DescribeStacksResponse><DescribeStacksResult><Stacks><member><StackName>${intent.stackName}</StackName><StackId>${returnedStackId}</StackId><StackStatus>UPDATE_COMPLETE</StackStatus><Parameters>${parameters}</Parameters><Outputs>${values}</Outputs></member></Stacks></DescribeStacksResult></DescribeStacksResponse>`
        );
      }
      if (url.hostname === 'kilo-releases.s3.us-east-1.amazonaws.com')
        return new Response(template);
      if (url.pathname === '/' + AWS_EGRESS_PUBLIC_KEY) {
        metadataReads++;
        return Response.json(deployment);
      }
      if (url.pathname === '/' + AWS_EGRESS_SHARED_KEY) {
        metadataReads++;
        return Response.json(identity);
      }
      throw new Error('Unexpected synthetic AWS request');
    },
  });
  return {
    api,
    env,
    binding,
    envelope,
    intent,
    outputs,
    deployment,
    identity,
    roleExternalIds,
    metadataReads: () => metadataReads,
    unsafeTrust() {
      acceptWrongExternalId = true;
    },
    failCustomerRole(status: number) {
      customerRoleStatus = status;
    },
    wrongAccount() {
      returnedStackId = returnedStackId.replace('999999999999', '888888888888');
    },
    corruptTemplate() {
      template += 'corrupt';
    },
    sealReady: (value: unknown) =>
      seal(
        value,
        AWS_BYOC_ENVELOPE_SCHEME,
        `byoc-aws-configuration:v1:user:${binding.owner.userId}:${binding.credentialId}`
      ),
  };
}

describe('AWS onboarding validation service', () => {
  it('verifies an immutable template before issuing its short-lived CloudFormation link', async () => {
    const f = await fixture();
    const result = await f.api.instructions(f.binding, f.envelope);
    const url = new URL(result.launchUrl);
    const query = new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1));
    const capability = new URL(query.get('templateURL') ?? '');
    expect(capability.hostname).toBe('kilo-releases.s3.us-east-1.amazonaws.com');
    expect(capability.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(query.get('param_ExternalId')).toBe(f.intent.externalId);
    expect(JSON.stringify(result)).not.toContain('KiloSecret');
    f.corruptTemplate();
    await expect(f.api.instructions(f.binding, f.envelope)).rejects.toMatchObject({
      code: 'byoc_aws_setup_unavailable',
    });
  });
  it('requires the exact ExternalId and returns a scoped configuration without AWS credentials', async () => {
    const f = await fixture();
    const result = await f.api.validate(f.binding, f.envelope, roleArn);
    expect(result.roleArn).toBe(roleArn);
    expect(result.imageVersion).toBe('2.0');
    expect(result.proxy).toEqual({
      generation: f.deployment.generation,
      hostname: f.deployment.hostname,
      caFingerprint: f.deployment.caFingerprint,
    });
    expect(f.roleExternalIds).toContain(f.intent.externalId);
    expect(f.roleExternalIds).toContain(null);
    expect(
      f.roleExternalIds.some(
        value =>
          value !== null &&
          value !== f.intent.externalId &&
          value.length === f.intent.externalId.length
      )
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('KiloSecret');
    expect(JSON.stringify(result)).not.toContain(f.identity.secret);
  });
  it('refuses a role that accepts an omitted or incorrect ExternalId', async () => {
    const f = await fixture();
    f.unsafeTrust();
    await expect(f.api.validate(f.binding, f.envelope, roleArn)).rejects.toMatchObject({
      code: 'byoc_aws_external_id_not_enforced',
    });
    expect(f.metadataReads()).toBe(0);
  });
  it.each([
    [503, 'byoc_aws_setup_unavailable'],
    [403, 'byoc_aws_role_unavailable'],
  ])('reports a %s customer role assumption as %s', async (status, code) => {
    const f = await fixture();
    f.failCustomerRole(status);
    await expect(f.api.validate(f.binding, f.envelope, roleArn)).rejects.toMatchObject({ code });
  });
  it('checks the expected account after a named lookup', async () => {
    const f = await fixture();
    f.wrongAccount();
    await expect(f.api.validate(f.binding, f.envelope, roleArn)).rejects.toMatchObject({
      code: 'byoc_aws_stack_mismatch',
    });
    expect(f.metadataReads()).toBe(0);
  });
  it.each(['old-template', 'wrong-protocol', 'short-certificate', 'wrong-proxy-identity'])(
    'refuses %s before saving configuration',
    async change => {
      const f = await fixture();
      if (change === 'old-template') f.outputs.TemplateVersion = '1';
      if (change === 'wrong-protocol') f.outputs.ProxyProtocolVersion = '2';
      if (change === 'short-certificate')
        f.deployment.expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      if (change === 'wrong-proxy-identity')
        f.identity.generation = '44444444-4444-4444-8444-444444444444';
      const code = {
        'old-template': 'byoc_aws_stack_outdated',
        'wrong-protocol': 'byoc_aws_proxy_protocol_unsupported',
        'short-certificate': 'byoc_aws_proxy_expired',
        'wrong-proxy-identity': 'byoc_aws_proxy_unavailable',
      }[change];
      await expect(f.api.validate(f.binding, f.envelope, roleArn)).rejects.toMatchObject({ code });
    }
  );
  it('revalidates ready pins without a new release and refuses changed resources', async () => {
    const f = await fixture();
    const configuration = await f.api.validate(f.binding, f.envelope, roleArn);
    const ready = f.sealReady(configuration);
    f.env.AWS_BYOC_RELEASE = undefined;
    await f.api.revalidate(f.binding, ready, roleArn);
    f.outputs.ImageVersion = '9.0';
    await expect(f.api.revalidate(f.binding, ready, roleArn)).rejects.toMatchObject({
      code: 'byoc_aws_connection_update_required',
    });
    expect(readReadyAwsConfiguration(f.env, f.binding, ready)).toEqual(configuration);
  });
});
