/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
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

const shellCaller = appShellProceduresRouter.createCaller({
  user: { id: 'shell-procedure-probe' } as TRPCContext['user'],
  headersList: new Headers(),
});

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
    expect(typeof shellCaller.models.selectorList).toBe('function');
  });

  it('mounts the organization reads behind the SSO and data-collection pages', () => {
    expect(typeof shellCaller.organizations.withMembers).toBe('function');
    expect(typeof shellCaller.organizations.seats).toBe('function');
    expect(typeof shellCaller.organizations.subscription.getLatestSeatPurchaseStatus).toBe(
      'function'
    );
    expect(typeof shellCaller.organizations.sso.getConfig).toBe('function');
    expect(typeof shellCaller.organizations.settings.updateDataCollection).toBe('function');
  });

  it('mounts the connected-accounts reads and writes', () => {
    expect(typeof shellCaller.user.getAuthProviders).toBe('function');
    expect(typeof shellCaller.user.linkAuthProvider).toBe('function');
    expect(typeof shellCaller.user.unlinkAuthProvider).toBe('function');
    expect(typeof shellCaller.user.getDiscordGuildStatus).toBe('function');
  });

  it('mounts the provider installation reads behind the integration pages', () => {
    expect(typeof shellCaller.githubApps.getInstallation).toBe('function');
    expect(typeof shellCaller.slack.getInstallation).toBe('function');
    expect(typeof shellCaller.linear.getInstallation).toBe('function');
    expect(typeof shellCaller.discord.getInstallation).toBe('function');
    expect(typeof shellCaller.gitlab.getInstallation).toBe('function');
  });

  it('mounts the hand-off bridge the app opens shell pages with', () => {
    expect(typeof shellCaller.appShell.mintHandoff).toBe('function');
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
