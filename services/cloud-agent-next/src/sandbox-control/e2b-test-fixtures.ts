import type { E2BSandboxProviderBinding } from '../sandbox-provider-binding.js';
import type { E2BRuntimeEnv } from '../byoc/e2b-runtime-config.js';
import type {
  E2BAllocationConfig,
  E2BSubmittedAllocationConfig,
} from '../sandbox-state/model/allocation.js';
import type { E2BSandboxDetail } from './e2b-api.js';
import {
  createE2BPendingConfig,
  e2bCreateMetadata,
  encodeE2BProviderRef,
  markE2BConfigSubmitted,
} from './e2b-runtime.js';

export const E2B_TEST_NOW = Date.parse('2026-09-03T00:00:00.000Z');
export const E2B_TEST_KEY = 'test-only-e2b-customer-key';
export const E2B_TEST_ENVD_TOKEN = 'test-only-envd-access-token';
export const E2B_TEST_SANDBOX_ID = 'workspace_33333333-3333-4333-8333-333333333333';
export const E2B_TEST_PHYSICAL_ID = 'e2b-owned-sandbox';
export const E2B_TEST_INTENT_ID = 'dddddddd-5555-4555-8555-555555555555';
export const E2B_TEST_BINDING: E2BSandboxProviderBinding = {
  kind: 'e2b',
  organizationId: 'aaaaaaaa-1111-4111-8111-111111111111',
  credentialId: 'bbbbbbbb-2222-4222-8222-222222222222',
};
export const E2B_TEST_ENV: E2BRuntimeEnv = {
  E2B_SANDBOX_TEMPLATE: 'kilocode/cloud-agent:cccccccc-4444-4444-8444-444444444444',
  E2B_SANDBOX_TEMPLATE_ID: 'kilotemplate123',
  E2B_SANDBOX_RUNTIME_BUILD_ID: 'kilo-runtime-test-build',
};
/** The parsed release the test env pins, for assertions that read it directly. */
export const E2B_TEST_RELEASE = {
  templateId: 'kilotemplate123',
  templateReference: 'kilocode/cloud-agent:cccccccc-4444-4444-8444-444444444444',
  runtimeBuildId: 'kilo-runtime-test-build',
};

export function e2bTestPendingConfig(): E2BAllocationConfig {
  return createE2BPendingConfig({
    binding: E2B_TEST_BINDING,
    sandboxId: E2B_TEST_SANDBOX_ID,
    env: E2B_TEST_ENV,
    createdAt: E2B_TEST_NOW,
  });
}

export function e2bTestSubmittedConfig(createDeadlineAt = E2B_TEST_NOW + 120_000): E2BSubmittedAllocationConfig {
  return markE2BConfigSubmitted({
    config: e2bTestPendingConfig(),
    binding: E2B_TEST_BINDING,
    sandboxId: E2B_TEST_SANDBOX_ID,
    now: E2B_TEST_NOW,
    createDeadlineAt,
  });
}

export function e2bTestConfig(submitted = true): E2BAllocationConfig {
  return submitted ? e2bTestSubmittedConfig() : e2bTestPendingConfig();
}

export function e2bTestRef(intentId = E2B_TEST_INTENT_ID): string {
  return encodeE2BProviderRef({ physicalId: E2B_TEST_PHYSICAL_ID, intentId });
}

/** The canonical create intent a provider adapter receives for the pinned config. */
export function e2bTestIntent(intentId = E2B_TEST_INTENT_ID): {
  intentId: string;
  createdAt: number;
  e2b: E2BAllocationConfig;
} {
  return { intentId, createdAt: E2B_TEST_NOW - 5_000, e2b: e2bTestPendingConfig() };
}

export function e2bTestSandbox(
  config: E2BAllocationConfig = e2bTestConfig(),
  intentId = E2B_TEST_INTENT_ID
): E2BSandboxDetail {
  return {
    sandboxID: E2B_TEST_PHYSICAL_ID,
    templateID: config.templateId,
    metadata: e2bCreateMetadata(config, intentId),
    startedAt: new Date(E2B_TEST_NOW).toISOString(),
    endAt: new Date(E2B_TEST_NOW + 300_000).toISOString(),
    state: 'running',
    envdVersion: '0.5.7',
    envdAccessToken: E2B_TEST_ENVD_TOKEN,
    cpuCount: 2,
    memoryMB: 4096,
    allowInternetAccess: true,
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: 'kill', autoResume: false },
  };
}
