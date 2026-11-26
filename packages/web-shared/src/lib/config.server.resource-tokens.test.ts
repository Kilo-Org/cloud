import {
  isNativeResourceCredentialIssuanceEnabled,
  isResourceTokenIssuanceEnabled,
  type ResourceTokenFamily,
} from './config.server';

const families = {
  'cloud-agent-next': 'CLOUD_AGENT_RESOURCE_TOKENS_ENABLED',
  chat: 'CHAT_RESOURCE_TOKENS_ENABLED',
  'delegated-resource': 'DELEGATED_RESOURCE_TOKENS_ENABLED',
  'workflow-gateway': 'WORKFLOW_GATEWAY_RESOURCE_TOKENS_ENABLED',
  'internal-bot': 'INTERNAL_BOT_RESOURCE_TOKENS_ENABLED',
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
