import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { severityCountPhrase } from './severity-count-phrase';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('severityCountPhrase', () => {
  it('agrees every pt-BR bucket with its own number', async () => {
    await i18n.changeLanguage('pt-BR');

    expect(severityCountPhrase('repoOpen', 1)).toBe('1 aberta');
    expect(severityCountPhrase('repoOpen', 2)).toBe('2 abertas');
    expect(severityCountPhrase('repoCritical', 1)).toBe('1 crítica');
    expect(severityCountPhrase('repoCritical', 4)).toBe('4 críticas');
    expect(severityCountPhrase('repoHigh', 1)).toBe('1 alta');
    expect(severityCountPhrase('breakdownCritical', 1)).toBe('1 crítico');
    expect(severityCountPhrase('breakdownCritical', 0)).toBe('0 críticos');
    expect(severityCountPhrase('breakdownMediumLow', 1)).toBe('1 média/baixa');
    expect(severityCountPhrase('breakdownMediumLow', 3)).toBe('3 médias e baixas');
  });

  it('keeps the bucket whose wording the count does not change', async () => {
    await i18n.changeLanguage('pt-BR');

    expect(severityCountPhrase('breakdownHigh', 1)).toBe('1 de nível alto');
    expect(severityCountPhrase('breakdownHigh', 5)).toBe('5 de nível alto');
  });

  it('formats the number in the active language', async () => {
    await i18n.changeLanguage('pt-BR');

    expect(severityCountPhrase('breakdownCritical', 1000)).toBe('1.000 críticos');
  });

  it('reads the same at every count in a catalog whose words do not inflect', async () => {
    await i18n.changeLanguage('de');

    expect(severityCountPhrase('repoCritical', 1)).toBe('1 kritisch');
    expect(severityCountPhrase('repoCritical', 5)).toBe('5 kritisch');
  });
});
