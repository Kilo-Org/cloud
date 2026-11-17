/**
 * @jest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { appShellProceduresRouter } from '@/routers/app-shell-procedures-router';
import { rootRouter } from '@/routers/root-router';

/**
 * Every shell page reads and writes through `/app-shell/api/trpc`, whose whole
 * identity is the shell cookie. What that entry point mounts is therefore the
 * credential's entire API, and it has to be the shell's own surface: the
 * procedures these pages call, and no billing or purchase path a reviewer could
 * reach by editing the request.
 */
const shellPaths = Object.keys(appShellProceduresRouter._def.procedures);
const webPaths = Object.keys(rootRouter._def.procedures);

/** `apps/web/src`, for the shared components the shell renders. */
const WEB_SRC = join(__dirname, '..', '..', '..');
const SHELL_ROOT = __dirname;

/**
 * The components the shell renders from the full web app. Scan them for
 * `trpc.*` calls rather than listing procedures by hand, so a picker or card
 * that starts reading a new procedure fails this suite until the shell router
 * mounts it.
 *
 * Files the shell imports but never renders in shell mode are absent, and each
 * absence is a render guard rather than a guess:
 *
 * - `components/profile/PasskeysCard.tsx`: `LoginMethodsWrapper` renders it only
 *   when `shell` is unset.
 * - `components/integrations/OrganizationGitHubInstallations.tsx` and
 *   `GitHubIdentityCard.tsx`: `GitHubIntegrationDetails` renders them only when
 *   `appReturnPath` is unset, and the shell always passes it.
 */
const RENDERED_COMPONENT_FILES = [
  'components/integrations/GitHubIntegrationDetails.tsx',
  'components/integrations/GitLabIntegrationDetails.tsx',
  'components/integrations/SlackIntegrationDetails.tsx',
  'components/integrations/LinearIntegrationDetails.tsx',
  'components/integrations/DiscordIntegrationDetails.tsx',
  'components/organizations/SSOSignupCard.tsx',
  'components/organizations/OrganizationDataCollectionCard.tsx',
  'components/profile/LoginMethodsWrapper.tsx',
  'components/profile/LoginMethodsCard.tsx',
  'components/profile/ConnectedAccountsCard.tsx',
  'components/profile/DiscordGuildStatus.tsx',
  // The model picker: ModelCombobox renders in every provider detail, and it
  // reads both the selectable list and the preferred ordering.
  'components/shared/ModelCombobox.tsx',
  'components/shared/usePreferredModels.ts',
  'lib/hooks/use-openrouter-models.ts',
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [path];
  });
}

/**
 * The procedure each `trpc.*` / `trpcClient.*` expression names, resolved as
 * the longest prefix that exists on the web router (so `…queryOptions`,
 * `…mutationOptions`, `…queryKey` and `…mutate` suffix the procedure rather than
 * becoming part of it).
 */
function namedProcedures(source: string): string[] {
  const web = new Set(webPaths);
  const named: string[] = [];

  for (const match of source.matchAll(/\b(?:trpc|trpcClient|trpcUtils)\.([A-Za-z0-9_.]+)/g)) {
    const segments = match[1].split('.');
    for (let length = segments.length; length > 0; length -= 1) {
      const candidate = segments.slice(0, length).join('.');
      if (web.has(candidate)) {
        named.push(candidate);
        break;
      }
    }
  }

  return named;
}

/** Billing and purchase namespaces, which exist on the web API and not here. */
const BILLING_NAMESPACES = [
  'credits.',
  'kiloPass.',
  'codingPlans.',
  'computeBilling.',
  'claudeBilling.',
  'organizations.funds.',
  'organizations.invoices',
  'organizations.subscription.updateSeatCount',
  'organizations.subscription.getCustomerPortalUrl',
];

describe('the shell tRPC entry point', () => {
  it('mounts the model list the Slack, Linear, Discord and GitHub pages read', () => {
    expect(shellPaths).toContain('models.selectorList');
    expect(shellPaths).toContain('models.preferred');
  });

  // The organization cards read through `app/api/organizations/hooks.ts`, which
  // also holds every other organization page's hooks, so the file scan below
  // cannot attribute its procedures to the shell. These five are the ones the
  // SSO and data-collection cards use.
  it('mounts the organization reads behind the SSO and data-collection pages', () => {
    expect(shellPaths).toContain('organizations.withMembers');
    expect(shellPaths).toContain('organizations.seats');
    expect(shellPaths).toContain('organizations.subscription.getLatestSeatPurchaseStatus');
    expect(shellPaths).toContain('organizations.sso.getConfig');
    expect(shellPaths).toContain('organizations.settings.updateDataCollection');
  });

  it('mounts the connected-accounts reads and writes', () => {
    expect(shellPaths).toContain('user.getAuthProviders');
    expect(shellPaths).toContain('user.linkAuthProvider');
    expect(shellPaths).toContain('user.unlinkAuthProvider');
    expect(shellPaths).toContain('user.getDiscordGuildStatus');
  });

  it('mounts the provider installation reads behind the integration pages', () => {
    expect(shellPaths).toContain('githubApps.getInstallation');
    expect(shellPaths).toContain('slack.getInstallation');
    expect(shellPaths).toContain('linear.getInstallation');
    expect(shellPaths).toContain('discord.getInstallation');
    expect(shellPaths).toContain('gitlab.getInstallation');
  });

  it('mounts the hand-off bridge the app opens shell pages with', () => {
    expect(shellPaths).toContain('appShell.mintHandoff');
  });

  it('mounts every procedure the shell pages and the components they render name', () => {
    const named = new Set(
      [
        ...sourceFiles(SHELL_ROOT),
        ...RENDERED_COMPONENT_FILES.map(file => join(WEB_SRC, file)),
      ].flatMap(file => namedProcedures(readFileSync(file, 'utf8')))
    );

    // A scan that stops finding call sites would pass every absence check, so
    // prove it found the pages' work first.
    expect(named.size).toBeGreaterThan(20);
    expect([...named]).toContain('models.preferred');
    expect([...named]).toContain('models.selectorList');

    const shell = new Set(shellPaths);
    expect([...named].filter(path => !shell.has(path)).sort()).toEqual([]);
  });

  it('publishes no billing or purchase procedure', () => {
    // The web API does own these namespaces, so an empty result here is the
    // shell router's restriction and not a typo in a prefix.
    for (const namespace of BILLING_NAMESPACES) {
      expect(webPaths.filter(path => path.startsWith(namespace)).length).toBeGreaterThan(0);
    }

    const billingPaths = shellPaths.filter(path =>
      BILLING_NAMESPACES.some(namespace => path.startsWith(namespace))
    );
    expect(billingPaths).toEqual([]);
  });

  it('publishes no other top-level web namespace', () => {
    expect([...new Set(shellPaths.map(path => path.split('.')[0]))].sort()).toEqual(
      [
        'appShell',
        'discord',
        'githubApps',
        'gitlab',
        'linear',
        'models',
        'organizations',
        'slack',
        'user',
      ].sort()
    );
  });
});
