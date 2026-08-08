import { describe, expect, it } from 'vitest';

import { modelSelectorBadges } from './model-selector-badges';

function cliCatalogOption(overrides: { hasUserByokAvailable?: boolean } = {}) {
  return { id: 'remote-model-0', showGatewayMetadata: false, ...overrides };
}

function gatewayOption(overrides: { hasUserByokAvailable?: boolean; isFree?: boolean } = {}) {
  return { id: 'anthropic/claude', showGatewayMetadata: true, ...overrides };
}

describe('modelSelectorBadges', () => {
  it('shows BYOK for a CLI-catalog option with user BYOK available', () => {
    const badges = modelSelectorBadges(cliCatalogOption({ hasUserByokAvailable: true }));
    expect(badges.byok).toBe(true);
    expect(badges.free).toBe(false);
    expect(badges.collectsData).toBe(false);
  });

  it('hides BYOK for a CLI-catalog option without the flag', () => {
    const badges = modelSelectorBadges(cliCatalogOption());
    expect(badges.byok).toBe(false);
    expect(badges.free).toBe(false);
    expect(badges.collectsData).toBe(false);
  });

  it('keeps free and data-collection suppressed for CLI-catalog options with the flag', () => {
    const badges = modelSelectorBadges({
      id: 'remote-model-0',
      showGatewayMetadata: false,
      isFree: true,
      mayTrainOnYourPrompts: true,
      hasUserByokAvailable: true,
    });
    expect(badges.byok).toBe(true);
    expect(badges.free).toBe(false);
    expect(badges.collectsData).toBe(false);
  });

  it('keeps BYOK gating for gateway options with the flag', () => {
    const badges = modelSelectorBadges(gatewayOption({ hasUserByokAvailable: true }));
    expect(badges.byok).toBe(true);
    expect(badges.free).toBe(false);
  });

  it('keeps free gating for gateway options without the BYOK flag', () => {
    const badges = modelSelectorBadges(gatewayOption({ isFree: true }));
    expect(badges.free).toBe(true);
    expect(badges.byok).toBe(false);
  });

  it('shows no badges for an undefined option', () => {
    const badges = modelSelectorBadges(undefined);
    expect(badges.byok).toBe(false);
    expect(badges.free).toBe(false);
    expect(badges.collectsData).toBe(false);
  });
});
