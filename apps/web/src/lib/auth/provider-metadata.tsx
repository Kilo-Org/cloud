import { AppleLogo } from '@/components/auth/AppleLogo';
import { DiscordLogo } from '@/components/auth/DiscordLogo';
import { GitHubLogo } from '@/components/auth/GitHubLogo';
import { GitLabLogo } from '@/components/auth/GitLabLogo';
import { GoogleLogo } from '@/components/auth/GoogleLogo';
import { LinkedInLogo } from '@/components/auth/LinkedInLogo';
import { Mail, SquareUserRound } from 'lucide-react';
import React, { type JSX } from 'react';
import * as z from 'zod';

type ProviderMetadata = Readonly<{ id: string; name: string; icon: JSX.Element }>;

const fakeLoginIcon = (
  <span role="img" aria-label="Test account">
    🧪
  </span>
);

// Single source of truth: array of all authentication providers with full metadata.
const AllAuthProviders = [
  { id: 'email', name: 'Email', icon: <Mail /> },
  { id: 'apple', name: 'Apple', icon: <AppleLogo /> },
  { id: 'google', name: 'Google', icon: <GoogleLogo /> },
  { id: 'github', name: 'GitHub', icon: <GitHubLogo /> },
  { id: 'gitlab', name: 'GitLab', icon: <GitLabLogo className="size-5" /> },
  { id: 'linkedin', name: 'LinkedIn', icon: <LinkedInLogo /> },
  { id: 'discord', name: 'Discord', icon: <DiscordLogo /> },
  { id: 'fake-login', name: 'Test Account', icon: fakeLoginIcon },
  { id: 'workos', name: 'Enterprise SSO', icon: <SquareUserRound /> },
] as const satisfies readonly ProviderMetadata[];

const AuthProviderIds = AllAuthProviders.map(p => p.id);
export const AuthProviderIdSchema = z.enum(AuthProviderIds);
export type { AuthProviderId } from '@kilocode/db/schema-types';
import type { AuthProviderId } from '@kilocode/db/schema-types';

// Subset used for account linking (excludes SSO, email, and dev-only providers).
const isLinkableAuthProvider = (p: ProviderMetadata) =>
  p.id !== 'workos' && p.id !== 'fake-login' && p.id !== 'email';

export const LinkableAuthProviders = [...AllAuthProviders.filter(isLinkableAuthProvider)] as const;
export const OAuthProviderIds = [...LinkableAuthProviders.map(p => p.id)] as const;
export const ProdNonSSOAuthProviders = [...LinkableAuthProviders.map(p => p.id), 'email'] as const;

// All auth methods (excludes fake-login, used for sign-in hints)
// This is the same as all providers except fake-login
const isAuthMethod = (p: ProviderMetadata) => p.id !== 'fake-login';
export const AllAuthMethodIds = [...AllAuthProviders.filter(isAuthMethod).map(p => p.id)] as const;
export type AuthMethod = (typeof AllAuthMethodIds)[number];

const byId = Object.fromEntries(AllAuthProviders.map(p => [p.id, p]));
export const getProviderById = (provider: AuthProviderId) => byId[provider];
