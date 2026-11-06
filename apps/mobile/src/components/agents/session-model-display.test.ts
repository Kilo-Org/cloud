import { describe, expect, it } from 'vitest';

import {
  friendlyModelName,
  resolveModelProviderName,
  resolveSelectionModelDisplay,
} from './session-model-display';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

/**
 * F2 — friendly model name + provider resolution.
 *
 * Mirrors the `contextModelAndProvider` lookup in session-detail-content:
 * - catalog match via `modelRef` (providerID + modelID)
 * - kilo-auto gateway match via `option.id` when `showGatewayMetadata` is set
 * - otherwise: cleaned raw modelID (date suffix strip)
 */
describe('friendlyModelName', () => {
  const catalogOption: SessionModelOption = {
    id: 'anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    displayId: 'claude-sonnet-4',
    variants: [],
    isPreferred: false,
    showGatewayMetadata: false,
    provider: { id: 'anthropic', name: 'Anthropic' },
    modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
  };

  const kiloAutoOption: SessionModelOption = {
    id: 'kilo-auto/efficient',
    name: 'Kilo Auto (efficient)',
    displayId: 'kilo-auto/efficient',
    variants: [],
    isPreferred: true,
    showGatewayMetadata: true,
    provider: { id: 'kilo', name: 'Kilo' },
  };

  it('returns the catalog name on a modelRef match', () => {
    expect(friendlyModelName('anthropic', 'claude-sonnet-4', [catalogOption, kiloAutoOption])).toBe(
      'Claude Sonnet 4'
    );
  });

  it('returns the catalog name on the kilo-auto option.id match', () => {
    expect(friendlyModelName('kilo', 'kilo-auto/efficient', [catalogOption, kiloAutoOption])).toBe(
      'Kilo Auto (efficient)'
    );
  });

  it('strips a trailing -YYYYMMDD date suffix when unresolvable', () => {
    expect(friendlyModelName('kilo', 'claude-sonnet-4-20260101', [kiloAutoOption])).toBe(
      'claude-sonnet-4'
    );
  });

  it('strips a trailing -YYYY-MM-DD date suffix when unresolvable', () => {
    expect(friendlyModelName('kilo', 'claude-sonnet-4-2026-01-15', [kiloAutoOption])).toBe(
      'claude-sonnet-4'
    );
  });

  it('does not strip a non-date suffix that happens to look similar', () => {
    // 6 digits is not a date pattern (8 digits) and not YYYY-MM-DD.
    expect(friendlyModelName('kilo', 'claude-sonnet-4-123456', [kiloAutoOption])).toBe(
      'claude-sonnet-4-123456'
    );
  });

  it('returns the original modelID when stripping would produce an empty result', () => {
    // A modelID that is purely a date suffix should not become blank.
    expect(friendlyModelName('kilo', '-20260101', [kiloAutoOption])).toBe('-20260101');
  });

  it('returns the original modelID on an empty cleaned result for a bare date id', () => {
    expect(friendlyModelName('kilo', '20260101', [kiloAutoOption])).toBe('20260101');
  });

  it('strips the date suffix when the id is unresolvable and no options match', () => {
    expect(friendlyModelName('kilo', 'claude-sonnet-4-20260101', [])).toBe('claude-sonnet-4');
  });
});

describe('resolveModelProviderName', () => {
  it('returns the catalog provider name on a match', () => {
    const option: SessionModelOption = {
      id: 'anthropic/claude-sonnet-4',
      name: 'Claude Sonnet 4',
      displayId: 'claude-sonnet-4',
      variants: [],
      isPreferred: false,
      showGatewayMetadata: false,
      provider: { id: 'anthropic', name: 'Anthropic' },
      modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
    };
    expect(resolveModelProviderName('anthropic', 'claude-sonnet-4', [option])).toBe('Anthropic');
  });

  it("returns 'Kilo' for the kilo provider on no match", () => {
    expect(resolveModelProviderName('kilo', 'unmapped', [])).toBe('Kilo');
  });

  it('returns the raw providerID for non-kilo providers on no match', () => {
    expect(resolveModelProviderName('openrouter', 'unmapped', [])).toBe('openrouter');
  });
});

describe('resolveSelectionModelDisplay', () => {
  const cliRow: SessionModelOption = {
    id: 'remote-model-0',
    name: 'Claude Sonnet 4',
    displayId: 'claude-sonnet-4',
    variants: [],
    isPreferred: false,
    showGatewayMetadata: false,
    provider: { id: 'anthropic', name: 'Anthropic' },
    modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
  };

  const gatewayRow: SessionModelOption = {
    id: 'deepseek/deepseek-flash',
    name: 'DeepSeek Flash',
    displayId: 'deepseek/deepseek-flash',
    variants: [],
    isPreferred: false,
    showGatewayMetadata: true,
  };

  it('names a CLI catalogue row by its selection id', () => {
    expect(resolveSelectionModelDisplay('remote-model-0', [cliRow, gatewayRow])).toEqual({
      model: 'Claude Sonnet 4',
      provider: 'Anthropic',
    });
  });

  it('names a gateway row and its Kilo provider', () => {
    expect(resolveSelectionModelDisplay('deepseek/deepseek-flash', [cliRow, gatewayRow])).toEqual({
      model: 'DeepSeek Flash',
      provider: 'Kilo',
    });
  });

  it('returns empty strings for a selection no row carries', () => {
    expect(resolveSelectionModelDisplay('remote-model-9', [cliRow, gatewayRow])).toEqual({
      model: '',
      provider: '',
    });
  });

  it('returns empty strings for an empty selection', () => {
    expect(resolveSelectionModelDisplay('', [cliRow, gatewayRow])).toEqual({
      model: '',
      provider: '',
    });
  });

  it('names the unavailable placeholder row and leaves its unknown provider empty', () => {
    const placeholder: SessionModelOption = {
      id: 'remote-session-model',
      name: 'Session model',
      displayId: '',
      variants: [],
      isPreferred: false,
      showGatewayMetadata: false,
      unavailable: true,
    };
    expect(resolveSelectionModelDisplay('remote-session-model', [placeholder])).toEqual({
      model: 'Session model',
      provider: '',
    });
  });

  it('names an unavailable row whose catalog lost the model by its reference', () => {
    const unavailable: SessionModelOption = {
      id: 'remote-unavailable-model',
      name: 'deepseek v4.1 flash 1017',
      displayId: 'deepseek/deepseek-v4.1-flash-1017',
      variants: [],
      isPreferred: false,
      showGatewayMetadata: false,
      provider: { id: 'kilo', name: 'kilo' },
      modelRef: { providerID: 'kilo', modelID: 'deepseek/deepseek-v4.1-flash-1017' },
      unavailable: true,
    };
    expect(resolveSelectionModelDisplay('remote-unavailable-model', [unavailable])).toEqual({
      model: 'deepseek v4.1 flash 1017',
      provider: 'kilo',
    });
  });
});
