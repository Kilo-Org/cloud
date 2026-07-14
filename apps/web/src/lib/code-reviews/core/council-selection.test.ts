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

  it('round-trips a persisted config back into selections', () => {
    const selections = defaultCouncilSelections();
    for (const id of Object.keys(selections)) selections[id].enabled = false;
    selections.security = { enabled: true, modelSlug: 'anthropic/x', thinkingEffort: 'high' };
    selections.testing = { enabled: true, modelSlug: null, thinkingEffort: null };

    const round = councilSelectionsFromConfig({
      enabled: true,
      aggregation_strategy: 'any_blocking_member',
      specialists: buildCouncilSpecialists(selections),
    });
    expect(round.security).toEqual({
      enabled: true,
      modelSlug: 'anthropic/x',
      thinkingEffort: 'high',
    });
    expect(round.testing).toEqual({ enabled: true, modelSlug: null, thinkingEffort: null });
    // Presets absent from the config are shown disabled.
    expect(round.performance.enabled).toBe(false);
  });

  it('returns all-enabled defaults when there is no config', () => {
    expect(councilSelectionsFromConfig(null)).toEqual(defaultCouncilSelections());
  });
});
