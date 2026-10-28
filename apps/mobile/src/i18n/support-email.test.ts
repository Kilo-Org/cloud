import { SUPPORT_EMAIL } from '@kilocode/app-shared/support';
import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from './index';

const SUPPORT_COPY_KEYS = [
  'kiloclaw.onboarding.provisioning.stalledBody',
  'kiloclaw.accessRequired.iosContact',
  'codeReviewer.actionRequired.githubIpAllowList.description',
  'codeReviewer.actionRequired.repeatedRepositoryCloneTimeout.description',
] as const;

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('support email interpolation', () => {
  it('renders the shared address in English without a caller-provided variable', () => {
    for (const key of SUPPORT_COPY_KEYS) {
      const rendered = i18n.t(key, { name: 'Claw' });
      expect(rendered).toContain(SUPPORT_EMAIL);
      expect(rendered).not.toContain('{{');
    }
  });

  it('renders the shared address after lazily loading German', async () => {
    expect(i18n.hasResourceBundle('de', 'translation')).toBe(false);

    await i18n.changeLanguage('de');

    expect(i18n.hasResourceBundle('de', 'translation')).toBe(true);
    expect(i18n.t('kiloclaw.accessRequired.iosContact')).toBe(
      `Fragen? Schreibe an ${SUPPORT_EMAIL}.`
    );
    for (const key of SUPPORT_COPY_KEYS) {
      const rendered = i18n.t(key, { name: 'Claw' });
      expect(rendered).toContain(SUPPORT_EMAIL);
      expect(rendered).not.toContain('{{');
    }
  });
});
