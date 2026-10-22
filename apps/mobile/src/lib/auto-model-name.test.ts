import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { autoModelLabel, modelLabelFromCatalogue } from './auto-model-name';

describe('autoModelLabel', () => {
  it('names a Kilo Auto model from the catalog, not the backend name', () => {
    expect(autoModelLabel('kilo-auto/efficient', 'Auto Efficient')).toBe(
      i18n.t('models.auto.efficient')
    );
  });

  it('resolves every Auto model the composer can show', () => {
    const ids = [
      'kilo-auto/frontier',
      'kilo-auto/balanced',
      'kilo-auto/efficient',
      'kilo-auto/small',
      'kilo-auto/free',
      'kilo-auto/org',
    ];
    for (const id of ids) {
      expect(autoModelLabel(id, 'backend name'), id).not.toBe('backend name');
    }
  });

  it('strips the KiloClaw model prefix before the lookup', () => {
    expect(autoModelLabel('kilocode/kilo-auto/balanced', 'Auto Balanced')).toBe(
      i18n.t('models.auto.balanced')
    );
  });

  it('keeps the catalog name for a model the catalog does not name', () => {
    expect(autoModelLabel('anthropic/claude-sonnet-4', 'Claude Sonnet 4')).toBe('Claude Sonnet 4');
  });
});

describe('modelLabelFromCatalogue', () => {
  const catalogue = [
    { id: 'kilo-auto/efficient', name: 'Auto Efficient' },
    { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
  ];

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('localizes an Auto model the catalogue carries', async () => {
    await i18n.changeLanguage('de');

    expect(modelLabelFromCatalogue(catalogue, 'kilo-auto/efficient')).toBe(
      i18n.t('models.auto.efficient')
    );
    expect(modelLabelFromCatalogue(catalogue, 'kilo-auto/efficient')).not.toBe('Auto Efficient');
  });

  it('localizes a stored Auto model the catalogue dropped', async () => {
    await i18n.changeLanguage('de');

    expect(modelLabelFromCatalogue(catalogue, 'kilo-auto/small', 'Auto Small')).toBe(
      'Auto Klein'
    );
  });

  it('names a third-party model from the catalogue entry', () => {
    expect(modelLabelFromCatalogue(catalogue, 'anthropic/claude-sonnet-4')).toBe(
      'Claude Sonnet 4'
    );
  });

  it('falls back to the stored name, then the id, for a model the catalogue lacks', () => {
    expect(modelLabelFromCatalogue(catalogue, 'openai/gpt-5', 'GPT-5')).toBe('GPT-5');
    expect(modelLabelFromCatalogue(catalogue, 'openai/gpt-5')).toBe('openai/gpt-5');
  });
});
