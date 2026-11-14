import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import { SSH_ERROR_CODES } from '../../../modules/kilo-ssh/src/ReactNativeSsh.types';
import en from '@/i18n/locales/en.json';

import { SSH_ERROR_POLICY } from './error-policy';
import { forwardErrorMessage, transferErrorMessage } from './files/error-copy';
import { closeReasonMessage } from './session/phase-copy';
import { isRetryableReason } from './session/types';

describe('SSH error policy', () => {
  it('provides translated copy for every native error category', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    for (const category of SSH_ERROR_CODES) {
      const { key } = SSH_ERROR_POLICY[category];
      expect(i18n.exists(key), category).toBe(true);
      expect(closeReasonMessage(i18n.t, category), category).toBe(i18n.t(key));
      expect(isRetryableReason(category), category).toBe(
        ['Network', 'Timeout', 'ChannelClosed'].includes(category)
      );
    }
  });

  it('explains output limits without offering a retry', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    const copy = i18n.t('ssh.errors.outputLimit');
    expect(copy).toContain('Redirect it to a file or narrow it');
    expect(transferErrorMessage(i18n.t, 'OutputLimit')).toBe(copy);
    expect(forwardErrorMessage(i18n.t, 'OutputLimit')).toBe(copy);
    expect(isRetryableReason('OutputLimit')).toBe(false);
  });
});
