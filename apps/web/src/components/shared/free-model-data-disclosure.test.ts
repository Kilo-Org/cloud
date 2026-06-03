import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import {
  FREE_MODEL_DATA_LABEL,
  FREE_MODEL_FREE_LABEL,
  getFreeModelDataTooltip,
  isFreeModelOption,
} from './free-model-data-disclosure';

describe('free model data disclosure', () => {
  it('uses the disclosure label expected in model pickers', () => {
    expect(FREE_MODEL_DATA_LABEL).toBe('Data collected');
    expect(FREE_MODEL_FREE_LABEL).toBe('Free');
  });

  it('detects explicit and known free model options', () => {
    expect(isFreeModelOption({ id: 'anthropic/claude', isFree: true })).toBe(true);
    expect(isFreeModelOption({ id: 'openrouter/free', isFree: true })).toBe(true);
    expect(isFreeModelOption({ id: 'openrouter/free' })).toBe(false);
    expect(isFreeModelOption({ id: 'openrouter/model-alpha' })).toBe(false);
    expect(isFreeModelOption({ id: 'anthropic/claude' })).toBe(false);
  });

  it('uses the short disclosure text as tooltip content', () => {
    expect(getFreeModelDataTooltip()).toBe('Data collected');
  });

  it('uses the brain circuit icon in model combobox disclosures', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/components/shared/ModelCombobox.tsx'),
      'utf8'
    );

    expect(source).toContain('BrainCircuit');
    expect(source).not.toContain('AlertTriangle');
  });
});
