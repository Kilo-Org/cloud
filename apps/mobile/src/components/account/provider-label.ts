import { i18n } from '@/i18n';

/**
 * What a sign-in method is called on every surface that lists or names one.
 *
 * The names the catalogs already carry are reused rather than re-added: a
 * provider's label is one string, and a second copy of it is a second string to
 * keep in step. GitHub, GitLab and Email are the three the profile namespace did
 * not have yet.
 */
const PROVIDER_LABEL_KEYS = {
  anaconda: 'profile.providerAnaconda',
  apple: 'profile.providerApple',
  claude: 'profile.providerClaude',
  discord: 'profile.providerDiscord',
  email: 'common.email',
  'fake-login': 'profile.providerTestAccount',
  github: 'common.github',
  gitlab: 'common.gitlab',
  google: 'profile.providerGoogle',
  linkedin: 'profile.providerLinkedin',
  openai: 'profile.providerChatgpt',
  passkey: 'profile.passkeyDefaultName',
  workos: 'profile.providerEnterpriseSso',
} as const satisfies Record<string, string>;

export function providerLabel(provider: string): string {
  const key = PROVIDER_LABEL_KEYS[provider as keyof typeof PROVIDER_LABEL_KEYS];
  return key ? i18n.t(key) : provider;
}
