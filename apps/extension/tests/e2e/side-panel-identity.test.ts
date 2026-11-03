/* eslint-disable import/no-nodejs-modules, max-lines */
import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { mockAgentsApi } from './agents-fixture';
import { launchExtensionContext, seedExtensionAuth } from './extension-context-fixture';

const API_ORIGIN = 'https://app.kilo.ai';
const FIRST_TOKEN = 'token-1';
const SECOND_TOKEN = 'token-account-b';
const SECOND_EMAIL = 'second@kilo.ai';
const DEVICE_CODE = 'ABCD-2345';
const UPDATED_AT = '2026-10-20T00:00:00.000Z';

const FIRST_SESSION_TITLE = 'Alpha rollout session';
const FIRST_HISTORY_TITLE = 'Alpha history entry';
const FIRST_REPOSITORY = 'alpha-org/alpha-private-repo';
const FIRST_INSTANCE_LABEL = 'Alpha device · alpha-project';
const SECOND_HISTORY_TITLE = 'Beta history entry';
const SECOND_REPOSITORY = 'beta-org/beta-private-repo';

interface AccountResponses {
  activeSessions: () => Promise<unknown>;
  history: () => Promise<unknown>;
  instances: () => Promise<unknown>;
  repositories: () => Promise<unknown>;
}

const responsesByToken = new Map<string, AccountResponses>();

function resolved<Value>(value: Value): Promise<Value> {
  return Promise.resolve(value);
}

/* Procedures this spec answers per identity; anything else falls back to the shared fixture. */
const ACCOUNT_PROCEDURES: Record<string, true> = {
  'activeSessions.list': true,
  'activeSessions.listInstances': true,
  'cliSessionsV2.list': true,
  'cloudAgentNext.listGitHubRepositories': true,
  'modelPreferences.get': true,
  'organizations.cloudAgentNext.listGitHubRepositories': true,
};

const trpcProcedures = (url: string): string[] => {
  const { pathname } = new URL(url);
  return pathname.replace('/api/trpc/', '').split('?')[0]?.split(',') ?? [];
};

const sawAccountRequest = (entries: readonly string[], token: string, proc: string): boolean =>
  entries.some(entry => entry.startsWith(`${token}:`) && entry.includes(proc));

const tRpcItem = async (
  proc: string,
  responses: AccountResponses
): Promise<Record<string, unknown>> => {
  try {
    switch (proc) {
      case 'activeSessions.list': {
        return { result: { data: { sessions: await responses.activeSessions() } } };
      }
      case 'cliSessionsV2.list': {
        return { result: { data: await responses.history() } };
      }
      case 'activeSessions.listInstances': {
        return { result: { data: await responses.instances() } };
      }
      case 'cloudAgentNext.listGitHubRepositories':
      case 'organizations.cloudAgentNext.listGitHubRepositories': {
        return { result: { data: await responses.repositories() } };
      }
      case 'modelPreferences.get': {
        return { result: { data: { favorites: [], lastSelected: null } } };
      }
      default: {
        return { result: { data: {} } };
      }
    }
  } catch {
    return {
      error: {
        code: -32_603,
        data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
        message: 'Server error',
      },
    };
  }
};

const installAccountRoutes = async (
  context: BrowserContext,
  seenRequests: string[]
): Promise<void> => {
  await context.route(
    url => {
      try {
        const { origin, pathname } = new URL(url);
        return origin === API_ORIGIN && pathname.startsWith('/api/trpc');
      } catch {
        return false;
      }
    },
    async route => {
      const procs = trpcProcedures(route.request().url());
      const authorization = route.request().headers()['authorization'] ?? '';
      const token = authorization.replace(/^Bearer /u, '');
      const responses = responsesByToken.get(token);

      if (responses === undefined || !procs.every(proc => ACCOUNT_PROCEDURES[proc] === true)) {
        await route.fallback();
        return;
      }

      seenRequests.push(`${token}:${procs.join(',')}`);

      const items = await Promise.all(procs.map(proc => tRpcItem(proc, responses)));
      await route.fulfill({ json: items.length === 1 ? items[0] : items, status: 200 });
    }
  );
};

test('side panel agents views follow the signed-in identity through a device-auth sign-in', async () => {
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockAgentsApi(context, { activeSessions: [], historySessions: [] });

    const activePending = Promise.withResolvers<unknown>();
    const repositoriesPending = Promise.withResolvers<unknown>();
    const instancesPending = Promise.withResolvers<unknown>();
    const seenRequests: string[] = [];

    responsesByToken.set(FIRST_TOKEN, {
      activeSessions: () =>
        resolved([
          {
            connectionId: 'cloud-agent',
            gitBranch: 'alpha-branch',
            gitUrl: `https://github.com/${FIRST_REPOSITORY}`,
            id: 'alpha-session',
            status: 'running',
            title: FIRST_SESSION_TITLE,
          },
        ]),
      history: () =>
        resolved({
          cliSessions: [
            { session_id: 'alpha-history', title: FIRST_HISTORY_TITLE, updated_at: UPDATED_AT },
          ],
        }),
      instances: () =>
        resolved({
          instances: [
            { connectionId: 'cli-alpha', name: 'Alpha device', projectName: 'alpha-project' },
          ],
        }),
      repositories: () =>
        resolved({
          integrationInstalled: true,
          repositories: [
            { fullName: FIRST_REPOSITORY, id: 1, name: 'alpha-private-repo', private: true },
          ],
        }),
    });
    responsesByToken.set(SECOND_TOKEN, {
      activeSessions: () => activePending.promise,
      history: () =>
        resolved({
          cliSessions: [
            { session_id: 'beta-history', title: SECOND_HISTORY_TITLE, updated_at: UPDATED_AT },
          ],
        }),
      instances: () => instancesPending.promise,
      repositories: () => repositoriesPending.promise,
    });

    await installAccountRoutes(context, seenRequests);

    await context.route(`${API_ORIGIN}/api/device-auth/codes?app=1`, route =>
      route.fulfill({
        json: { code: DEVICE_CODE, verificationUrl: `${API_ORIGIN}/device-auth` },
        status: 200,
      })
    );
    await context.route(`${API_ORIGIN}/api/device-auth/codes/${DEVICE_CODE}`, route =>
      route.fulfill({ json: { token: SECOND_TOKEN, userEmail: SECOND_EMAIL }, status: 200 })
    );
    await context.route(`${API_ORIGIN}/device-auth`, route =>
      route.fulfill({
        body: '<!doctype html><html><body>Device authorization</body></html>',
        contentType: 'text/html',
        status: 200,
      })
    );

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();
    await expect(sidePanel.getByLabel('Settings')).toBeVisible({ timeout: 15_000 });

    await sidePanel.getByRole('tab', { name: 'Agents' }).click();
    await expect(sidePanel.getByText(FIRST_SESSION_TITLE)).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.getByText(FIRST_HISTORY_TITLE)).toBeVisible();

    await sidePanel.getByRole('button', { exact: true, name: 'New session' }).click();
    await expect(sidePanel.getByLabel('Select repository')).toContainText(FIRST_REPOSITORY);
    await expect(sidePanel.getByRole('option', { name: FIRST_INSTANCE_LABEL })).toHaveCount(1);
    await sidePanel.getByLabel('Back').click();

    await sidePanel.getByLabel('Settings').click();
    await sidePanel.getByRole('button', { name: 'Sign out' }).click();
    await expect(sidePanel.getByRole('button', { name: 'Sign in' })).toBeVisible({
      timeout: 15_000,
    });

    await sidePanel.getByRole('button', { name: 'Sign in' }).click();
    await expect(sidePanel.getByLabel('Settings')).toBeVisible({ timeout: 20_000 });

    await sidePanel.getByRole('tab', { name: 'Agents' }).click();
    await expect
      .poll(() => sawAccountRequest(seenRequests, SECOND_TOKEN, 'activeSessions.list'), {
        timeout: 15_000,
      })
      .toBe(true);
    await expect(sidePanel.getByText(FIRST_SESSION_TITLE)).toHaveCount(0);
    await expect(sidePanel.getByText(FIRST_HISTORY_TITLE)).toHaveCount(0);

    activePending.reject(new Error('Network unavailable'));
    await expect(sidePanel.getByText('Failed to load active sessions')).toBeVisible({
      timeout: 15_000,
    });
    await expect(sidePanel.getByText(SECOND_HISTORY_TITLE)).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.getByText(FIRST_SESSION_TITLE)).toHaveCount(0);
    await expect(sidePanel.getByText(FIRST_HISTORY_TITLE)).toHaveCount(0);

    await sidePanel.getByRole('button', { exact: true, name: 'New session' }).click();
    await expect
      .poll(() => sawAccountRequest(seenRequests, SECOND_TOKEN, 'listGitHubRepositories'), {
        timeout: 15_000,
      })
      .toBe(true);
    await expect(sidePanel.getByLabel('Select repository')).not.toContainText(FIRST_REPOSITORY);
    await expect(sidePanel.getByText(FIRST_REPOSITORY)).toHaveCount(0);
    await expect(sidePanel.getByRole('option', { name: FIRST_INSTANCE_LABEL })).toHaveCount(0);

    repositoriesPending.resolve({
      integrationInstalled: true,
      repositories: [
        { fullName: SECOND_REPOSITORY, id: 2, name: 'beta-private-repo', private: true },
      ],
    });
    instancesPending.resolve({ instances: [] });

    await expect(sidePanel.getByLabel('Select repository')).toContainText(SECOND_REPOSITORY, {
      timeout: 15_000,
    });
    await expect(sidePanel.getByLabel('Select repository')).not.toContainText(FIRST_REPOSITORY);
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
