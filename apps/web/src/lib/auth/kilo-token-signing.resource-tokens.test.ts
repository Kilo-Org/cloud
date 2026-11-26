import jwt from 'jsonwebtoken';
import type { User } from '@kilocode/db/schema';
import {
  isResourceTokenIssuanceEnabled,
  type ResourceTokenFamily,
} from '@kilocode/web-shared/lib/config.server';
import {
  generateCloudAgentWorkflowToken,
  generateWorkflowGatewayToken,
} from './kilo-token-signing';

const families = {
  'cloud-agent-next': 'CLOUD_AGENT_RESOURCE_TOKENS_ENABLED',
  chat: 'CHAT_RESOURCE_TOKENS_ENABLED',
  'delegated-resource': 'DELEGATED_RESOURCE_TOKENS_ENABLED',
  'workflow-gateway': 'WORKFLOW_GATEWAY_RESOURCE_TOKENS_ENABLED',
  'internal-bot': 'INTERNAL_BOT_RESOURCE_TOKENS_ENABLED',
} satisfies Record<ResourceTokenFamily, string>;
const master = 'SHARED_RESOURCE_TOKENS_ENABLED';
const native = 'NATIVE_RESOURCE_TOKENS_ENABLED';
const keys = [master, native, ...Object.values(families)];
const saved = new Map(keys.map(key => [key, process.env[key]]));

beforeEach(() => {
  for (const key of keys) delete process.env[key];
});
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it.each([
  ['CLOUD_AGENT_RESOURCE_TOKENS_ENABLED', true, false],
  ['WORKFLOW_GATEWAY_RESOURCE_TOKENS_ENABLED', false, true],
] as const)('real issuer integration isolates %s', (flag, cloudModern, gatewayModern) => {
  process.env[master] = 'true';
  process.env[flag] = 'true';
  const user = { id: 'oauth/family-test', api_token_pepper: 'family-test-pepper' } as User;
  const cloud = jwt.decode(
    generateCloudAgentWorkflowToken(user, {
      expiresIn: 7200,
      tokenSource: 'reviewer',
    })
  ) as jwt.JwtPayload;
  const gateway = jwt.decode(
    generateWorkflowGatewayToken(user, {
      tokenSource: 'reviewer',
    })
  ) as jwt.JwtPayload;
  expect(cloud.aud).toBe(cloudModern ? 'cloud-agent-next' : undefined);
  expect(cloud.tokenPurpose).toBe(cloudModern ? 'internal-service' : undefined);
  expect(cloud.exp! - cloud.iat!).toBe(3600);
  expect(gateway.aud).toBe(gatewayModern ? 'kilo-gateway' : undefined);
  expect(gateway.tokenPurpose).toBe(gatewayModern ? 'delegated-workload' : undefined);
  expect(gateway.exp! - gateway.iat!).toBe(3600);
});

it.each([
  [false, undefined, 3600],
  [false, 300, 300],
  [false, 7200, 3600],
  [false, 5 * 365 * 24 * 60 * 60, 3600],
  [true, undefined, 3600],
  [true, 300, 300],
  [true, 7200, 3600],
  [true, 5 * 365 * 24 * 60 * 60, 3600],
] as const)(
  'bounds the gateway token lifetime to one hour (modern: %s, %s -> %s)',
  (modern, requestedExpiresIn, expectedLifetime) => {
    if (modern) {
      process.env[master] = 'true';
      process.env[families['workflow-gateway']] = 'true';
    }
    expect(isResourceTokenIssuanceEnabled('workflow-gateway')).toBe(modern);
    const user = { id: 'oauth/bounded', api_token_pepper: 'bounded-pepper' } as User;
    const gateway = jwt.decode(
      generateWorkflowGatewayToken(user, {
        organizationId: 'organization-id',
        tokenSource: 'reviewer',
        expiresIn: requestedExpiresIn,
      })
    ) as jwt.JwtPayload;
    expect(gateway.aud).toBe(modern ? 'kilo-gateway' : undefined);
    expect(gateway.tokenPurpose).toBe(modern ? 'delegated-workload' : undefined);
    expect(gateway.organizationId).toBe('organization-id');
    expect(gateway.exp! - gateway.iat!).toBe(expectedLifetime);
  }
);

it.each([false, true])(
  'rejects a nonpositive gateway lifetime in both issuance modes (modern: %s)',
  modern => {
    if (modern) {
      process.env[master] = 'true';
      process.env[families['workflow-gateway']] = 'true';
    }
    expect(isResourceTokenIssuanceEnabled('workflow-gateway')).toBe(modern);
    const user = { id: 'oauth/nonpositive', api_token_pepper: 'nonpositive-pepper' } as User;
    for (const expiresIn of [0, -60]) {
      expect(() =>
        generateWorkflowGatewayToken(user, { tokenSource: 'reviewer', expiresIn })
      ).toThrow('Workflow gateway token expiry must be positive');
    }
  }
);

it.each([
  [false, 300, 300],
  [false, 7200, 3600],
  [false, 5 * 365 * 24 * 60 * 60, 3600],
  [true, 300, 300],
  [true, 7200, 3600],
  [true, 5 * 365 * 24 * 60 * 60, 3600],
] as const)(
  'bounds the Cloud Agent workflow token lifetime to one hour (modern: %s, %s -> %s)',
  (modern, requestedExpiresIn, expectedLifetime) => {
    if (modern) {
      process.env[master] = 'true';
      process.env[families['cloud-agent-next']] = 'true';
    }
    expect(isResourceTokenIssuanceEnabled('cloud-agent-next')).toBe(modern);
    const user = { id: 'oauth/cloud-bounded', api_token_pepper: 'cloud-bounded-pepper' } as User;
    const cloud = jwt.decode(
      generateCloudAgentWorkflowToken(user, {
        organizationId: 'organization-id',
        tokenSource: 'reviewer',
        expiresIn: requestedExpiresIn,
      })
    ) as jwt.JwtPayload;
    expect(cloud.aud).toBe(modern ? 'cloud-agent-next' : undefined);
    expect(cloud.tokenPurpose).toBe(modern ? 'internal-service' : undefined);
    expect(cloud.organizationId).toBe('organization-id');
    expect(cloud.exp! - cloud.iat!).toBe(expectedLifetime);
  }
);

it.each([false, true])(
  'rejects a nonpositive Cloud Agent workflow lifetime in both issuance modes (modern: %s)',
  modern => {
    if (modern) {
      process.env[master] = 'true';
      process.env[families['cloud-agent-next']] = 'true';
    }
    expect(isResourceTokenIssuanceEnabled('cloud-agent-next')).toBe(modern);
    const user = { id: 'oauth/cloud-nonpositive', api_token_pepper: 'nonpositive-pepper' } as User;
    for (const expiresIn of [0, -60]) {
      expect(() =>
        generateCloudAgentWorkflowToken(user, { tokenSource: 'reviewer', expiresIn })
      ).toThrow('Workflow control token expiry must be positive');
    }
  }
);
