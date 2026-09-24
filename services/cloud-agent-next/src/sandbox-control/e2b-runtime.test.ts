import { describe, expect, it } from 'vitest';
import { E2BProviderError } from '../byoc/e2b-errors.js';
import { E2B_CREDENTIAL_REQUEST_TIMEOUT_MS } from '../byoc/e2b-credential-resolver.js';
import {
  E2B_MAX_LIFETIME_MS,
  E2B_RECONCILIATION_LEAD_MS,
  E2B_RECONCILIATION_WINDOW_MS,
  E2B_SCAN_TIMEOUT_MS,
  createE2BPendingConfig,
  encodeE2BProviderRef,
  e2bCreateDeadline,
  markE2BConfigSubmitted,
  parseE2BAllocationConfig,
  parseE2BProviderRef,
  parseOwnedE2BConfig,
} from './e2b-runtime.js';
import {
  E2B_TEST_BINDING,
  E2B_TEST_ENV,
  E2B_TEST_INTENT_ID,
  E2B_TEST_NOW,
  E2B_TEST_PHYSICAL_ID,
  E2B_TEST_SANDBOX_ID,
  e2bTestPendingConfig,
  e2bTestRef,
  e2bTestSubmittedConfig,
} from './e2b-test-fixtures.js';

const invalid = new E2BProviderError('byoc_e2b_policy_mismatch');

function pending() {
  return createE2BPendingConfig({
    binding: E2B_TEST_BINDING,
    sandboxId: E2B_TEST_SANDBOX_ID,
    env: E2B_TEST_ENV,
    createdAt: E2B_TEST_NOW,
  });
}

describe('E2B pinned allocation block', () => {
  it('pins the release, binding, resource profile and original lifetime as pending', () => {
    expect(pending()).toEqual({
      binding: E2B_TEST_BINDING,
      sandboxId: E2B_TEST_SANDBOX_ID,
      templateId: 'kilotemplate123',
      templateReference: 'kilocode/cloud-agent:cccccccc-4444-4444-8444-444444444444',
      runtimeBuildId: 'kilo-runtime-test-build',
      resourceProfile: { cpuCount: 2, memoryMB: 4096 },
      hardStopAt: E2B_TEST_NOW + E2B_MAX_LIFETIME_MS,
      submissionState: 'pending',
    });
  });

  it('round-trips through the stored schema', () => {
    const config = pending();
    expect(parseE2BAllocationConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
  });

  it('rejects a block owned by another binding or sandbox', () => {
    const config = pending();
    expect(() =>
      parseOwnedE2BConfig(
        config,
        { ...E2B_TEST_BINDING, organizationId: 'eeeeeeee-1111-4111-8111-111111111111' },
        E2B_TEST_SANDBOX_ID
      )
    ).toThrow(invalid);
    expect(() =>
      parseOwnedE2BConfig(config, E2B_TEST_BINDING, 'another-sandbox')
    ).toThrow(invalid);
  });
});

describe('E2B submission', () => {
  it('computes submittedAt, both deadlines and the reconciliation alarm once', () => {
    const submitted = markE2BConfigSubmitted({
      config: pending(),
      binding: E2B_TEST_BINDING,
      sandboxId: E2B_TEST_SANDBOX_ID,
      now: E2B_TEST_NOW + 1000,
      createDeadlineAt: E2B_TEST_NOW + 120_000,
    });
    expect(submitted).toMatchObject({
      submissionState: 'submitted',
      submittedAt: E2B_TEST_NOW + 1000,
      createDeadlineAt: E2B_TEST_NOW + 120_000,
      reconciliationDeadlineAt: E2B_TEST_NOW + 1000 + E2B_RECONCILIATION_WINDOW_MS,
      reconciliationAlarmAt: E2B_TEST_NOW + 1000 + E2B_RECONCILIATION_WINDOW_MS - E2B_RECONCILIATION_LEAD_MS,
    });
    expect(pending().submissionState).toBe('pending');
  });

  it('omits the reconciliation alarm when the window cannot fit the lead', () => {
    // A create bound a hair under the cap leaves a window shorter than the lead.
    const config = pending();
    const submitted = markE2BConfigSubmitted({
      config,
      binding: E2B_TEST_BINDING,
      sandboxId: E2B_TEST_SANDBOX_ID,
      now: config.hardStopAt - (E2B_RECONCILIATION_LEAD_MS - 1),
      createDeadlineAt: config.hardStopAt,
    });
    expect(submitted.reconciliationAlarmAt).toBeUndefined();
    expect(submitted.reconciliationDeadlineAt).toBe(config.hardStopAt);
  });

  it('refuses a second submission and an out-of-bounds create deadline', () => {
    const submitted = e2bTestSubmittedConfig();
    expect(() =>
      markE2BConfigSubmitted({
        config: submitted,
        binding: E2B_TEST_BINDING,
        sandboxId: E2B_TEST_SANDBOX_ID,
        now: E2B_TEST_NOW + 2000,
        createDeadlineAt: E2B_TEST_NOW + 130_000,
      })
    ).toThrow(new E2BProviderError('byoc_e2b_create_unknown'));
    expect(() =>
      markE2BConfigSubmitted({
        config: pending(),
        binding: E2B_TEST_BINDING,
        sandboxId: E2B_TEST_SANDBOX_ID,
        now: E2B_TEST_NOW + 1000,
        createDeadlineAt: E2B_TEST_NOW + 1000,
      })
    ).toThrow(new E2BProviderError('byoc_e2b_create_unknown'));
    expect(() =>
      markE2BConfigSubmitted({
        config: pending(),
        binding: E2B_TEST_BINDING,
        sandboxId: E2B_TEST_SANDBOX_ID,
        now: E2B_TEST_NOW + 1000,
        createDeadlineAt: pending().hardStopAt + 1,
      })
    ).toThrow(new E2BProviderError('byoc_e2b_create_unknown'));
  });

  it('rejects a submission at or after the lifetime cap', () => {
    const config = pending();
    expect(() =>
      markE2BConfigSubmitted({
        config,
        binding: E2B_TEST_BINDING,
        sandboxId: E2B_TEST_SANDBOX_ID,
        now: config.hardStopAt,
        createDeadlineAt: config.hardStopAt,
      })
    ).toThrow(new E2BProviderError('byoc_e2b_lifetime_exceeded'));
  });

  it('keeps the lead as the sum of the two exported budgets', () => {
    expect(E2B_RECONCILIATION_LEAD_MS).toBe(
      E2B_CREDENTIAL_REQUEST_TIMEOUT_MS + E2B_SCAN_TIMEOUT_MS
    );
  });

  it('bounds the create deadline by the acquisition, create bound and cap', () => {
    expect(
      e2bCreateDeadline({
        acquisitionDeadlineAt: E2B_TEST_NOW + 30_000,
        creatingDeadlineAt: E2B_TEST_NOW + 120_000,
        hardStopAt: E2B_TEST_NOW + 3_600_000,
      })
    ).toBe(E2B_TEST_NOW + 30_000);
    expect(
      e2bCreateDeadline({
        acquisitionDeadlineAt: null,
        creatingDeadlineAt: E2B_TEST_NOW + 120_000,
        hardStopAt: E2B_TEST_NOW + 3_600_000,
      })
    ).toBe(E2B_TEST_NOW + 120_000);
    expect(
      e2bCreateDeadline({
        acquisitionDeadlineAt: null,
        creatingDeadlineAt: E2B_TEST_NOW + 120_000,
        hardStopAt: E2B_TEST_NOW + 60_000,
      })
    ).toBe(E2B_TEST_NOW + 60_000);
  });
});

describe('E2B compact physical references', () => {
  it('round-trips exact physical and operation IDs inside the sandboxHello limit', () => {
    const ref = e2bTestRef();
    expect(ref.length).toBeLessThanOrEqual(256);
    expect(parseE2BProviderRef(ref)).toEqual({
      physicalId: E2B_TEST_PHYSICAL_ID,
      intentId: E2B_TEST_INTENT_ID,
    });
    expect(ref).not.toContain(E2B_TEST_BINDING.credentialId);
  });

  it.each([
    null,
    '',
    '{}',
    'e2b1:sandbox:not-a-uuid',
    `e2b1:../sandbox:${E2B_TEST_INTENT_ID}`,
    `e2b1:sandbox?token=test:${E2B_TEST_INTENT_ID}`,
    `e2b1:sandbox:${E2B_TEST_INTENT_ID}:extra`,
    e2bTestRef().toUpperCase(),
    `${e2bTestRef()}\n`,
    `e2b1:${'s'.repeat(257)}:${E2B_TEST_INTENT_ID}`,
  ])('rejects malformed reference %#', ref => {
    expect(parseE2BProviderRef(ref)).toBeNull();
  });

  it('does not encode unsafe physical IDs', () => {
    expect(() =>
      encodeE2BProviderRef({ physicalId: 'https://invalid.example', intentId: E2B_TEST_INTENT_ID })
    ).toThrow(invalid);
  });

  it('rejects a submission block that is not a submitted shape', () => {
    expect(() =>
      parseE2BAllocationConfig({ ...e2bTestPendingConfig(), submissionState: 'submitted' })
    ).toThrow(invalid);
  });
});
