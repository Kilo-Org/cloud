/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';

/**
 * Every shell page reads and writes through `/app-shell/api/trpc`, which mounts
 * this router with the shell cookie as its whole identity. A procedure these
 * pages call therefore has to live on this router: a REST route under `/api`
 * only ever sees the web session, which the shell cookie's `Path` keeps away
 * from it, so such a call answers 401 and the page has no data at all.
 */
const shellCaller = rootRouter.createCaller({
  user: { id: 'shell-procedure-probe' } as TRPCContext['user'],
  headersList: new Headers(),
});

describe('the shell tRPC entry point', () => {
  it('mounts the model list the Slack, Linear, Discord and GitHub pages read', () => {
    expect(typeof shellCaller.models.selectorList).toBe('function');
    expect(typeof shellCaller.organizations.settings.listAvailableModels).toBe('function');
  });

  it('mounts the organization reads behind the SSO and data-collection pages', () => {
    expect(typeof shellCaller.organizations.withMembers).toBe('function');
    expect(typeof shellCaller.organizations.sso.getConfig).toBe('function');
  });

  it('mounts the connected-accounts reads and writes', () => {
    expect(typeof shellCaller.user.getAuthProviders).toBe('function');
    expect(typeof shellCaller.user.getPasskeys).toBe('function');
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
});
