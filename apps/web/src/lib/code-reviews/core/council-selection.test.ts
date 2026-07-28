import { describe, expect, it } from '@jest/globals';
import { COUNCIL_SPECIALIST_PRESETS } from '@kilocode/worker-utils/code-review-council';
import {
  buildCouncilSpecialists,
  councilSelectionsFromConfig,
  countEnabledSelections,
  defaultCouncilSelections,
} from './council-selection';

describe('council-selection', () => {
  it('defaults every preset enabled on the default model/effort', () => {
    const selections = defaultCouncilSelections();
    expect(Object.keys(selections).sort()).toEqual(
      COUNCIL_SPECIALIST_PRESETS.map(p => p.id).sort()
    );
    expect(countEnabledSelections(selections)).toBe(COUNCIL_SPECIALIST_PRESETS.length);
    for (const preset of COUNCIL_SPECIALIST_PRESETS) {
      expect(selections[preset.id]).toEqual({
        enabled: true,
        modelSlug: null,
        thinkingEffort: null,
      });
    }
  });

  it('builds only enabled specialists, carrying per-specialist model/effort (default omitted)', () => {
    const selections = defaultCouncilSelections();
    // Disable everything except security (custom model) and performance (default model).
    for (const id of Object.keys(selections)) selections[id].enabled = false;
    selections.security = { enabled: true, modelSlug: 'anthropic/x', thinkingEffort: 'high' };
    selections.performance = { enabled: true, modelSlug: null, thinkingEffort: null };

    const specialists = buildCouncilSpecialists(selections);
    expect(specialists.map(s => s.id)).toEqual(['security', 'performance']);
    expect(specialists[0]).toMatchObject({
      id: 'security',
      enabled: true,
      required: false,
      model_slug: 'anthropic/x',
      thinking_effort: 'high',
    });
    // Default model/effort are omitted, not persisted as null-model.
    expect(specialists[1].model_slug).toBeUndefined();
    expect(specialists[1].thinking_effort).toBeUndefined();
  });

  it('councilSelectionsFromConfig round-trips a saved config back into picker state', () => {
    const selections = defaultCouncilSelections();
    for (const id of Object.keys(selections)) selections[id].enabled = false;
    selections.security = { enabled: true, modelSlug: 'anthropic/x', thinkingEffort: 'high' };
    selections.testing = { enabled: true, modelSlug: null, thinkingEffort: null };

    const council = {
      enabled: true,
      aggregation_strategy: 'unanimous' as const,
      specialists: buildCouncilSpecialists(selections),
    };
    const hydrated = councilSelectionsFromConfig(council);

    // Enabled presets come back with their saved model/effort; absent ones are disabled.
    expect(hydrated.security).toEqual({
      enabled: true,
      modelSlug: 'anthropic/x',
      thinkingEffort: 'high',
    });
    expect(hydrated.testing).toEqual({ enabled: true, modelSlug: null, thinkingEffort: null });
    expect(hydrated.performance.enabled).toBe(false);
    expect(hydrated.correctness.enabled).toBe(false);
    // Re-building from the hydrated selections reproduces the same specialist ids.
    expect(buildCouncilSpecialists(hydrated).map(s => s.id)).toEqual(['security', 'testing']);
  });

  it('councilSelectionsFromConfig disables everything for a null/empty config', () => {
    const hydrated = councilSelectionsFromConfig(null);
    expect(countEnabledSelections(hydrated)).toBe(0);
    expect(Object.keys(hydrated).sort()).toEqual(COUNCIL_SPECIALIST_PRESETS.map(p => p.id).sort());
  });
});
