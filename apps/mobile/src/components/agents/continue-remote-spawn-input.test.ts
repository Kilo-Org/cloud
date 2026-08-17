import { describe, expect, it, vi } from 'vitest';

import {
  type InstanceModelCatalogResult,
  type RemoteModelCatalogV1,
} from '@kilocode/cloud-agent-sdk/instance-model-catalog';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { buildContinueRemoteSpawnInput, resolveContinueRemoteSelection } from './continuation-seed';

vi.mock('@/components/ui/icons', () => ({
  Bug: 'Bug',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  NotebookPen: 'NotebookPen',
  Workflow: 'Workflow',
}));

const GATEWAY_OPTION: SessionModelOption = {
  id: 'gateway-model-a',
  name: 'Gateway Model A',
  displayId: 'gateway-model-a',
  variants: ['v1', 'v2'],
  isPreferred: true,
  showGatewayMetadata: true,
};

const CLI_OPTION: SessionModelOption = {
  id: 'remote-model-0',
  name: 'Claude from CLI',
  displayId: 'anthropic/claude-x',
  variants: ['low', 'high'],
  isPreferred: false,
  provider: { id: 'anthropic', name: 'Anthropic' },
  modelRef: { providerID: 'anthropic', modelID: 'claude-x' },
  overrideSource: 'cli-catalog',
  showGatewayMetadata: false,
};

const OPTIONS: SessionModelOption[] = [GATEWAY_OPTION, CLI_OPTION];

const CATALOG: RemoteModelCatalogV1 = {
  protocolVersion: 1,
  providers: [
    {
      id: 'kilo',
      name: 'Kilo',
      models: [
        {
          id: 'gateway-model-a',
          variants: ['v1', 'v2'],
          capabilities: { attachment: true, reasoning: true },
          limits: { context: 200_000, output: 32_000 },
        },
      ],
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: [
        {
          id: 'claude-x',
          variants: ['low', 'high'],
          capabilities: { attachment: true, reasoning: true },
          limits: { context: 200_000, output: 32_000 },
        },
      ],
    },
  ],
  truncated: false,
};

function catalogWithoutAnthropic(): RemoteModelCatalogV1 {
  return {
    ...CATALOG,
    providers: CATALOG.providers.filter(provider => provider.id !== 'anthropic'),
  };
}

function catalogWithTargetVariants(variants: string[]): RemoteModelCatalogV1 {
  return {
    ...CATALOG,
    providers: CATALOG.providers.map(provider =>
      provider.id === 'anthropic'
        ? {
            ...provider,
            models: provider.models.map(model => ({ ...model, variants })),
          }
        : provider
    ),
  };
}

describe('resolveContinueRemoteSelection', () => {
  it('returns undefined for a model that is not in the source options', () => {
    expect(
      resolveContinueRemoteSelection({
        model: 'model-unknown',
        variant: 'v1',
        options: OPTIONS,
        catalog: null,
      })
    ).toBeUndefined();
  });

  it('returns undefined when the variant is not offered by the source option', () => {
    expect(
      resolveContinueRemoteSelection({
        model: 'gateway-model-a',
        variant: 'v99',
        options: OPTIONS,
        catalog: null,
      })
    ).toBeUndefined();
  });

  it('returns the kilo selection for a gateway option when no catalog exists', () => {
    expect(
      resolveContinueRemoteSelection({
        model: 'gateway-model-a',
        variant: 'v1',
        options: OPTIONS,
        catalog: null,
      })
    ).toEqual({
      model: { providerID: 'kilo', modelID: 'gateway-model-a' },
      variant: 'v1',
    });
  });

  it('returns the selection without a variant when the stored variant is empty', () => {
    expect(
      resolveContinueRemoteSelection({
        model: 'gateway-model-a',
        variant: '',
        options: OPTIONS,
        catalog: null,
      })
    ).toEqual({ model: { providerID: 'kilo', modelID: 'gateway-model-a' } });
  });

  it('returns the CLI-catalog selection when the target catalog has the model', () => {
    expect(
      resolveContinueRemoteSelection({
        model: 'remote-model-0',
        variant: 'low',
        options: OPTIONS,
        catalog: CATALOG,
      })
    ).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude-x' },
      variant: 'low',
    });
  });

  it('returns undefined when the target catalog lacks the CLI-catalog provider', () => {
    expect(
      resolveContinueRemoteSelection({
        model: 'remote-model-0',
        variant: 'low',
        options: OPTIONS,
        catalog: catalogWithoutAnthropic(),
      })
    ).toBeUndefined();
  });

  it('returns undefined for a non-kilo option when no catalog exists', () => {
    expect(
      resolveContinueRemoteSelection({
        model: 'remote-model-0',
        variant: 'low',
        options: OPTIONS,
        catalog: null,
      })
    ).toBeUndefined();
  });

  it('returns undefined when the variant is absent from the target catalog model', () => {
    expect(
      resolveContinueRemoteSelection({
        model: 'remote-model-0',
        variant: 'low',
        options: OPTIONS,
        catalog: catalogWithTargetVariants(['high']),
      })
    ).toBeUndefined();
  });
});

describe('buildContinueRemoteSpawnInput', () => {
  const baseInput = {
    mode: 'code',
    options: OPTIONS,
    organizationId: undefined as string | undefined,
  };

  it('sends a validated non-kilo selection with its variant', () => {
    const result = buildContinueRemoteSpawnInput({
      ...baseInput,
      model: 'remote-model-0',
      variant: 'low',
      catalogResult: { ok: true, catalog: CATALOG },
    });
    expect(result).toEqual({
      agent: 'code',
      model: { providerID: 'anthropic', modelID: 'claude-x', variant: 'low' },
    });
  });

  it('omits the model on an unsupported (old CLI) catalog read', () => {
    const result = buildContinueRemoteSpawnInput({
      ...baseInput,
      model: 'remote-model-0',
      variant: 'low',
      catalogResult: { ok: false, reason: 'unsupported' },
    });
    expect(result).toEqual({ agent: 'code' });
  });

  it('omits the model on a transport catalog failure', () => {
    const result = buildContinueRemoteSpawnInput({
      ...baseInput,
      model: 'remote-model-0',
      variant: 'low',
      catalogResult: { ok: false, reason: 'transport' },
    });
    expect(result).toEqual({ agent: 'code' });
  });

  it('keeps today wire for a kilo gateway option when no catalog is available', () => {
    const result = buildContinueRemoteSpawnInput({
      ...baseInput,
      model: 'gateway-model-a',
      variant: 'v1',
      catalogResult: { ok: false, reason: 'unsupported' },
    });
    expect(result).toEqual({
      agent: 'code',
      model: { providerID: 'kilo', modelID: 'gateway-model-a', variant: 'v1' },
    });
  });

  it('treats a parsed catalog with no models as no catalog', () => {
    const emptyCatalogResult: InstanceModelCatalogResult = {
      ok: true,
      catalog: { protocolVersion: 1, providers: [], truncated: false },
    };
    const result = buildContinueRemoteSpawnInput({
      ...baseInput,
      model: 'remote-model-0',
      variant: 'low',
      catalogResult: emptyCatalogResult,
    });
    expect(result).toEqual({ agent: 'code' });
  });

  it('keeps today wire for a kilo gateway option when a parsed catalog has no models', () => {
    const emptyCatalogResult: InstanceModelCatalogResult = {
      ok: true,
      catalog: { protocolVersion: 1, providers: [], truncated: false },
    };
    const result = buildContinueRemoteSpawnInput({
      ...baseInput,
      model: 'gateway-model-a',
      variant: 'v1',
      catalogResult: emptyCatalogResult,
    });
    expect(result).toEqual({
      agent: 'code',
      model: { providerID: 'kilo', modelID: 'gateway-model-a', variant: 'v1' },
    });
  });

  it('carries the organization id through', () => {
    const result = buildContinueRemoteSpawnInput({
      mode: 'code',
      model: 'gateway-model-a',
      variant: 'v1',
      options: OPTIONS,
      catalogResult: { ok: false, reason: 'unsupported' },
      organizationId: 'org-1',
    });
    expect(result).toEqual({
      agent: 'code',
      model: { providerID: 'kilo', modelID: 'gateway-model-a', variant: 'v1' },
      orgId: 'org-1',
    });
  });
});
