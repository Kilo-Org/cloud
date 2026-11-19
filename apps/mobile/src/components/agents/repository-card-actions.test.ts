import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { SUPPORTED_LANGUAGES } from '@/i18n/languages';
import { providerLabelKey } from '@/lib/integrations/provider-catalog';

import { repositoryActionAccessibleLabel } from './repository-card-actions';

// The row renders through native widgets the Node project cannot load, and the
// helper under test is pure: stubs keep the module graph out of React Native.
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({
  ExternalLink: 'ExternalLink',
  RefreshCw: 'RefreshCw',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000' }),
}));

/** Every label the repository card's action shows, with its provider. */
const rowLabels = [
  { platform: 'github', key: 'agentChat.newSession.openGithub' },
  { platform: 'gitlab', key: 'agentChat.newSession.openGitlab' },
  { platform: 'bitbucket', key: 'common.connect' },
  { platform: 'github', key: 'common.connectGithub' },
  { platform: 'gitlab', key: 'common.connectGitlab' },
  { platform: 'bitbucket', key: 'common.connectBitbucket' },
] as const;

describe('repositoryActionAccessibleLabel', () => {
  it('names the provider when the visible label is a bare verb', () => {
    expect(
      repositoryActionAccessibleLabel({
        action: 'Connect',
        provider: 'Bitbucket',
        joiner: '. ',
      })
    ).toBe('Connect. Bitbucket');
  });

  it('keeps a label that already names the provider', () => {
    expect(
      repositoryActionAccessibleLabel({ action: 'Open GitHub', provider: 'GitHub', joiner: '. ' })
    ).toBe('Open GitHub');
    expect(
      repositoryActionAccessibleLabel({
        action: 'Connect GitLab',
        provider: 'GitLab',
        joiner: '. ',
      })
    ).toBe('Connect GitLab');
  });

  it('finds the provider inside a declined or suffixed name', () => {
    expect(
      repositoryActionAccessibleLabel({ action: 'GitHub-u qoş', provider: 'GitHub', joiner: '. ' })
    ).toBe('GitHub-u qoş');
    expect(
      repositoryActionAccessibleLabel({
        action: 'Bitbucketን አገናኝ',
        provider: 'Bitbucket',
        joiner: '. ',
      })
    ).toBe('Bitbucketን አገናኝ');
  });

  describe('every supported language', () => {
    afterEach(async () => {
      await i18n.changeLanguage('en');
    });

    it('names the provider exactly once for every label the row shows', async () => {
      expect(SUPPORTED_LANGUAGES.length).toBeGreaterThan(50);
      for (const language of SUPPORTED_LANGUAGES) {
        await i18n.changeLanguage(language); // eslint-disable-line no-await-in-loop -- one catalog at a time mirrors the runtime switch
        const t = i18n.getFixedT(language);
        for (const { platform, key } of rowLabels) {
          const where = `${language} ${platform} ${key}`;
          const provider = t(providerLabelKey(platform));
          const action = t(key);
          const label = repositoryActionAccessibleLabel({
            action,
            provider,
            joiner: t('common.sentenceJoiner'),
          });
          expect(label, where).not.toBe('');
          // The brands are not translated, so a case-insensitive count finds
          // every mention a screen reader would repeat.
          const mentions = label.toLocaleLowerCase().split(provider.toLocaleLowerCase()).length - 1;
          expect(mentions, where).toBe(1);
        }
      }
    });
  });
});
