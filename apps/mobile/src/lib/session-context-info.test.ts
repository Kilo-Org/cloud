import { describe, expect, it } from 'vitest';
import { type ContextUsage } from 'cloud-agent-sdk/context-usage';

import { type SessionModelOption } from './hooks/use-session-model-options';
import { resolveSessionContextInfo } from './session-context-info';

function gatewayOption(partial: {
  id: string;
  contextWindow?: number;
  unavailable?: boolean;
}): SessionModelOption {
  return {
    id: partial.id,
    name: partial.id,
    displayId: partial.id,
    variants: [],
    isPreferred: false,
    showGatewayMetadata: !partial.unavailable,
    ...(partial.unavailable ? { unavailable: true } : {}),
    ...(partial.contextWindow !== undefined ? { contextWindow: partial.contextWindow } : {}),
  };
}

function cliOption(partial: {
  providerID: string;
  modelID: string;
  contextWindow?: number;
  unavailable?: boolean;
}): SessionModelOption {
  return {
    id: `remote-model-${partial.providerID}-${partial.modelID}`,
    name: partial.modelID,
    displayId: partial.modelID,
    variants: [],
    isPreferred: false,
    showGatewayMetadata: false,
    provider: { id: partial.providerID, name: partial.providerID },
    modelRef: { providerID: partial.providerID, modelID: partial.modelID },
    overrideSource: 'cli-catalog',
    ...(partial.unavailable ? { unavailable: true } : {}),
    ...(partial.contextWindow !== undefined ? { contextWindow: partial.contextWindow } : {}),
  };
}

const kiloUsage: ContextUsage = {
  contextTokens: 32_418,
  providerID: 'kilo',
  modelID: 'anthropic/claude-sonnet-4',
};

const remoteUsage: ContextUsage = {
  contextTokens: 1024,
  providerID: 'anthropic-local',
  modelID: 'shared/model',
};

describe('resolveSessionContextInfo', () => {
  it('returns undefined when there is no context usage', () => {
    expect(resolveSessionContextInfo(undefined, [])).toBeUndefined();
  });

  it('resolves a kilo Gateway response by exact modelID', () => {
    const result = resolveSessionContextInfo(kiloUsage, [
      gatewayOption({ id: 'anthropic/claude-sonnet-4', contextWindow: 200_000 }),
      gatewayOption({ id: 'other/model', contextWindow: 8000 }),
    ]);

    expect(result).toEqual({
      contextTokens: 32_418,
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
      contextWindow: 200_000,
      percentage: 16,
    });
  });

  it('resolves a remote CLI response by exact providerID + modelID', () => {
    const result = resolveSessionContextInfo(remoteUsage, [
      cliOption({ providerID: 'anthropic-local', modelID: 'shared/model', contextWindow: 200_000 }),
      cliOption({ providerID: 'custom-openai', modelID: 'shared/model', contextWindow: 32_000 }),
    ]);

    expect(result).toEqual({
      contextTokens: 1024,
      providerID: 'anthropic-local',
      modelID: 'shared/model',
      contextWindow: 200_000,
      percentage: 1,
    });
  });

  it('resolves a remote CLI response with a kilo-named CLI provider', () => {
    const result = resolveSessionContextInfo(
      { ...kiloUsage, providerID: 'kilo', modelID: 'cli-kilo-model' },
      [
        cliOption({ providerID: 'kilo', modelID: 'cli-kilo-model', contextWindow: 500_000 }),
        gatewayOption({ id: 'gateway/model', contextWindow: 100_000 }),
      ]
    );

    expect(result?.contextWindow).toBe(500_000);
  });

  it('returns undefined when a kilo usage is missing from Gateway options', () => {
    const result = resolveSessionContextInfo(kiloUsage, [
      gatewayOption({ id: 'other/model', contextWindow: 8000 }),
    ]);

    expect(result).toEqual({
      contextTokens: 32_418,
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
      contextWindow: undefined,
      percentage: undefined,
    });
  });

  it('returns undefined when a non-kilo usage has no matching CLI catalog', () => {
    const result = resolveSessionContextInfo(remoteUsage, [
      cliOption({ providerID: 'custom-openai', modelID: 'shared/model', contextWindow: 32_000 }),
    ]);

    expect(result?.contextWindow).toBeUndefined();
    expect(result?.percentage).toBeUndefined();
  });

  it('ignores options without a resolved contextWindow', () => {
    const result = resolveSessionContextInfo(kiloUsage, [
      gatewayOption({ id: 'anthropic/claude-sonnet-4' }),
    ]);

    expect(result?.contextWindow).toBeUndefined();
  });

  it('ignores unavailable options even when their modelRef matches', () => {
    const result = resolveSessionContextInfo({ ...kiloUsage, modelID: 'gone/model' }, [
      gatewayOption({ id: 'gone/model', contextWindow: 100_000, unavailable: true }),
    ]);

    expect(result?.contextWindow).toBeUndefined();
  });

  it('returns undefined for invalid (zero/negative/NaN) contextWindow values', () => {
    const zero = resolveSessionContextInfo(kiloUsage, [
      gatewayOption({ id: 'anthropic/claude-sonnet-4', contextWindow: 0 }),
    ]);
    const negative = resolveSessionContextInfo(kiloUsage, [
      gatewayOption({ id: 'anthropic/claude-sonnet-4', contextWindow: -1 }),
    ]);
    const nan = resolveSessionContextInfo(kiloUsage, [
      gatewayOption({ id: 'anthropic/claude-sonnet-4', contextWindow: Number.NaN }),
    ]);
    const infinite = resolveSessionContextInfo(kiloUsage, [
      gatewayOption({ id: 'anthropic/claude-sonnet-4', contextWindow: Number.POSITIVE_INFINITY }),
    ]);

    expect(zero?.contextWindow).toBeUndefined();
    expect(negative?.contextWindow).toBeUndefined();
    expect(nan?.contextWindow).toBeUndefined();
    expect(infinite?.contextWindow).toBeUndefined();
  });

  it('blacklists conflicting duplicate kilo modelIDs rather than picking arbitrarily', () => {
    const result = resolveSessionContextInfo(kiloUsage, [
      gatewayOption({ id: 'anthropic/claude-sonnet-4', contextWindow: 200_000 }),
      gatewayOption({ id: 'anthropic/claude-sonnet-4', contextWindow: 80_000 }),
    ]);

    expect(result?.contextWindow).toBeUndefined();
  });

  it('keeps agreeing duplicate kilo modelIDs', () => {
    const result = resolveSessionContextInfo(kiloUsage, [
      gatewayOption({ id: 'anthropic/claude-sonnet-4', contextWindow: 200_000 }),
      gatewayOption({ id: 'anthropic/claude-sonnet-4', contextWindow: 200_000 }),
    ]);

    expect(result?.contextWindow).toBe(200_000);
  });

  it('blacklists conflicting duplicate provider+model identities across CLI rows', () => {
    const result = resolveSessionContextInfo(remoteUsage, [
      cliOption({ providerID: 'anthropic-local', modelID: 'shared/model', contextWindow: 200_000 }),
      cliOption({ providerID: 'anthropic-local', modelID: 'shared/model', contextWindow: 32_000 }),
      cliOption({ providerID: 'custom-openai', modelID: 'shared/model', contextWindow: 32_000 }),
    ]);

    expect(result?.contextWindow).toBeUndefined();
  });

  it('keeps conflicting CLI identities distinct across providers', () => {
    const result = resolveSessionContextInfo(remoteUsage, [
      cliOption({ providerID: 'anthropic-local', modelID: 'shared/model', contextWindow: 200_000 }),
      cliOption({ providerID: 'custom-openai', modelID: 'shared/model', contextWindow: 32_000 }),
    ]);

    expect(result?.contextWindow).toBe(200_000);
  });

  it('does not infer a non-kilo response from a Gateway catalog', () => {
    const result = resolveSessionContextInfo(remoteUsage, [
      gatewayOption({ id: 'shared/model', contextWindow: 200_000 }),
    ]);

    expect(result?.contextWindow).toBeUndefined();
  });

  it('preserves the runtime contextTokens, providerID, and modelID when unresolved', () => {
    const result = resolveSessionContextInfo(kiloUsage, []);

    expect(result).toEqual({
      contextTokens: 32_418,
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
      contextWindow: undefined,
      percentage: undefined,
    });
  });
});
