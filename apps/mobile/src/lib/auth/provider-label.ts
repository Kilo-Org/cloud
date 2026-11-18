import { i18n } from '@/i18n';

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
} as const;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

/** A sign-in provider id as the person knows it, in the active language; an unknown id passes through. */
export function providerLabel(provider: string): string {
  const key = lookup(PROVIDER_LABEL_KEYS, provider);
  return key ? i18n.t(key) : provider;
}
