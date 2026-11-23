import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { providerKeyName } from './provider-key-name';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('providerKeyName', () => {
  it('translates a descriptive provider name in the app language', async () => {
    await i18n.changeLanguage('pt-BR');

    // The legacy key's server name is a fixed English sentence. The row shows
    // the catalog's own name for it, which the row's sentence then wraps.
    const name = providerKeyName('codestral', 'Legacy Codestral-only key');
    expect(name).toBe(i18n.t('profile.providerKeys.names.codestral'));
    expect(name).not.toContain(' key');
  });

  it('keeps a brand name as the server sent it', () => {
    expect(providerKeyName('deepseek', 'DeepSeek')).toBe('DeepSeek');
  });

  it('drops the credential noun from a server name the table does not hold', () => {
    expect(providerKeyName('some-retired-provider', 'Acme API key')).toBe('Acme API');
  });

  it('resolves the ChatGPT connection under its stored provider id', () => {
    expect(providerKeyName('openai-chatgpt', 'openai-chatgpt')).toBe(
      i18n.t('profile.providerKeys.names.openaiChatgpt')
    );
  });
});
