import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { SUPPORTED_LANGUAGES } from '@/i18n/languages';
import { providerLabelKey } from '@/lib/integrations/provider-catalog';

import { repositoryActionAccessibleLabel } from './repository-card-actions';
import { PROVIDER_COPY } from './repository-provider-copy';

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
        providerPhrase: 'Connect Bitbucket',
      })
    ).toBe('Connect Bitbucket');
  });

  it('keeps a label that already names the provider', () => {
    expect(
      repositoryActionAccessibleLabel({
        action: 'Open GitHub',
        provider: 'GitHub',
        providerPhrase: 'Open GitHub',
      })
    ).toBe('Open GitHub');
    expect(
      repositoryActionAccessibleLabel({
        action: 'Connect GitLab',
        provider: 'GitLab',
        providerPhrase: 'Connect GitLab',
      })
    ).toBe('Connect GitLab');
  });

  it('finds the provider inside a declined or suffixed name', () => {
    expect(
      repositoryActionAccessibleLabel({
        action: 'GitHub-u qoş',
        provider: 'GitHub',
        providerPhrase: 'GitHub-u qoş',
      })
    ).toBe('GitHub-u qoş');
    expect(
      repositoryActionAccessibleLabel({
        action: 'Bitbucketን አገናኝ',
        provider: 'Bitbucket',
        providerPhrase: 'Bitbucketን አገናኝ',
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
          const phrase = t(PROVIDER_COPY[platform].connectTitle);
          // A provider whose own connect phrase lost the brand would make the
          // name below skip it, so the phrase must name the provider itself.
          const phraseMentions =
            phrase.toLocaleLowerCase().split(provider.toLocaleLowerCase()).length - 1;
          expect(phraseMentions, `${language} ${platform} connectTitle ${phrase}`).toBe(1);
          const label = repositoryActionAccessibleLabel({
            action,
            provider,
            providerPhrase: phrase,
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

  describe('phrase from the catalog', () => {
    afterEach(async () => {
      await i18n.changeLanguage('en');
    });

    it('names a bare-verb action the way the catalog writes the brand', async () => {
      // A sentence joiner split the name where the language puts the brand
      // first ("Bitbucket जोड़ें") or closes it with a sentence stop, so the
      // phrase the name uses is the provider's own catalog connect phrase.
      for (const tag of ['hi', 'ar']) {
        await i18n.changeLanguage(tag); // eslint-disable-line no-await-in-loop -- one catalog at a time mirrors the runtime switch
        const t = i18n.getFixedT(tag);
        const action = t('common.connect');
        const label = repositoryActionAccessibleLabel({
          action,
          provider: 'Bitbucket',
          providerPhrase: t(PROVIDER_COPY.bitbucket.connectTitle),
        });
        expect(label, tag).toBe(t('common.connectBitbucket'));
        expect(label, tag).not.toContain(t('common.sentenceJoiner'));
      }
    });
  });
});
