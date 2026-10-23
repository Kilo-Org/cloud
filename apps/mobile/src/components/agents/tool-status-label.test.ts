import { type TFunction } from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { TOOL_STATUS_LABEL_KEY, toolStatusLabel } from './tool-status-label';

const t = i18n.t as TFunction;

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('toolStatusLabel', () => {
  it.each([
    ['pending', 'common.pending', 'Függőben'],
    ['running', 'common.running', 'Fut'],
    ['completed', 'common.completed', 'Befejezve'],
    ['error', 'common.failed', 'Sikertelen'],
  ] as const)('announces %s in the reader’s language', async (status, key, hungarian) => {
    await i18n.changeLanguage('hu');

    expect(TOOL_STATUS_LABEL_KEY[status]).toBe(key);
    expect(toolStatusLabel(t, status)).toBe(hungarian);
    expect(toolStatusLabel(t, status)).not.toBe(status);
  });

  it('an error is announced with the failed wording, not the wire word', async () => {
    await i18n.changeLanguage('en');

    expect(toolStatusLabel(t, 'error')).toBe(t('common.failed'));
    expect(toolStatusLabel(t, 'error')).not.toBe('error');
  });
});
