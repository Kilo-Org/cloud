import { describe, expect, it, jest } from '@jest/globals';
import {
  getSandboxAllocationKey,
  getSandboxAllocationRequest,
  type SandboxDestination,
  type SandboxSelectionCapabilities,
  type SelectableSandboxAllocationRequest,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  formatSandboxDestination,
  formatSandboxInstance,
  getSandboxSelectionGroups,
  getSandboxSelectionOptions,
  resolveSandboxSelection,
  resolveSandboxSelectionSubmissionError,
  type SandboxSelectionDraft,
} from './sandbox-selection';
import { getCloudSessionCreationOperation } from './types';

const vercelLarge = getSandboxAllocationRequest('vercel-large');
const byocLarge = {
  provider: { id: 'vercel', account: 'byoc' },
  instanceType: 'large',
} satisfies SelectableSandboxAllocationRequest;
const draft: SandboxSelectionDraft = {
  organizationId: 'organization-a',
  allocation: vercelLarge,
};
const capabilities: SandboxSelectionCapabilities = {
  enabled: true,
  options: [{ allocation: structuredClone(vercelLarge), available: true }],
};
const input = {
  organizationId: 'organization-a',
  draft,
  capabilities,
  devcontainer: false,
};

describe('formatSandboxDestination', () => {
  it.each([
    [undefined, 'Default'],
    [
      getSandboxAllocationRequest('cloudflare-single'),
      'Kilo · Cloudflare · 2 vCPU / 6 GiB · Single',
    ],
    [
      getSandboxAllocationRequest('cloudflare-shared'),
      'Kilo · Cloudflare · 4 vCPU / 12 GiB · Shared',
    ],
    [
      getSandboxAllocationRequest('isolated-standard'),
      'Kilo · Cloudflare · 4 vCPU / 12 GiB · Dedicated Standard',
    ],
    [getSandboxAllocationRequest('vercel-small'), 'Kilo · Vercel · 2 vCPU / 4 GiB'],
    [vercelLarge, 'Kilo · Vercel · 4 vCPU / 8 GiB'],
    [byocLarge, 'BYOC · Vercel · 4 vCPU / 8 GiB'],
    [{ ...byocLarge, instanceType: 'small' }, 'BYOC · Vercel · 2 vCPU / 4 GiB'],
    [
      { provider: { id: 'cloudflare', account: 'kilo' }, instanceType: 'devcontainer' },
      'Kilo · Cloudflare · 2 vCPU / 6 GiB · Dev container',
    ],
    [
      { provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' },
      'Kilo · Vercel · Provider default',
    ],
  ] satisfies Array<[SandboxDestination | undefined, string]>)(
    'formats %j as %s',
    (destination, label) => {
      expect(formatSandboxDestination(destination)).toBe(label);
    }
  );
});

describe('formatSandboxInstance', () => {
  it.each([
    [getSandboxAllocationRequest('cloudflare-single'), '2 vCPU / 6 GiB · Single'],
    [getSandboxAllocationRequest('cloudflare-shared'), '4 vCPU / 12 GiB · Shared'],
    [getSandboxAllocationRequest('vercel-small'), '2 vCPU / 4 GiB'],
    [byocLarge, '4 vCPU / 8 GiB'],
    [{ provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' }, 'Provider default'],
  ] satisfies Array<[SandboxDestination, string]>)(
    'formats an instance without repeating its account/provider headers: %j',
    (destination, label) => {
      expect(formatSandboxInstance(destination)).toBe(label);
    }
  );
});

describe('getSandboxSelectionGroups', () => {
  it('groups accounts and providers without changing instance order or availability', () => {
    const options: SandboxSelectionCapabilities['options'] = [
      { allocation: vercelLarge, available: true },
      { allocation: byocLarge, available: false, reason: 'Account unavailable' },
      { allocation: getSandboxAllocationRequest('cloudflare-single'), available: true },
      { allocation: getSandboxAllocationRequest('cloudflare-shared'), available: true },
      { allocation: { ...byocLarge, instanceType: 'small' }, available: true },
    ];
    const original = structuredClone(options);
    const groups = getSandboxSelectionGroups(
      getSandboxSelectionOptions({ enabled: true, options })
    );
    expect(groups).toEqual([
      {
        account: 'byoc',
        label: 'BYOC',
        providers: [{ id: 'vercel', label: 'Vercel', options: [options[1], options[4]] }],
      },
      {
        account: 'kilo',
        label: 'Kilo',
        providers: [
          { id: 'cloudflare', label: 'Cloudflare', options: [options[2], options[3]] },
          { id: 'vercel', label: 'Vercel', options: [options[0]] },
        ],
      },
    ]);
    expect(groups[0].providers[0].options[0]).toBe(options[1]);
    expect(options).toEqual(original);
  });

  it('does not render empty account or provider groups', () => {
    expect(getSandboxSelectionGroups([])).toEqual([]);
    expect(getSandboxSelectionGroups(getSandboxSelectionOptions(capabilities))).toEqual([
      {
        account: 'kilo',
        label: 'Kilo',
        providers: [{ id: 'vercel', label: 'Vercel', options: capabilities.options }],
      },
    ]);
  });

  it('retains a missing selected destination in its unavailable account/provider group', () => {
    expect(getSandboxSelectionGroups(getSandboxSelectionOptions(undefined, byocLarge))).toEqual([
      {
        account: 'byoc',
        label: 'BYOC',
        providers: [
          {
            id: 'vercel',
            label: 'Vercel',
            options: [
              {
                allocation: byocLarge,
                available: false,
                reason: 'Unavailable for this organization',
              },
            ],
          },
        ],
      },
    ]);
  });
});

describe('getSandboxSelectionOptions', () => {
  it('places supplied BYOC destinations before Kilo without changing capability order', () => {
    const options: SandboxSelectionCapabilities['options'] = [
      { allocation: vercelLarge, available: true },
      { allocation: byocLarge, available: false, reason: 'Account unavailable' },
      { allocation: getSandboxAllocationRequest('cloudflare-shared'), available: true },
      { allocation: { ...byocLarge, instanceType: 'small' }, available: true },
    ];
    const originalOrder = [...options];
    expect(getSandboxSelectionOptions({ enabled: true, options })).toEqual([
      options[1],
      options[3],
      options[0],
      options[2],
    ]);
    expect(options).toEqual(originalOrder);
  });

  it('does not invent BYOC options when the Worker only offers Kilo', () => {
    expect(getSandboxSelectionOptions(capabilities)).toEqual(capabilities.options);
    expect(getSandboxSelectionOptions(undefined)).toEqual([]);
    expect(getSandboxSelectionOptions({ enabled: false, options: [] })).toEqual([]);
  });

  it('matches descriptor values without duplicating a selection after refetch', () => {
    expect(capabilities.options[0].allocation).not.toBe(vercelLarge);
    expect(getSandboxSelectionOptions(capabilities, vercelLarge)).toEqual(capabilities.options);
  });

  it.each([undefined, capabilities, { enabled: false, options: [] }])(
    'keeps a missing BYOC selection visible but unavailable: %j',
    capabilities => {
      const options = getSandboxSelectionOptions(capabilities, byocLarge);
      expect(options[0]).toEqual({
        allocation: byocLarge,
        available: false,
        reason: 'Unavailable for this organization',
      });
      expect(getSandboxAllocationKey(byocLarge)).not.toBe(getSandboxAllocationKey(vercelLarge));
    }
  );
});

describe('resolveSandboxSelection', () => {
  it('forwards the original draft when an equal descriptor is available in its organization', () => {
    expect(resolveSandboxSelection(input)).toEqual({ sandboxAllocation: vercelLarge });
    expect(resolveSandboxSelection(input).sandboxAllocation).toBe(draft.allocation);
  });

  it.each(['organization-b', undefined])(
    'omits a previous organization preset in context %s',
    organizationId => {
      expect(resolveSandboxSelection({ ...input, organizationId })).toEqual({});
    }
  );

  it('uses Default with dev containers without changing the draft', () => {
    expect(resolveSandboxSelection({ ...input, devcontainer: true })).toEqual({});
    expect(draft.allocation).toEqual(vercelLarge);
    expect(resolveSandboxSelection(input)).toEqual({ sandboxAllocation: vercelLarge });
  });

  it.each([
    getSandboxAllocationRequest('cloudflare-shared'),
    getSandboxAllocationRequest('vercel-large'),
    { provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' },
    { provider: { id: 'cloudflare', account: 'kilo' }, instanceType: 'devcontainer' },
  ] satisfies SandboxDestination[])(
    'does not submit the resolved Default destination: %j',
    defaultDestination => {
      expect(
        resolveSandboxSelection({
          ...input,
          draft: { organizationId: input.organizationId },
          capabilities: { ...capabilities, defaultDestination },
        })
      ).toEqual({});
    }
  );

  it('does not substitute a Kilo destination for an unavailable BYOC draft', () => {
    expect(
      resolveSandboxSelection({ ...input, draft: { ...draft, allocation: byocLarge } })
    ).toEqual({ sandboxAllocation: byocLarge, error: expect.any(String) });
  });

  it('preserves an available BYOC destination without converting its account', () => {
    expect(
      resolveSandboxSelection({
        ...input,
        draft: { ...draft, allocation: byocLarge },
        capabilities: {
          enabled: true,
          options: [{ allocation: structuredClone(byocLarge), available: true }],
        },
      })
    ).toEqual({ sandboxAllocation: byocLarge });
  });

  it.each([undefined, { enabled: false, options: [] }])(
    'allows Default when capabilities are unavailable: %j',
    capabilities => {
      expect(
        resolveSandboxSelection({
          ...input,
          draft: { organizationId: input.organizationId },
          capabilities,
        })
      ).toEqual({});
    }
  );

  it.each([undefined, { enabled: false, options: [] }])(
    'blocks an explicit choice without silently switching to Default: %j',
    capabilities => {
      expect(resolveSandboxSelection({ ...input, capabilities })).toEqual({
        sandboxAllocation: vercelLarge,
        error: expect.stringContaining('choose Default'),
      });
    }
  );

  it('preserves an unavailable preset and reports the Worker reason', () => {
    expect(
      resolveSandboxSelection({
        ...input,
        capabilities: {
          enabled: true,
          options: [{ allocation: vercelLarge, available: false, reason: 'Vercel is unavailable' }],
        },
      })
    ).toEqual({ sandboxAllocation: vercelLarge, error: 'Vercel is unavailable' });
  });

  it('blocks a preset missing from the allowed options', () => {
    expect(
      resolveSandboxSelection({ ...input, capabilities: { enabled: true, options: [] } })
    ).toEqual({ sandboxAllocation: vercelLarge, error: expect.any(String) });
  });
});

describe('resolveSandboxSelectionSubmissionError', () => {
  const creation = {
    organizationId: draft.organizationId,
    sandboxAllocation: getSandboxAllocationKey(vercelLarge),
    prompt: 'Build the feature',
    model: 'test-model',
    repository: 'acme/repo',
    githubIntegrationId: 'integration-a',
    attachments: { path: 'upload', files: ['notes.md'] },
  };
  const intent = JSON.stringify(creation);
  const pendingOperation = { intent, operationKey: 'original-operation' };
  const unavailableCapabilities: Array<SandboxSelectionCapabilities | undefined> = [
    undefined,
    { enabled: false, options: [] },
    {
      enabled: true,
      options: [{ allocation: vercelLarge, available: false, reason: 'Vercel is unavailable' }],
    },
  ];

  it.each(unavailableCapabilities)(
    'allows an unchanged pending operation after availability changes: %j',
    capabilities => {
      const { error } = resolveSandboxSelection({ ...input, capabilities });
      expect(error).toBeDefined();
      expect(
        resolveSandboxSelectionSubmissionError({ error, intent, pendingOperation })
      ).toBeUndefined();
      const createOperationKey = jest.fn(() => 'new-operation');
      expect(getCloudSessionCreationOperation(pendingOperation, intent, createOperationKey)).toBe(
        pendingOperation
      );
      expect(createOperationKey).not.toHaveBeenCalled();
      expect(
        resolveSandboxSelectionSubmissionError({ error, intent, pendingOperation: null })
      ).toBe(error);
    }
  );

  it('reuses the pending operation when descriptor keys are reordered', () => {
    const allocation = {
      instanceType: vercelLarge.instanceType,
      provider: { account: vercelLarge.provider.account, id: vercelLarge.provider.id },
    };
    expect(JSON.stringify(allocation)).not.toBe(JSON.stringify(vercelLarge));
    const { sandboxAllocation, error } = resolveSandboxSelection({
      ...input,
      draft: { ...draft, allocation },
      capabilities: undefined,
    });
    const retryIntent = JSON.stringify({
      ...creation,
      sandboxAllocation: sandboxAllocation ? getSandboxAllocationKey(sandboxAllocation) : undefined,
    });
    expect(retryIntent).toBe(intent);
    expect(error).toBeDefined();
    expect(
      resolveSandboxSelectionSubmissionError({ error, intent: retryIntent, pendingOperation })
    ).toBeUndefined();
    const createOperationKey = jest.fn(() => 'new-operation');
    expect(
      getCloudSessionCreationOperation(pendingOperation, retryIntent, createOperationKey)
    ).toBe(pendingOperation);
    expect(createOperationKey).not.toHaveBeenCalled();
  });

  it.each([
    { prompt: 'A different prompt' },
    { model: 'another-model' },
    { repository: 'acme/other-repo' },
    { githubIntegrationId: 'integration-b' },
    { organizationId: 'organization-b' },
    { sandboxAllocation: getSandboxAllocationKey(getSandboxAllocationRequest('vercel-small')) },
    {
      sandboxAllocation: getSandboxAllocationKey(getSandboxAllocationRequest('cloudflare-single')),
    },
    { sandboxAllocation: getSandboxAllocationKey(byocLarge) },
    { sandboxAllocation: undefined },
    { devcontainer: true },
    { attachments: { path: 'upload', files: ['other-notes.md'] } },
  ])('does not bypass validation for a changed creation intent: %j', change => {
    const { error } = resolveSandboxSelection({ ...input, capabilities: undefined });
    expect(
      resolveSandboxSelectionSubmissionError({
        error,
        intent: JSON.stringify({ ...creation, ...change }),
        pendingOperation,
      })
    ).toBe(error);
  });

  it('does not block an available new selection', () => {
    const { error } = resolveSandboxSelection(input);
    expect(
      resolveSandboxSelectionSubmissionError({ error, intent, pendingOperation: null })
    ).toBeUndefined();
  });
});
