import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, jest, test } from '@jest/globals';
import type * as LayoutModule from './layout';
import React, { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('./components/shell-providers', () => ({
  ShellProviders: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
}));

// The layout's JSX compiles to `React.createElement`, and Next supplies the
// binding its own build; here it comes from the test.
Object.assign(globalThis, { React });

// This repo's transform does not hoist `jest.mock` above the static imports, so
// the layout is required after the provider mock is registered.
const AppShellLayout =
  jest.requireActual<typeof LayoutModule>('./layout').default;

const SHELL_ROOT = join(__dirname, '..', 'app-shell');
const WEB_SRC = join(__dirname, '..', '..', '..');
const SHELL_COMPONENTS_ROOT = join(__dirname, 'components');
const SHELL_PAGES_ROOT = __dirname;

function shellSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return shellSourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')
      ? [path]
      : [];
  });
}

const NON_SHELL_LINK_PATTERNS: { pattern: RegExp; why: string }[] = [
  { pattern: /from 'next\/link'/, why: 'the shell renders no in-app link' },
  { pattern: /href=/, why: 'the shell renders no href, so no reachable page outside it' },
  { pattern: /router\.(push|replace)\(/, why: 'the shell never navigates away' },
  { pattern: /window\.location\.(href\s*=|assign\()/, why: 'the shell never navigates away' },
  {
    pattern: /\/credits|\/subscriptions|\/byok|\/pricing|\/invoices|\/users\/sign_in/,
    why: 'purchase surfaces and the full-web sign-in page live outside the shell',
  },
];

describe('app shell boundary', () => {
  test('renders no navigation and no link', () => {
    const html = renderToStaticMarkup(
      createElement(AppShellLayout, null, createElement('p', null, 'shell content'))
    );

    expect(html).toContain('shell content');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('<nav');
  });

  test('no shell route leads to a page outside the shell', () => {
    const files = shellSourceFiles(SHELL_ROOT);
    expect(files.length).toBeGreaterThan(10);

    const offenders = files.flatMap(path =>
      NON_SHELL_LINK_PATTERNS.filter(({ pattern }) => pattern.test(readFileSync(path, 'utf8'))).map(
        ({ why }) => `${relative(SHELL_ROOT, path)}: ${why}`
      )
    );

    expect(offenders).toEqual([]);
  });
});

/**
 * Every component the shell renders from the full web app, with the non-shell
 * Kilo destinations it mentions and why they are unreachable from a shell page.
 *
 * A new non-shell destination in one of these files fails this test, so a
 * change to a shared card cannot quietly re-open a link out of the shell.
 */
const REUSED_COMPONENTS: {
  file: string;
  /** Non-shell Kilo paths the file mentions; every one needs a reason below. */
  allowedNonShellPaths: string[];
  reason: string;
}[] = [
  {
    file: join(WEB_SRC, 'components/integrations/GitHubIntegrationDetails.tsx'),
    allowedNonShellPaths: ['/cloud/sessions', '/integrations/github', '/github-app?'],
    reason:
      'Web-only branches: the mismatch card, the cloud-sessions return href, and the identity links render only when `appReturnPath` is unset. The shell passes `appReturnPath` and `installStartPath`, hides the identity card, and starts installs on its own route.',
  },
  {
    file: join(WEB_SRC, 'components/integrations/GitLabIntegrationDetails.tsx'),
    allowedNonShellPaths: ['/integrations/gitlab', '/users/sign_in', 'kilo.ai'],
    reason:
      'Outside the shell the self-hosted start sends an unauthenticated browser to the web sign-in page and the Enterprise note links the docs and sales. With `shell` set the start goes to the terminal shell page and the note is plain text.',
  },
  {
    file: join(WEB_SRC, 'components/integrations/SlackIntegrationDetails.tsx'),
    allowedNonShellPaths: [],
    reason: 'The shell passes `connectPath`, so the start route is a shell route.',
  },
  {
    file: join(WEB_SRC, 'components/integrations/LinearIntegrationDetails.tsx'),
    allowedNonShellPaths: [],
    reason: 'The shell passes `connectPath`, so the start route is a shell route.',
  },
  {
    file: join(WEB_SRC, 'components/integrations/DiscordIntegrationDetails.tsx'),
    allowedNonShellPaths: [],
    reason: 'Only a discord.com link; no Kilo destination.',
  },
  {
    file: join(WEB_SRC, 'components/organizations/SSOSignupCard.tsx'),
    allowedNonShellPaths: ['kilo.ai'],
    reason:
      'The marketing `kilo.ai/setup-sso` button is replaced by plain text when `shell` is set; the remaining links are the WorkOS admin portal the shell never renders as an href.',
  },
  {
    file: join(WEB_SRC, 'components/organizations/OrganizationDataCollectionCard.tsx'),
    allowedNonShellPaths: [],
    reason: 'Renders switches only; no link.',
  },
  {
    file: join(WEB_SRC, 'components/profile/LoginMethodsWrapper.tsx'),
    allowedNonShellPaths: [],
    reason: 'Composes the cards below with the shell callback path.',
  },
  {
    file: join(WEB_SRC, 'components/profile/LoginMethodsCard.tsx'),
    allowedNonShellPaths: ['/connected-accounts'],
    reason:
      'The default callback path; the shell passes `/app-shell/connected-accounts` so the round trip returns inside the shell.',
  },
  {
    file: join(WEB_SRC, 'components/profile/ConnectedAccountsCard.tsx'),
    allowedNonShellPaths: [],
    reason: 'Unlink actions only; no link.',
  },
  {
    file: join(WEB_SRC, 'components/profile/PasskeysCard.tsx'),
    allowedNonShellPaths: [],
    reason: 'Passkey management stays on the page.',
  },
  {
    file: join(WEB_SRC, 'components/profile/DiscordGuildStatus.tsx'),
    allowedNonShellPaths: ['kilo.ai'],
    reason:
      'The `kilo.ai/discord` links are plain text when `shell` is set, and the shell passes it.',
  },
];

const KILO_PATHS = [
  '/credits',
  '/subscriptions',
  '/byok',
  '/pricing',
  '/invoices',
  '/users/sign_in',
  '/cloud/sessions',
  '/integrations/github',
  '/integrations/gitlab',
  '/connected-accounts',
  '/github-app?',
  'kilo.ai',
];

function mentionedKiloPaths(source: string): string[] {
  return KILO_PATHS.filter(path => source.includes(path)).sort();
}

describe('app shell reused components', () => {
  test.each(REUSED_COMPONENTS)(
    '$file mentions no unclassified non-shell destination',
    ({ file, allowedNonShellPaths }) => {
      const source = readFileSync(file, 'utf8');
      expect(mentionedKiloPaths(source)).toEqual([...allowedNonShellPaths].sort());
    }
  );

  test('the shell passes the scoping props every audited component needs', () => {
    const detail = readFileSync(join(SHELL_COMPONENTS_ROOT, 'integration-detail.tsx'), 'utf8');
    expect(detail).toContain('connectPath=');
    expect(detail).toContain('appReturnPath=');
    expect(detail).toContain('installStartPath=');
    expect(detail).toContain('shell');

    const cards = readFileSync(join(SHELL_COMPONENTS_ROOT, 'organization-cards.tsx'), 'utf8');
    expect(cards).toContain('<SSOSignupCard');
    expect(cards).toContain('shell');

    const connectedAccounts = readFileSync(
      join(SHELL_PAGES_ROOT, 'connected-accounts', 'page.tsx'),
      'utf8'
    );
    expect(connectedAccounts).toContain('callbackPath=');
    expect(connectedAccounts).toContain('shell');
  });
});
