import { describe, expect, it, jest } from '@jest/globals';
import {
  getSandboxAllocationKey,
  getSandboxAllocationRequest,
  SELECTABLE_SANDBOX_ALLOCATIONS,
  type SandboxDestination,
  type SandboxSelectionCapabilities,
  type SelectableSandboxAllocationRequest,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  formatSandboxCapacity,
  formatSandboxDestination,
  formatSandboxDestinationWithoutTier,
  formatSandboxInstance,
  getPreferredInitialSandboxAllocation,
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
  options: [{ allocation: structuredClone(vercelLarge) }],
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
      'Kilo · Cloudflare · 2 vCPU / 6 GiB · Small',
    ],
    [
      getSandboxAllocationRequest('cloudflare-shared'),
      'Kilo · Cloudflare · 4 vCPU / 12 GiB · Large · Shared',
    ],
    [
      getSandboxAllocationRequest('cloudflare-containers-standard-3'),
      'Kilo · Cloudflare Containers · 2 vCPU / 8 GiB · Medium',
    ],
    [
      getSandboxAllocationRequest('cloudflare-containers-standard-4'),
      'Kilo · Cloudflare Containers · 4 vCPU / 12 GiB · Large',
    ],
    [
      getSandboxAllocationRequest('isolated-standard'),
      'Kilo · Cloudflare · 4 vCPU / 12 GiB · Large',
    ],
    [getSandboxAllocationRequest('vercel-small'), 'Kilo · Vercel · 2 vCPU / 4 GiB · Small'],
    [vercelLarge, 'Kilo · Vercel · 4 vCPU / 8 GiB · Medium'],
    [byocLarge, 'BYOC · Vercel · 4 vCPU / 8 GiB · Medium'],
    [{ ...byocLarge, instanceType: 'small' }, 'BYOC · Vercel · 2 vCPU / 4 GiB · Small'],
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

describe('formatSandboxDestinationWithoutTier', () => {
  it.each([
    [undefined, 'Default'],
    [getSandboxAllocationRequest('cloudflare-single'), 'Kilo · Cloudflare · 2 vCPU / 6 GiB'],
    [getSandboxAllocationRequest('cloudflare-shared'), 'Kilo · Cloudflare · 4 vCPU / 12 GiB'],
    [
      getSandboxAllocationRequest('cloudflare-containers-standard-3'),
      'Kilo · Cloudflare Containers · 2 vCPU / 8 GiB',
    ],
    [
      getSandboxAllocationRequest('cloudflare-containers-standard-4'),
      'Kilo · Cloudflare Containers · 4 vCPU / 12 GiB',
    ],
    [
      { provider: { id: 'cloudflare', account: 'kilo' }, instanceType: 'devcontainer' },
      'Kilo · Cloudflare · 2 vCPU / 6 GiB',
    ],
    [getSandboxAllocationRequest('vercel-small'), 'Kilo · Vercel · 2 vCPU / 4 GiB'],
    [byocLarge, 'BYOC · Vercel · 4 vCPU / 8 GiB'],
    [
      { provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' },
      'Kilo · Vercel · Provider default',
    ],
  ] satisfies Array<[SandboxDestination | undefined, string]>)(
    'states the account, provider and capacity without the tenancy tier: %j',
    (destination, label) => {
      expect(formatSandboxDestinationWithoutTier(destination)).toBe(label);
    }
  );

  it('keeps every selectable destination distinguishable while closed', () => {
    const labels = SELECTABLE_SANDBOX_ALLOCATIONS.map(allocation =>
      formatSandboxDestinationWithoutTier(getSandboxAllocationRequest(allocation))
    );
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('stays shorter than the expanded label wherever a tenancy tier exists', () => {
    const cloudflare = getSandboxAllocationRequest('cloudflare-single');
    expect(formatSandboxDestinationWithoutTier(cloudflare).length).toBeLessThan(
      formatSandboxDestination(cloudflare).length
    );
  });
});

describe('formatSandboxCapacity', () => {
  it.each([
    [getSandboxAllocationRequest('cloudflare-single'), '2 vCPU / 6 GiB'],
    [getSandboxAllocationRequest('cloudflare-shared'), '4 vCPU / 12 GiB'],
    [getSandboxAllocationRequest('cloudflare-containers-standard-3'), '2 vCPU / 8 GiB'],
    [getSandboxAllocationRequest('cloudflare-containers-standard-4'), '4 vCPU / 12 GiB'],
    [getSandboxAllocationRequest('isolated-standard'), '4 vCPU / 12 GiB'],
    [getSandboxAllocationRequest('vercel-small'), '2 vCPU / 4 GiB'],
    [byocLarge, '4 vCPU / 8 GiB'],
    [{ provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' }, 'Provider default'],
  ] satisfies Array<[SandboxDestination, string]>)(
    'reports the vCPU and memory a destination runs with: %j',
    (destination, label) => {
      expect(formatSandboxCapacity(destination)).toBe(label);
    }
  );
});

describe('formatSandboxInstance', () => {
  it.each([
    [getSandboxAllocationRequest('cloudflare-single'), '2 vCPU / 6 GiB · Small'],
    [getSandboxAllocationRequest('cloudflare-shared'), '4 vCPU / 12 GiB · Large · Shared'],
    [getSandboxAllocationRequest('cloudflare-containers-standard-3'), '2 vCPU / 8 GiB · Medium'],
    [getSandboxAllocationRequest('cloudflare-containers-standard-4'), '4 vCPU / 12 GiB · Large'],
    [getSandboxAllocationRequest('vercel-small'), '2 vCPU / 4 GiB · Small'],
    [byocLarge, '4 vCPU / 8 GiB · Medium'],
    [{ provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' }, 'Provider default'],
  ] satisfies Array<[SandboxDestination, string]>)(
    'formats an instance without repeating its account/provider heading: %j',
    (destination, label) => {
      expect(formatSandboxInstance(destination)).toBe(label);
    }
  );

  it('adds the tenancy tier that capacity alone cannot separate', () => {
    const shared = getSandboxAllocationRequest('cloudflare-shared');
    const dedicated = getSandboxAllocationRequest('isolated-standard');
    expect(formatSandboxCapacity(shared)).toBe(formatSandboxCapacity(dedicated));
    expect(formatSandboxInstance(shared)).not.toBe(formatSandboxInstance(dedicated));
  });
});

describe('getSandboxSelectionGroups', () => {
  it('builds one heading per account and provider without changing instance order', () => {
    const options: SandboxSelectionCapabilities['options'] = [
      { allocation: vercelLarge },
      { allocation: byocLarge },
      { allocation: getSandboxAllocationRequest('cloudflare-single') },
      { allocation: getSandboxAllocationRequest('cloudflare-shared') },
      { allocation: { ...byocLarge, instanceType: 'small' } },
    ];
    const original = structuredClone(options);
    const groups = getSandboxSelectionGroups(
      getSandboxSelectionOptions({ enabled: true, options })
    );
    expect(groups).toEqual([
      {
        key: 'byoc:vercel',
        label: 'BYOC · Vercel',
        options: [options[1], options[4]],
      },
      {
        key: 'kilo:cloudflare',
        label: 'Kilo · Cloudflare',
        options: [options[2], options[3]],
      },
      { key: 'kilo:vercel', label: 'Kilo · Vercel', options: [options[0]] },
    ]);
    expect(groups[0].options[0]).toBe(options[1]);
    expect(options).toEqual(original);
  });

  it('does not render empty provider groups', () => {
    expect(getSandboxSelectionGroups([])).toEqual([]);
    expect(getSandboxSelectionGroups(getSandboxSelectionOptions(capabilities))).toEqual([
      { key: 'kilo:vercel', label: 'Kilo · Vercel', options: capabilities.options },
    ]);
  });
});

describe('getSandboxSelectionOptions', () => {
  it('places BYOC before Kilo and gathers each provider without reordering instances', () => {
    const options: SandboxSelectionCapabilities['options'] = [
      { allocation: vercelLarge },
      { allocation: byocLarge },
      { allocation: getSandboxAllocationRequest('cloudflare-shared') },
      { allocation: { ...byocLarge, instanceType: 'small' } },
      { allocation: getSandboxAllocationRequest('vercel-small') },
      { allocation: getSandboxAllocationRequest('cloudflare-single') },
    ];
    const originalOrder = [...options];
    expect(getSandboxSelectionOptions({ enabled: true, options })).toEqual([
      options[1],
      options[3],
      options[2],
      options[5],
      options[0],
      options[4],
    ]);
    expect(options).toEqual(originalOrder);
  });

  it('does not invent BYOC options when the Worker only offers Kilo', () => {
    expect(getSandboxSelectionOptions(capabilities)).toEqual(capabilities.options);
    expect(getSandboxSelectionOptions(undefined)).toEqual([]);
    expect(getSandboxSelectionOptions({ enabled: false, options: [] })).toEqual([]);
  });
});

describe('resolveSandboxSelection', () => {
  it('forwards the original draft when an equal descriptor is available in its organization', () => {
    expect(resolveSandboxSelection(input)).toEqual({
      sandboxAllocation: vercelLarge,
    });
    expect(resolveSandboxSelection(input).sandboxAllocation).toBe(draft.allocation);
  });

  it('forwards a personal draft when selection is enabled', () => {
    expect(
      resolveSandboxSelection({
        organizationId: undefined,
        draft: { organizationId: undefined, allocation: vercelLarge },
        capabilities,
        devcontainer: false,
      })
    ).toEqual({ sandboxAllocation: vercelLarge });
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
    expect(resolveSandboxSelection(input)).toEqual({
      sandboxAllocation: vercelLarge,
    });
  });

  it.each([
    getSandboxAllocationRequest('cloudflare-shared'),
    getSandboxAllocationRequest('vercel-large'),
    { provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' },
    {
      provider: { id: 'cloudflare', account: 'kilo' },
      instanceType: 'devcontainer',
    },
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
      resolveSandboxSelection({
        ...input,
        draft: { ...draft, allocation: byocLarge },
      })
    ).toEqual({
      sandboxAllocation: byocLarge,
      error: 'This sandbox is unavailable. Choose another sandbox or Default.',
    });
  });

  it('preserves an available BYOC destination without converting its account', () => {
    expect(
      resolveSandboxSelection({
        ...input,
        draft: { ...draft, allocation: byocLarge },
        capabilities: {
          enabled: true,
          options: [{ allocation: structuredClone(byocLarge) }],
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

  it('blocks a preset missing from the allowed options', () => {
    expect(
      resolveSandboxSelection({
        ...input,
        capabilities: { enabled: true, options: [] },
      })
    ).toEqual({
      sandboxAllocation: vercelLarge,
      error: 'This sandbox is unavailable. Choose another sandbox or Default.',
    });
  });
});

describe('getPreferredInitialSandboxAllocation', () => {
  const options: SandboxSelectionCapabilities['options'] = [
    {
      allocation: getSandboxAllocationRequest('cloudflare-single'),
    },
    {
      allocation: getSandboxAllocationRequest('vercel-large'),
    },
    {
      allocation: getSandboxAllocationRequest('vercel-small'),
    },
  ];

  it('restores the matching destination', () => {
    expect(
      getPreferredInitialSandboxAllocation({
        options,
        lastUsedKey: getSandboxAllocationKey(getSandboxAllocationRequest('vercel-large')),
      })
    ).toEqual(vercelLarge);
  });

  it('restores nothing without a stored destination', () => {
    expect(getPreferredInitialSandboxAllocation({ options, lastUsedKey: null })).toBeUndefined();
  });

  it('ignores a stored destination that is no longer offered', () => {
    expect(
      getPreferredInitialSandboxAllocation({
        options,
        lastUsedKey: getSandboxAllocationKey(getSandboxAllocationRequest('cloudflare-shared')),
      })
    ).toBeUndefined();
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
    { enabled: true, options: [] },
  ];

  it.each(unavailableCapabilities)(
    'allows an unchanged pending operation after availability changes: %j',
    capabilities => {
      const { error } = resolveSandboxSelection({ ...input, capabilities });
      expect(error).toBeDefined();
      expect(
        resolveSandboxSelectionSubmissionError({
          error,
          intent,
          pendingOperation,
        })
      ).toBeUndefined();
      const createOperationKey = jest.fn(() => 'new-operation');
      expect(getCloudSessionCreationOperation(pendingOperation, intent, createOperationKey)).toBe(
        pendingOperation
      );
      expect(createOperationKey).not.toHaveBeenCalled();
      expect(
        resolveSandboxSelectionSubmissionError({
          error,
          intent,
          pendingOperation: null,
        })
      ).toBe(error);
    }
  );

  it('reuses the pending operation when descriptor keys are reordered', () => {
    const allocation = {
      instanceType: vercelLarge.instanceType,
      provider: {
        account: vercelLarge.provider.account,
        id: vercelLarge.provider.id,
      },
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
      resolveSandboxSelectionSubmissionError({
        error,
        intent: retryIntent,
        pendingOperation,
      })
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
    {
      sandboxAllocation: getSandboxAllocationKey(getSandboxAllocationRequest('vercel-small')),
    },
    {
      sandboxAllocation: getSandboxAllocationKey(getSandboxAllocationRequest('cloudflare-single')),
    },
    { sandboxAllocation: getSandboxAllocationKey(byocLarge) },
    { sandboxAllocation: undefined },
    { devcontainer: true },
    { attachments: { path: 'upload', files: ['other-notes.md'] } },
  ])('does not bypass validation for a changed creation intent: %j', change => {
    const { error } = resolveSandboxSelection({
      ...input,
      capabilities: undefined,
    });
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
      resolveSandboxSelectionSubmissionError({
        error,
        intent,
        pendingOperation: null,
      })
    ).toBeUndefined();
  });
});
