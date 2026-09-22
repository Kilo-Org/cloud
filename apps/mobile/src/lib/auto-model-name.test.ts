import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { autoModelLabel } from './auto-model-name';

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
