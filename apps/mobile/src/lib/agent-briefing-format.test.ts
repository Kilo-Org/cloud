import { describe, expect, it } from 'vitest';

import { briefingMoney } from './agent-briefing-format';

describe('briefingMoney', () => {
  it('uses the currency precision and the active language separators', () => {
    expect(briefingMoney(182_000, 'pt-BR')).toBe('US$\u00A00,18');
    expect(briefingMoney(122_000, 'pt-BR')).toBe('US$\u00A00,12');
    expect(briefingMoney(182_000, 'en-US')).toBe('$0.18');
    expect(briefingMoney(182_000, 'de')).toBe('0,18\u00A0$');
  });

  it('marks an amount below the smallest currency unit instead of rounding it to zero', () => {
    expect(briefingMoney(1800, 'pt-BR')).toBe('< US$\u00A00,01');
    expect(briefingMoney(1800, 'en-US')).toBe('< $0.01');
  });

  it('keeps a zero amount at the currency precision', () => {
    expect(briefingMoney(0, 'pt-BR')).toBe('US$\u00A00,00');
    expect(briefingMoney(0, 'en-US')).toBe('$0.00');
  });
});
