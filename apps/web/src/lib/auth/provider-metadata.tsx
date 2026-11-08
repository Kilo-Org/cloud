import { AppleLogo } from '@/components/auth/AppleLogo';
import { AnacondaLogo } from '@/components/auth/AnacondaLogo';
import { DiscordLogo } from '@/components/auth/DiscordLogo';
import { GitHubLogo } from '@/components/auth/GitHubLogo';
import { GitLabLogo } from '@/components/auth/GitLabLogo';
import { GoogleLogo } from '@/components/auth/GoogleLogo';
import { LinkedInLogo } from '@/components/auth/LinkedInLogo';
import { OpenAILogo } from '@/components/auth/OpenAILogo';
import { ClaudeLogo } from '@/components/auth/ClaudeLogo';
import { KeyRound, Mail, SquareUserRound } from 'lucide-react';
import React, { type JSX } from 'react';
import * as z from 'zod';

type ProviderMetadata = Readonly<{
  id: string;
  name: string;
  icon: JSX.Element;
  signInLabel?: string;
}>;

const fakeLoginIcon = (
  <span role="img" aria-label="Test account">
    🧪
  </span>
);

// Single source of truth: array of all authentication providers with full metadata.
const AllAuthProviders = [
  { id: 'anaconda', name: 'Anaconda', icon: <AnacondaLogo /> },
  { id: 'email', name: 'Email', icon: <Mail /> },
  { id: 'apple', name: 'Apple', icon: <AppleLogo /> },
  { id: 'google', name: 'Google', icon: <GoogleLogo /> },
  { id: 'github', name: 'GitHub', icon: <GitHubLogo /> },
  { id: 'gitlab', name: 'GitLab', icon: <GitLabLogo className="size-5" /> },
  { id: 'linkedin', name: 'LinkedIn', icon: <LinkedInLogo /> },
  { id: 'discord', name: 'Discord', icon: <DiscordLogo /> },
  {
    id: 'openai',
    name: 'ChatGPT',
    signInLabel: 'Continue with ChatGPT',
    icon: <OpenAILogo />,
  },
  {
    id: 'claude',
    name: 'Claude',
    signInLabel: 'Continue with Claude',
    icon: <ClaudeLogo />,
  },
  { id: 'fake-login', name: 'Test Account', icon: fakeLoginIcon },
  { id: 'workos', name: 'Enterprise SSO', icon: <SquareUserRound /> },
  // Passkeys are not an OAuth account to link or unlink: they are listed and
  // managed by the passkey settings UI, so `isLinkableAuthProvider` excludes
  // this id. The metadata entry is what lets the shared provider-id union
  // (`AuthProviderId`) resolve a passkey name and icon.
  { id: 'passkey', name: 'Passkey', icon: <KeyRound /> },
] as const satisfies readonly ProviderMetadata[];

const AuthProviderIds = AllAuthProviders.map(p => p.id);
export const AuthProviderIdSchema = z.enum(AuthProviderIds);
import type { AuthProviderId } from '@kilocode/db/schema-types';

// Subset offered for OAuth sign-in: every provider except SSO, email, passkeys
// and the dev-only one. Claude is listed here, and the offering surfaces drop it
// until it is launched (`withLaunchedClaudeSignIn`).
const isLinkableAuthProvider = (p: ProviderMetadata) =>
  p.id !== 'workos' && p.id !== 'fake-login' && p.id !== 'email' && p.id !== 'passkey';

export const LinkableAuthProviders = [...AllAuthProviders.filter(isLinkableAuthProvider)] as const;
export const OAuthProviderIds = [...LinkableAuthProviders.map(p => p.id)] as const;
export const ProdNonSSOAuthProviders = [...LinkableAuthProviders.map(p => p.id), 'email'] as const;

// Providers whose callback does not carry the web session that started an
// account link: the link requires that session, and Apple's callback is a
// cross-site form POST. They stay sign-in methods only. This is the single
// declaration of the exclusion; the offered list and the link start both read
// what it produces.
const LinkSessionUnavailableProviderIds = ['apple'] as const satisfies readonly AuthProviderId[];

// The providers a person may start an account link for. Every link start reads
// this list, not only the `/connected-accounts` offer: the organization BYOK
// card and the shared-services ChatGPT connect start a link through the same
// predicate.
export const AccountLinkingProviders = [
  ...LinkableAuthProviders.filter(p => !LinkSessionUnavailableProviderIds.some(id => id === p.id)),
] as const;

const AccountLinkingProviderIds = new Set<string>(AccountLinkingProviders.map(p => p.id));

/** Whether a person may start an account link for `provider`. */
export const isAccountLinkingProvider = (provider: AuthProviderId): boolean =>
  AccountLinkingProviderIds.has(provider);

// All auth methods (excludes fake-login, used for sign-in hints)
// This is the same as all providers except fake-login
const isAuthMethod = (p: ProviderMetadata) => p.id !== 'fake-login';
export const AllAuthMethodIds = [...AllAuthProviders.filter(isAuthMethod).map(p => p.id)] as const;
export type AuthMethod = (typeof AllAuthMethodIds)[number];

const byId = Object.fromEntries(AllAuthProviders.map(p => [p.id, p]));
export const getProviderById = (provider: AuthProviderId): ProviderMetadata => byId[provider];
