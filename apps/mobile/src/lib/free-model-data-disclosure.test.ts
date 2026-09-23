import { describe, expect, it } from 'vitest';
import {
  BYOK_MODEL_LABEL,
  freeModelDataLabel,
  freeModelFreeLabel,
  getFreeModelDataAccessibilityLabel,
  hasUserByokAvailable,
  isFreeModelOption,
  mayTrainOnYourPrompts,
  modelNameStatesFree,
} from './free-model-data-disclosure';

describe('free model data disclosure', () => {
  it('uses the disclosure label expected in model pickers', () => {
    expect(BYOK_MODEL_LABEL).toBe('BYOK');
    expect(freeModelDataLabel()).toBe('Data collected');
    expect(freeModelFreeLabel()).toBe('Free');
  });

  it('detects explicit and known free model options', () => {
    expect(isFreeModelOption({ id: 'anthropic/claude', isFree: true })).toBe(true);
    expect(isFreeModelOption({ id: 'openrouter/free', isFree: true })).toBe(true);
    expect(isFreeModelOption({ id: 'openrouter/free' })).toBe(false);
    expect(isFreeModelOption({ id: 'openrouter/model-alpha' })).toBe(false);
    expect(isFreeModelOption({ id: 'anthropic/claude' })).toBe(false);
  });

  it('detects training eligibility independently of freeness', () => {
    expect(
      mayTrainOnYourPrompts({
        id: 'paid-training-model',
        isFree: false,
        mayTrainOnYourPrompts: true,
      })
    ).toBe(true);
    expect(
      mayTrainOnYourPrompts({
        id: 'free-private-model',
        isFree: true,
        mayTrainOnYourPrompts: false,
      })
    ).toBe(false);
    expect(mayTrainOnYourPrompts({ id: 'free-model', isFree: true })).toBe(false);
  });

  it('detects only explicit user BYOK availability', () => {
    expect(
      hasUserByokAvailable({
        id: 'anthropic/claude',
        hasUserByokAvailable: true,
      })
    ).toBe(true);
    expect(
      hasUserByokAvailable({
        id: 'anthropic/claude',
        hasUserByokAvailable: false,
      })
    ).toBe(false);
    expect(hasUserByokAvailable({ id: 'anthropic/claude' })).toBe(false);
  });

  it('detects a displayed name that already states the model is free', () => {
    expect(modelNameStatesFree('Laguna S 2.1 (free)')).toBe(true);
    expect(modelNameStatesFree('Nemotron 3 Ultra (free)')).toBe(true);
    expect(modelNameStatesFree('Auto Free')).toBe(true);
    expect(modelNameStatesFree('Laguna S 2.1')).toBe(false);
    expect(modelNameStatesFree('Auto Efficient')).toBe(false);
  });

  it('states free from the free Auto model identity even when the name does not', () => {
    // Nine catalogs name the Auto Free model with a free word the free badge's
    // own label does not literally contain (ru "Авто Бесплатный" vs
    // "Бесплатно"), so the model's identity decides, not a substring of copy.
    expect(modelNameStatesFree('Авто Бесплатный', 'kilo-auto/free')).toBe(true);
    expect(modelNameStatesFree('Авто Бесплатный', 'kilocode/kilo-auto/free')).toBe(true);
    expect(modelNameStatesFree('Auto Efficient', 'kilo-auto/efficient')).toBe(false);
  });

  it('adds a data collection phrase to accessibility labels', () => {
    expect(getFreeModelDataAccessibilityLabel('Kilo Auto')).toBe('Kilo Auto, Data collected');
  });
});
