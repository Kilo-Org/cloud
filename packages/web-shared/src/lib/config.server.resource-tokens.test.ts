import jwt from 'jsonwebtoken';
import type { User } from '@kilocode/db/schema';
import { generateCloudAgentWorkflowToken, generateWorkflowGatewayToken } from './tokens';
import {
  isNativeResourceCredentialIssuanceEnabled,
  isResourceTokenIssuanceEnabled,
  type ResourceTokenFamily,
} from './config.server';

const families = {
  'cloud-agent-next': 'CLOUD_AGENT_RESOURCE_TOKENS_ENABLED',
  gastown: 'GASTOWN_RESOURCE_TOKENS_ENABLED',
  wasteland: 'WASTELAND_RESOURCE_TOKENS_ENABLED',
  chat: 'CHAT_RESOURCE_TOKENS_ENABLED',
  'delegated-resource': 'DELEGATED_RESOURCE_TOKENS_ENABLED',
  'workflow-gateway': 'WORKFLOW_GATEWAY_RESOURCE_TOKENS_ENABLED',
  benchmark: 'BENCHMARK_RESOURCE_TOKENS_ENABLED',
} satisfies Record<ResourceTokenFamily, string>;
const entries = Object.entries(families) as [ResourceTokenFamily, string][];
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

it('defaults every family and native adoption off', () => {
  for (const [family] of entries) expect(isResourceTokenIssuanceEnabled(family)).toBe(false);
  expect(isNativeResourceCredentialIssuanceEnabled()).toBe(false);
});

it('keeps all families off when only the master is enabled', () => {
  process.env[master] = 'true';
  for (const [family] of entries) expect(isResourceTokenIssuanceEnabled(family)).toBe(false);
});

it.each([undefined, '', 'false', 'TRUE', '1', ' true', 'true '])(
  'requires exact true on the master (%s)',
  value => {
    if (value !== undefined) process.env[master] = value;
    for (const [, key] of entries) process.env[key] = 'true';
    process.env[native] = 'true';
    for (const [family] of entries) expect(isResourceTokenIssuanceEnabled(family)).toBe(false);
    expect(isNativeResourceCredentialIssuanceEnabled()).toBe(false);
  }
);

it.each(entries)('enables only %s and leaves native independent', (family, key) => {
  process.env[master] = 'true';
  process.env[key] = 'true';
  for (const [candidate] of entries) {
    expect(isResourceTokenIssuanceEnabled(candidate)).toBe(candidate === family);
  }
  expect(isNativeResourceCredentialIssuanceEnabled()).toBe(false);
});

it.each(['', 'false', 'TRUE', '1', ' true', 'true '])(
  'requires exact true on each family and native flag (%s)',
  value => {
    process.env[master] = 'true';
    for (const [, key] of entries) process.env[key] = value;
    process.env[native] = value;
    for (const [family] of entries) expect(isResourceTokenIssuanceEnabled(family)).toBe(false);
    expect(isNativeResourceCredentialIssuanceEnabled()).toBe(false);
  }
);

it('native adoption needs no producer family enabled and enables none', () => {
  process.env[master] = 'true';
  process.env[native] = 'true';
  expect(isNativeResourceCredentialIssuanceEnabled()).toBe(true);
  for (const [family] of entries) expect(isResourceTokenIssuanceEnabled(family)).toBe(false);
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
  expect(cloud.exp! - cloud.iat!).toBe(cloudModern ? 3600 : 7200);
  expect(gateway.aud).toBe(gatewayModern ? 'kilo-gateway' : undefined);
  expect(gateway.tokenPurpose).toBe(gatewayModern ? 'delegated-workload' : undefined);
  expect(gateway.exp! - gateway.iat!).toBe(gatewayModern ? 3600 : 5 * 365 * 24 * 3600);
});
