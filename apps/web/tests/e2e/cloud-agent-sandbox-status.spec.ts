import { test, expect, type Locator, type Page, type WebSocketRoute } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createDrizzleClient } from '@kilocode/db/client';
import { organization_memberships, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { SandboxStatusSnapshot } from '@/routers/cloud-agent-next-schemas';

const firstId = 'ses_sandbox_status_first';
const secondId = 'ses_sandbox_status_second';
const firstWorkspace = 'workspace_00000000-0000-4000-8000-000000000001';
const secondWorkspace = 'workspace_00000000-0000-4000-8000-000000000002';
const privateSentinel = 'PRIVATE_SANDBOX_DIAGNOSTIC_SENTINEL';
const baseTime = Date.parse('2026-08-28T12:00:00Z');
const runtimeMetadata = {
  sandboxType: 'isolated-standard',
  kiloCliVersion: '7.4.20',
  wrapperVersion: '2.4.0',
  startedAt: baseTime - 600_000,
  stoppedAt: null,
} satisfies NonNullable<SandboxStatusSnapshot['runtime']>;
const lifecycleDetails = {
  active: 'sandbox_ready',
  sleeping: 'sandbox_stopped',
  starting: 'sandbox_starting',
  stopping: 'sandbox_stopping',
  error: 'sandbox_failed',
  unreachable: 'connection_unavailable',
  unknown: 'insufficient_evidence',
} as const;

type SessionFixture = {
  id: string;
  cloudId: string | null;
  title: string;
  organizationId?: string;
  kind?: 'remote' | 'read-only' | 'unresolved' | 'unrelated';
};
type StatusRequest = { cloudAgentSessionId: string; organizationId?: string; at: number };
type RpcResult =
  | { result: { data: unknown } }
  | { error: { message: string; code: number; data: { code: string; httpStatus: number } } };

function success(data: unknown): RpcResult {
  return { result: { data } };
}

function failure(code = 'INTERNAL_SERVER_ERROR'): RpcResult {
  return {
    error: {
      message: privateSentinel,
      code: -32603,
      data: { code, httpStatus: code === 'FORBIDDEN' ? 403 : 500 },
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(fulfill => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

async function mountFixtures(
  page: Page,
  sessions: SessionFixture[] = [
    { id: firstId, cloudId: firstWorkspace, title: 'First sandbox chat' },
    { id: secondId, cloudId: secondWorkspace, title: 'Second sandbox chat' },
  ]
) {
  let now = baseTime;
  await page.clock.install({ time: new Date(baseTime) });
  const statusRequests: StatusRequest[] = [];
  const procedures: string[] = [];
  const sockets = new Map<string, WebSocketRoute>();
  let reply: (request: StatusRequest) => RpcResult | Promise<RpcResult> = () => success(snapshot());
  let eventId = 0;

  function snapshot(overrides: Partial<SandboxStatusSnapshot> = {}): SandboxStatusSnapshot {
    return {
      status: 'active',
      provider: 'Cloudflare',
      observedAt: now,
      detailCode: 'sandbox_ready',
      inactivityTimeoutMs: 300_000,
      estimatedSleepAt: now + 180_000,
      runtime: runtimeMetadata,
      ...overrides,
    };
  }

  function row(session: SessionFixture) {
    return {
      session_id: session.id,
      cloud_agent_session_id: session.cloudId,
      title: session.title,
      organization_id: session.organizationId ?? null,
      created_on_platform: 'cloud-agent-web',
      created_at: new Date(baseTime).toISOString(),
      updated_at: new Date(baseTime).toISOString(),
      version: 2,
      git_url: 'https://github.com/example/sandbox-status-regressions.git',
      git_branch: 'feature/a-long-branch-name-for-responsive-header-regressions',
      parent_session_id: null,
      status: 'idle',
      status_updated_at: new Date(baseTime).toISOString(),
      total_cost_microdollars: 0,
      associatedPr: null,
      runtimeState: session.cloudId
        ? {
            sessionId: session.cloudId,
            mode: 'code',
            model: 'kilo-auto/efficient',
            githubRepo: 'example/sandbox-status-regressions',
            initiatedAt: baseTime - 1000,
            preparedAt: baseTime - 1000,
          }
        : null,
    };
  }

  function send(cloudId: string, streamEventType: string, data: unknown) {
    sockets.get(cloudId)?.send(
      JSON.stringify({
        eventId: ++eventId,
        sessionId: cloudId,
        streamEventType,
        timestamp: new Date(now).toISOString(),
        data,
      })
    );
  }

  await page.routeWebSocket('**', socket => {
    const url = new URL(socket.url());
    if (url.pathname !== '/stream') {
      if (url.pathname !== '/api/user/web') socket.connectToServer();
      return;
    }
    const cloudId = url.searchParams.get('cloudAgentSessionId');
    if (!cloudId) return;
    sockets.set(cloudId, socket);
    send(cloudId, 'connected', { sessionStatus: { type: 'idle' }, cloudStatus: { type: 'ready' } });
  });
  await page.route('**/api/cloud-agent-next/sessions/stream-ticket', route =>
    route.fulfill({
      json: { ticket: 'controlled-browser-ticket', expiresAt: baseTime / 1000 + 3600 },
    })
  );
  await page.route('**/api/trpc/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const paths = url.pathname.split('/api/trpc/')[1].split(',');
    const batch = url.searchParams.get('batch') === '1';
    const input =
      request.method() === 'GET'
        ? JSON.parse(url.searchParams.get('input') ?? '{}')
        : request.postDataJSON();
    const results = await Promise.all(
      paths.map(async (procedure, index): Promise<RpcResult> => {
        procedures.push(procedure);
        const args = (batch ? input?.[index] : input) ?? {};
        if (procedure.endsWith('.getSandboxStatus')) {
          now = await page.evaluate(() => Date.now());
          const statusRequest = { ...args, at: now } as StatusRequest;
          statusRequests.push(statusRequest);
          return reply(statusRequest);
        }
        if (procedure === 'cliSessionsV2.list' || procedure === 'cliSessionsV2.search')
          return success({ cliSessions: sessions.map(row), total: sessions.length });
        if (procedure === 'cliSessionsV2.recentRepositories') return success({ repositories: [] });
        if (procedure === 'kiloPass.getSidebarPromoEligibility')
          return success({ showPromoBanner: false });
        if (procedure === 'activeSessions.list')
          return success({
            sessions: sessions
              .filter(s => s.kind === 'remote')
              .map(s => ({
                id: s.id,
                status: 'idle',
                title: s.title,
                connectionId: 'controlled-remote',
              })),
          });
        if (procedure === 'activeSessions.createWebTicket')
          return success({ token: 'controlled-web-ticket' });
        if (
          procedure === 'cliSessionsV2.getWithRuntimeState' ||
          procedure === 'cliSessionsV2.get'
        ) {
          const session = sessions.find(s => s.id === args.session_id);
          if (!session || session.kind === 'unrelated') return failure('NOT_FOUND');
          if (session.kind === 'unresolved') return new Promise(() => {});
          if (session.kind === 'read-only' && procedure === 'cliSessionsV2.get')
            return success({ ...row(session), cloud_agent_session_id: null });
          return success(row(session));
        }
        if (procedure === 'cliSessionsV2.getSessionMessagesPage')
          return success({
            kiloSessionId: args.session_id,
            history: { messages: [], nextCursor: null, omittedItemCount: 0 },
          });
        if (procedure === 'cliSessionsV2.getSessionMessages')
          return success({ info: { id: args.session_id }, messages: [] });
        if (procedure.endsWith('.getComputeBillingStatus'))
          return success({ phase: 'unavailable' });
        if (procedure.endsWith('.sendMessage'))
          return success({ messageId: 'msg_controlled', delivery: 'sent' });
        const upstreamUrl = new URL(`/api/trpc/${procedure}`, url.origin);
        if (request.method() === 'GET') upstreamUrl.searchParams.set('input', JSON.stringify(args));
        try {
          const response = await route.fetch({
            url: upstreamUrl.toString(),
            ...(request.method() === 'POST' ? { postData: JSON.stringify(args) } : {}),
          });
          return response.json();
        } catch {
          throw new Error(`Fixture prerequisite failed: ${procedure}`);
        }
      })
    );
    await route.fulfill({ json: batch ? results : results[0] });
  });

  return {
    statusRequests,
    procedures,
    snapshot,
    setReply(handler: typeof reply) {
      reply = handler;
    },
    async open(id = firstId, organizationId?: string) {
      await page.goto(
        `${organizationId ? `/organizations/${organizationId}` : ''}/cloud/chat?sessionId=${id}`
      );
      await expect(page.getByRole('button', { name: 'More options' })).toBeVisible();
    },
    async navigate(id: string) {
      await page.evaluate(sessionId => {
        const url = new URL(location.href);
        url.searchParams.set('sessionId', sessionId);
        window.history.pushState(null, '', url);
      }, id);
    },
    async advance(ms: number) {
      await page.clock.fastForward(ms);
      now = await page.evaluate(() => Date.now());
    },
    async currentSnapshot(overrides: Partial<SandboxStatusSnapshot> = {}) {
      now = await page.evaluate(() => Date.now());
      return snapshot(overrides);
    },
    async refresh() {
      const count = statusRequests.length;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => statusRequests.length).toBeGreaterThan(count);
    },
    async activity(cloudId: string, type: 'busy' | 'idle') {
      await expect.poll(() => sockets.has(cloudId)).toBe(true);
      const session = sessions.find(s => s.cloudId === cloudId);
      send(cloudId, 'kilocode', {
        type: 'session.status',
        properties: { sessionID: session?.id, status: { type } },
      });
      if (type === 'idle') send(cloudId, 'complete', {});
    },
  };
}

async function withOrganization(
  page: Pick<Page, 'request' | 'unrouteAll'>,
  run: (organizationId: string) => Promise<void>
) {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString)
    throw new Error('POSTGRES_URL is required for the organization page fixture');
  const response = await page.request.get('/api/auth/session');
  const { kiloUserId } = z.object({ kiloUserId: z.string() }).parse(await response.json());
  const organizationId = randomUUID();
  const { db, pool } = createDrizzleClient({ connectionString, poolConfig: { max: 1 } });
  try {
    await db.insert(organizations).values({
      id: organizationId,
      name: 'Sandbox status browser regression organization',
      created_by_kilo_user_id: kiloUserId,
    });
    await db.insert(organization_memberships).values({
      organization_id: organizationId,
      kilo_user_id: kiloUserId,
      role: 'member',
    });
    await run(organizationId);
  } finally {
    try {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    } finally {
      try {
        await db
          .delete(organization_memberships)
          .where(eq(organization_memberships.organization_id, organizationId));
        await db.delete(organizations).where(eq(organizations.id, organizationId));
      } finally {
        await pool.end();
      }
    }
  }
}

const indicator = (page: Page) => page.getByRole('button', { name: /^Sandbox status:/ });
const details = (page: Page) => page.getByRole('dialog', { name: 'Sandbox status details' });
const detailValue = (container: Locator, label: string) =>
  container
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('+ dd');
const sleepTime = (page: Page) => detailValue(details(page), 'Sleeps in').locator('time');
const debugDisclosure = (page: Page) => details(page).locator('details');
const debugSummary = (page: Page) => debugDisclosure(page).locator('summary');

async function expectDebugCollapsed(page: Page) {
  await expect(debugSummary(page)).toBeVisible();
  await expect(debugSummary(page)).toHaveText('Debug');
  await expect(debugDisclosure(page)).toHaveJSProperty('open', false);
  await expect(debugDisclosure(page).locator('dl')).toBeHidden();
  await expect(details(page).getByText('Runtime code', { exact: true })).toHaveCount(0);
  await expect(details(page).locator('code')).toHaveCount(0);
}

async function expectDebugValues(page: Page, kiloCliVersion: string, wrapperVersion: string) {
  await expect(debugDisclosure(page).locator('dt')).toHaveText([
    'Execution',
    'Kilo CLI',
    'Wrapper',
  ]);
  await expect(debugDisclosure(page).locator('dd')).toHaveText([
    'Control plane',
    kiloCliVersion,
    wrapperVersion,
  ]);
}

async function settlePausedStatus(page: Page, label: string) {
  await expect
    .poll(async () => {
      await page.clock.runFor(1);
      return indicator(page).getAttribute('aria-label');
    })
    .toBe(`Sandbox status: ${label}`);
}

async function expectStaticIndicator(page: Page, targetSize = 32) {
  const button = indicator(page);
  await expect(button).toHaveText('');
  await expect(button).toHaveCSS('width', `${targetSize}px`);
  await expect(button).toHaveCSS('height', `${targetSize}px`);
  await expect(button.locator('svg')).toHaveCount(2);
  await expect(button.locator('svg').first()).toHaveClass(/lucide-box/);
  await expect(button.locator('svg').first()).toHaveCSS('width', '16px');
  await expect(button.locator('svg').first()).toHaveCSS('height', '16px');
  const badgeSize = (await button.getAttribute('aria-label')) === 'Sandbox status: Active' ? 6 : 12;
  await expect(button.locator('svg').last()).toHaveCSS('width', `${badgeSize}px`);
  await expect(button.locator('svg').last()).toHaveCSS('height', `${badgeSize}px`);
  for (const icon of await button.locator('svg').all()) {
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
  }
  await expect(
    button.locator('.animate-spin, [role="progressbar"], animate, animateTransform')
  ).toHaveCount(0);
  expect(
    await button.evaluate(element =>
      [element, ...element.querySelectorAll('*')].every(
        node => getComputedStyle(node).animationName === 'none'
      )
    )
  ).toBe(true);
}

async function expectToolbarGeometry(page: Page, targetSize = 32) {
  const sandbox = indicator(page);
  const radius = await sandbox.evaluate(element => getComputedStyle(element).borderRadius);
  const centerY = await sandbox.evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.y + box.height / 2;
  });
  for (const button of [
    sandbox,
    page.getByRole('button', { name: /^(Mute|Enable) completion sounds$/ }),
    page.getByRole('button', { name: 'More options', exact: true }),
    page.getByRole('button', { name: 'Send feedback', exact: true }),
  ]) {
    await expect(button).toHaveCSS('width', `${targetSize}px`);
    await expect(button).toHaveCSS('height', `${targetSize}px`);
    await expect(button).toHaveCSS('border-radius', radius);
    const icon = button.locator('svg').first();
    await expect(icon).toHaveCSS('width', '16px');
    await expect(icon).toHaveCSS('height', '16px');
    const geometry = await button.evaluate(element => {
      const box = element.getBoundingClientRect();
      const icon = element.querySelector('svg')?.getBoundingClientRect();
      if (!icon) throw new Error('Toolbar icon is missing');
      return {
        centerY: box.y + box.height / 2,
        offsetX: icon.x + icon.width / 2 - (box.x + box.width / 2),
        offsetY: icon.y + icon.height / 2 - (box.y + box.height / 2),
      };
    });
    expect(geometry.centerY).toBeCloseTo(centerY, 1);
    expect(geometry.offsetX).toBeCloseTo(0, 1);
    expect(geometry.offsetY).toBeCloseTo(0, 1);
  }
}

async function expectUnavailableRuntime(page: Page) {
  await expect(detailValue(details(page), 'Provider')).toHaveText('Unknown');
  await expect(detailValue(details(page), 'Sandbox type')).toHaveText('Unknown');
  await expectDebugValues(page, 'Unknown', 'Unknown');
  await expect(details(page).getByText('Runtime code', { exact: true })).toHaveCount(0);
  await expect(details(page).locator('code')).toHaveCount(0);
  await expect(details(page).getByRole('heading', { name: 'Timing', exact: true })).toHaveCount(0);
  await expect(details(page).getByText('Local time', { exact: true })).toHaveCount(0);
  await expect(details(page).locator('time')).toHaveCount(0);
}

async function expectSafe(page: Page) {
  await expect(page.locator('body')).not.toContainText(privateSentinel);
  await expect(page.locator('body')).not.toContainText(/sandbox[_-]instance|runtime[_-]id/);
}

test.describe('control-plane sandbox header', () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('removes organization fixtures when route teardown rejects without hiding the failure', async ({
    page,
  }) => {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString)
      throw new Error('POSTGRES_URL is required for the organization page fixture');
    const { db, pool } = createDrizzleClient({ connectionString, poolConfig: { max: 1 } });
    const cleanupError = new Error('Route teardown rejected');
    let fixtureId: string | undefined;
    try {
      await expect(
        withOrganization(
          {
            request: page.request,
            unrouteAll: async () => {
              throw cleanupError;
            },
          },
          async organizationId => {
            fixtureId = organizationId;
          }
        )
      ).rejects.toBe(cleanupError);
      if (!fixtureId) throw new Error('Organization fixture was not created');
      expect(
        await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, fixtureId))
      ).toEqual([]);
      expect(
        await db
          .select({ organizationId: organization_memberships.organization_id })
          .from(organization_memberships)
          .where(eq(organization_memberships.organization_id, fixtureId))
      ).toEqual([]);
    } finally {
      try {
        if (fixtureId) {
          await db
            .delete(organization_memberships)
            .where(eq(organization_memberships.organization_id, fixtureId));
          await db.delete(organizations).where(eq(organizations.id, fixtureId));
        }
      } finally {
        await pool.end();
      }
    }
  });

  test('keeps the sandbox icon fixed with distinct static lifecycle badges independently of agent progress', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    await fixture.open();
    await expect
      .poll(() => fixture.procedures, { timeout: 15000 })
      .toContain('cliSessionsV2.getWithRuntimeState');
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await indicator(page).click();
    await expect(details(page).getByText('Sandbox', { exact: true })).toBeVisible();
    await expect(detailValue(details(page), 'Provider')).toHaveText('Cloudflare');
    await expect(sleepTime(page)).toBeVisible();
    await expect(details(page)).not.toContainText(
      /Sleeps after|Inactivity timing is unknown|Sandbox lifecycle, not agent progress or compute billing/
    );
    const sandboxShape = await indicator(page).locator('svg').first().innerHTML();
    const badgeShapes = new Set<string>();
    for (const [status, detailCode] of Object.entries(lifecycleDetails)) {
      fixture.setReply(() =>
        success({
          ...fixture.snapshot({
            status: status as SandboxStatusSnapshot['status'],
            detailCode,
            estimatedSleepAt: null,
          }),
          internal: privateSentinel,
        })
      );
      await fixture.refresh();
      const label = `${status[0].toUpperCase()}${status.slice(1)}`;
      await expect(indicator(page)).toHaveAccessibleName(`Sandbox status: ${label}`);
      await expect(
        details(page).getByText(label, { exact: true }).filter({ visible: true })
      ).toBeVisible();
      await expectStaticIndicator(page);
      expect(await indicator(page).locator('svg').first().innerHTML()).toBe(sandboxShape);
      const badgeShape = await indicator(page).locator('svg').last().innerHTML();
      expect(badgeShapes.has(badgeShape)).toBe(false);
      badgeShapes.add(badgeShape);
      await expect(sleepTime(page)).toHaveCount(0);
      await expect(detailValue(details(page), 'Started').locator('time')).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Ask anything…' })).toBeEnabled();
      await expectSafe(page);
    }
    fixture.setReply(request =>
      success(fixture.snapshot({ estimatedSleepAt: request.at + 60_000 }))
    );
    await fixture.refresh();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping soon');
    await expect(details(page).getByText('Sleeping soon', { exact: true })).toBeVisible();
    await expectStaticIndicator(page);
    expect(await indicator(page).locator('svg').first().innerHTML()).toBe(sandboxShape);
    expect(badgeShapes.has(await indicator(page).locator('svg').last().innerHTML())).toBe(false);
    await expect(sleepTime(page)).toBeVisible();
    for (const provider of ['Vercel', 'Unknown'] as const) {
      fixture.setReply(() =>
        success(fixture.snapshot({ provider, inactivityTimeoutMs: null, estimatedSleepAt: null }))
      );
      await fixture.refresh();
      await expect(detailValue(details(page), 'Provider')).toHaveText(provider);
      await expect(sleepTime(page)).toHaveCount(0);
    }
    await expect(details(page)).not.toContainText(
      /Sleeps after|Inactivity timing is unknown|Sandbox lifecycle, not agent progress or compute billing/
    );
  });

  test('shows reported versions only in collapsed Debug and local lifecycle times without raw identifiers', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    fixture.setReply(() =>
      success({
        ...fixture.snapshot({ estimatedSleepAt: fixture.statusRequests[0].at + 180_000 }),
        sandboxInstanceId: 'sandbox_instance_private',
        runtimeId: 'runtime_id_private',
        runtime: {
          ...runtimeMetadata,
          wrapperRunId: privateSentinel,
          cloudAgentSessionId: firstWorkspace,
        },
      })
    );
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await indicator(page).click();
    await expect(
      details(page).getByRole('heading', { name: 'Runtime', exact: true })
    ).toBeVisible();
    for (const [label, value] of [
      ['Provider', 'Cloudflare'],
      ['Sandbox type', 'Standard'],
    ]) {
      await expect(detailValue(details(page), label)).toHaveText(value);
    }
    await expectDebugCollapsed(page);
    await debugSummary(page).click();
    await expect(debugDisclosure(page)).toHaveJSProperty('open', true);
    await expect(debugDisclosure(page).locator('dl')).toBeVisible();
    await expectDebugValues(page, runtimeMetadata.kiloCliVersion, runtimeMetadata.wrapperVersion);
    await expect(details(page)).not.toContainText(
      /workspace_|ses_|sandbox[_-]instance|runtime[_-]id/
    );
    await expectSafe(page);
    await expect(details(page).getByRole('heading', { name: 'Timing', exact: true })).toBeVisible();
    await expect(details(page).getByText('Local time', { exact: true })).toBeVisible();
    const started = detailValue(details(page), 'Started').locator('time');
    await expect(started).toHaveAttribute(
      'datetime',
      new Date(runtimeMetadata.startedAt).toISOString()
    );
    await expect(started).toHaveText(
      await page.evaluate(
        timestamp =>
          new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
        runtimeMetadata.startedAt
      )
    );
    await expect(detailValue(details(page), 'Stopped')).toHaveCount(0);
    await expect(sleepTime(page)).toHaveAttribute(
      'datetime',
      new Date(fixture.statusRequests[0].at + 180_000).toISOString()
    );
    await expect(sleepTime(page)).toHaveText('About 3 min if inactive');
    const stoppedAt = await page.evaluate(() => Date.now());
    fixture.setReply(() =>
      success(
        fixture.snapshot({
          status: 'sleeping',
          detailCode: 'sandbox_stopped',
          estimatedSleepAt: null,
          runtime: { ...runtimeMetadata, stoppedAt },
        })
      )
    );
    await fixture.refresh();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping');
    await expect(started).toBeVisible();
    const stopped = detailValue(details(page), 'Stopped').locator('time');
    await expect(stopped).toHaveAttribute('datetime', new Date(stoppedAt).toISOString());
    await expect(stopped).toHaveText(
      await page.evaluate(
        timestamp =>
          new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
        stoppedAt
      )
    );
    await expect(sleepTime(page)).toHaveCount(0);
  });

  for (const missingRuntime of ['omitted', 'null fields'] as const) {
    test(`does not invent runtime versions or dates for ${missingRuntime}`, async ({ page }) => {
      const fixture = await mountFixtures(page);
      fixture.setReply(() =>
        success(
          fixture.snapshot({
            estimatedSleepAt: null,
            runtime:
              missingRuntime === 'omitted'
                ? undefined
                : {
                    sandboxType: null,
                    kiloCliVersion: null,
                    wrapperVersion: null,
                    startedAt: null,
                    stoppedAt: null,
                  },
          })
        )
      );
      await fixture.open();
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
      await indicator(page).click();
      await expect(detailValue(details(page), 'Provider')).toHaveText('Cloudflare');
      await expect(detailValue(details(page), 'Sandbox type')).toHaveText('Unknown');
      await expectDebugCollapsed(page);
      await debugSummary(page).click();
      await expect(debugDisclosure(page).locator('dl')).toBeVisible();
      await expectDebugValues(page, 'Unknown', 'Unknown');
      await expect(details(page).getByRole('heading', { name: 'Timing', exact: true })).toHaveCount(
        0
      );
      await expect(details(page).getByText('Local time', { exact: true })).toHaveCount(0);
      await expect(detailValue(details(page), 'Started')).toHaveCount(0);
      await expect(detailValue(details(page), 'Stopped')).toHaveCount(0);
      await expect(sleepTime(page)).toHaveCount(0);
      await expect(details(page).locator('time')).toHaveCount(0);
      await expectSafe(page);
    });
  }

  test('shows relative sleep timing without a Local time caption until a lifecycle date is known', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    fixture.setReply(() =>
      success(
        fixture.snapshot({
          estimatedSleepAt: fixture.statusRequests[0].at + 180_000,
          runtime: { ...runtimeMetadata, startedAt: null, stoppedAt: null },
        })
      )
    );
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await indicator(page).click();
    await expect(details(page).getByRole('heading', { name: 'Timing', exact: true })).toBeVisible();
    await expect(details(page).getByText('Local time', { exact: true })).toHaveCount(0);
    await expect(detailValue(details(page), 'Started')).toHaveCount(0);
    await expect(detailValue(details(page), 'Stopped')).toHaveCount(0);
    await expect(sleepTime(page)).toHaveText('About 3 min if inactive');
    await expect(sleepTime(page)).toHaveAttribute(
      'datetime',
      new Date(fixture.statusRequests[0].at + 180_000).toISOString()
    );
    const stoppedAt = await page.evaluate(() => Date.now());
    fixture.setReply(() =>
      success(
        fixture.snapshot({
          status: 'sleeping',
          detailCode: 'sandbox_stopped',
          estimatedSleepAt: null,
          runtime: { ...runtimeMetadata, startedAt: null, stoppedAt },
        })
      )
    );
    await fixture.refresh();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping');
    await expect(details(page).getByText('Local time', { exact: true })).toBeVisible();
    await expect(detailValue(details(page), 'Started')).toHaveCount(0);
    await expect(detailValue(details(page), 'Stopped').locator('time')).toHaveAttribute(
      'datetime',
      new Date(stoppedAt).toISOString()
    );
    await expect(sleepTime(page)).toHaveCount(0);
  });

  test('pins the same hover popup on click without changing its content or stealing focus on hover', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    const composer = page.getByRole('combobox', { name: 'Ask anything…' });
    await composer.focus();
    await indicator(page).hover();
    await fixture.advance(250);
    await expect(details(page)).toBeVisible();
    await expect(details(page)).toHaveCount(1);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(details(page).getByText('Active', { exact: true })).toBeVisible();
    await expect(
      details(page).getByRole('heading', { name: 'Runtime', exact: true })
    ).toBeVisible();
    await expect(details(page).getByRole('heading', { name: 'Timing', exact: true })).toBeVisible();
    await expect(detailValue(details(page), 'Provider')).toHaveText('Cloudflare');
    await expect(detailValue(details(page), 'Sandbox type')).toHaveText('Standard');
    await expect(sleepTime(page)).toHaveText('About 3 min if inactive');
    await expectDebugCollapsed(page);
    await expect(details(page)).toHaveCSS('width', '320px');
    await expect(details(page)).toHaveCSS('padding', '16px');
    await expect(indicator(page)).toHaveAttribute('aria-expanded', 'true');
    const preview = await details(page).evaluateHandle(element => element);
    const debug = await debugDisclosure(page).evaluateHandle(element => element);
    const hoverContent = await details(page).innerText();
    const hoverClass = await details(page).getAttribute('class');
    const descriptionId = await indicator(page).getAttribute('aria-describedby');
    if (!descriptionId) throw new Error('Sandbox status description is missing');
    const sharedDetails = details(page).locator(`[id="${descriptionId}"]`);
    const description = await sharedDetails.innerText();
    await expect(sharedDetails.locator('details, summary, code')).toHaveCount(0);
    await expect(sharedDetails).not.toContainText(
      /Debug|Execution|Control plane|Kilo CLI|Wrapper|Runtime code|7\.4\.20|2\.4\.0/
    );
    await expect(indicator(page)).toHaveAccessibleDescription(description);
    await indicator(page).click();
    await fixture.advance(250);
    await expect(details(page)).toHaveCount(1);
    expect(await details(page).evaluate((element, original) => element === original, preview)).toBe(
      true
    );
    expect(
      await debugDisclosure(page).evaluate((element, original) => element === original, debug)
    ).toBe(true);
    await expect(details(page)).toHaveText(hoverContent, { useInnerText: true });
    expect(await details(page).getAttribute('class')).toBe(hoverClass);
    await expect(details(page)).toHaveCSS('width', '320px');
    await expect(details(page)).toHaveCSS('padding', '16px');
    await expectDebugCollapsed(page);
    await expect(debugSummary(page)).toBeFocused();
    await expect(indicator(page)).toHaveAttribute('aria-describedby', descriptionId);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.mouse.move(0, 0);
    await fixture.advance(500);
    await expect(details(page)).toBeVisible();
    await expect(debugSummary(page)).toBeFocused();
    await debugSummary(page).click();
    await expect(debugDisclosure(page).locator('dl')).toBeVisible();
    await expectDebugValues(page, runtimeMetadata.kiloCliVersion, runtimeMetadata.wrapperVersion);
    await expect(indicator(page)).toHaveAccessibleDescription(description);
    await expect(sharedDetails).toHaveText(description, { useInnerText: true });
    await expectSafe(page);
    await indicator(page).click();
    await fixture.advance(500);
    await expect(details(page)).toHaveCount(0);
    await expect(indicator(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(indicator(page)).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await preview.dispose();
    await debug.dispose();
  });

  test('keeps a preview open across pointer travel and closes only after leaving both surfaces', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    const composer = page.getByRole('combobox', { name: 'Ask anything…' });
    await composer.focus();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    await indicator(page).hover();
    await page.clock.runFor(250);
    await expect(details(page)).toBeVisible();
    const preview = await details(page).evaluateHandle(element => element);
    const triggerBox = await indicator(page).boundingBox();
    const popupBox = await details(page).boundingBox();
    if (!triggerBox || !popupBox) throw new Error('Sandbox status surfaces are missing');
    await page.mouse.move(
      triggerBox.x + triggerBox.width / 2,
      (triggerBox.y + triggerBox.height + popupBox.y) / 2
    );
    await page.clock.runFor(100);
    await expect(details(page)).toBeVisible();
    await debugSummary(page).hover();
    await page.clock.runFor(250);
    await expect(details(page)).toBeVisible();
    await expect(composer).toBeFocused();
    await expectDebugCollapsed(page);
    await page.mouse.move(0, 0);
    await page.clock.runFor(100);
    await expect(indicator(page)).toHaveAttribute('aria-expanded', 'true');
    await indicator(page).hover();
    await page.clock.runFor(250);
    await expect(details(page)).toBeVisible();
    expect(await details(page).evaluate((element, original) => element === original, preview)).toBe(
      true
    );
    await debugSummary(page).hover();
    await page.clock.runFor(250);
    await expect(details(page)).toBeVisible();
    await page.mouse.move(0, 0);
    await page.clock.runFor(100);
    await expect(indicator(page)).toHaveAttribute('aria-expanded', 'true');
    await page.clock.runFor(100);
    await expect(indicator(page)).toHaveAttribute('aria-expanded', 'false');
    await page.clock.runFor(250);
    await expect(details(page)).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await preview.dispose();
  });

  test('dismisses a hover-only preview with Escape without moving composer focus', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    const composer = page.getByRole('combobox', { name: 'Ask anything…' });
    await composer.focus();
    await indicator(page).hover();
    await fixture.advance(250);
    await expect(details(page)).toBeVisible();
    await expect(composer).toBeFocused();
    await page.keyboard.press('Escape');
    await fixture.advance(500);
    await expect(details(page)).toHaveCount(0);
    await expect(indicator(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(composer).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  });

  test('pins the hover popup when Debug is expanded and preserves it after pointer leave', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await indicator(page).hover();
    await fixture.advance(250);
    await expectDebugCollapsed(page);
    const preview = await details(page).evaluateHandle(element => element);
    const debug = await debugDisclosure(page).evaluateHandle(element => element);
    await debugSummary(page).click();
    await expect(debugDisclosure(page)).toHaveJSProperty('open', true);
    await expect(debugDisclosure(page).locator('dl')).toBeVisible();
    await expectDebugValues(page, runtimeMetadata.kiloCliVersion, runtimeMetadata.wrapperVersion);
    await page.mouse.move(0, 0);
    await fixture.advance(500);
    await expect(details(page)).toHaveCount(1);
    expect(await details(page).evaluate((element, original) => element === original, preview)).toBe(
      true
    );
    expect(
      await debugDisclosure(page).evaluate((element, original) => element === original, debug)
    ).toBe(true);
    await expect(debugDisclosure(page)).toHaveJSProperty('open', true);
    await expect(debugDisclosure(page).locator('dl')).toBeVisible();
    await expect(debugSummary(page)).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Ask anything…' }).click();
    await fixture.advance(250);
    await expect(details(page)).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Ask anything…' })).toBeFocused();
    await indicator(page).click();
    await expectDebugCollapsed(page);
    await expect(debugSummary(page)).toBeFocused();
    await preview.dispose();
    await debug.dispose();
  });

  test('opens details from keyboard focus and preserves Escape, Tab and outside dismissal', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await page.getByRole('button', { name: 'New terminal' }).focus();
    await page.keyboard.press('Tab');
    await expect(indicator(page)).toBeFocused();
    await expect(indicator(page)).not.toHaveCSS('box-shadow', 'none');
    await page.keyboard.press('Enter');
    await fixture.advance(250);
    await expect(details(page)).toBeVisible();
    await expectDebugCollapsed(page);
    await expect(debugSummary(page)).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await fixture.advance(250);
    await expect(details(page)).toHaveCount(0);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(indicator(page)).toBeFocused();
    await page.keyboard.press('Space');
    await fixture.advance(250);
    await expect(details(page)).toBeVisible();
    await expectDebugCollapsed(page);
    await expect(debugSummary(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Mute completion sounds' })).toBeFocused();
    await expect(details(page)).toHaveCount(0);
    await indicator(page).click();
    await expect(details(page)).toBeVisible();
    await page.getByRole('combobox', { name: 'Ask anything…' }).click();
    await expect(details(page)).toHaveCount(0);
    await expectStaticIndicator(page);
    await expectToolbarGeometry(page);
  });

  for (const key of ['Enter', 'Space']) {
    test(`toggles Debug with ${key} and collapses it on reopen`, async ({ page }) => {
      const fixture = await mountFixtures(page);
      await fixture.open();
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
      await indicator(page).focus();
      await page.keyboard.press(key);
      await fixture.advance(250);
      await expectDebugCollapsed(page);
      await expect(debugSummary(page)).toBeFocused();
      await page.keyboard.press(key);
      await expect(debugDisclosure(page)).toHaveJSProperty('open', true);
      await expect(debugDisclosure(page).locator('dl')).toBeVisible();
      await expectDebugValues(page, runtimeMetadata.kiloCliVersion, runtimeMetadata.wrapperVersion);
      await expect(debugSummary(page)).toBeFocused();
      await page.keyboard.press(key);
      await expectDebugCollapsed(page);
      await page.keyboard.press(key);
      await expect(debugDisclosure(page)).toHaveJSProperty('open', true);
      await page.keyboard.press('Escape');
      await fixture.advance(250);
      await expect(details(page)).toHaveCount(0);
      await expect(indicator(page)).toBeFocused();
      await expect(indicator(page)).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press(key);
      await fixture.advance(250);
      await expectDebugCollapsed(page);
      await expect(debugSummary(page)).toBeFocused();
    });
  }

  for (const focusTarget of ['Debug summary', 'dialog container']) {
    for (const key of ['Tab', 'Shift+Tab', 'Escape']) {
      test(`handles ${key} from the ${focusTarget} without trapping focus`, async ({ page }) => {
        const fixture = await mountFixtures(page);
        await fixture.open();
        await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
        await indicator(page).click();
        await expectDebugCollapsed(page);
        await expect(debugSummary(page)).toBeFocused();
        if (focusTarget === 'dialog container') {
          await detailValue(details(page), 'Provider').click();
          await expect(details(page)).toBeFocused();
        } else {
          await page.keyboard.press('Space');
          await expect(debugDisclosure(page).locator('dl')).toBeVisible();
          await expect(debugSummary(page)).toBeFocused();
        }
        await page.keyboard.press(key);
        if (focusTarget === 'dialog container' && key === 'Tab') {
          await expect(details(page)).toBeVisible();
          await expect(debugSummary(page)).toBeFocused();
          await expectDebugCollapsed(page);
          await page.keyboard.press('Tab');
        }
        await fixture.advance(250);
        await expect(details(page)).toHaveCount(0);
        await expect(page.getByRole('tooltip')).toHaveCount(0);
        const destination =
          key === 'Tab'
            ? page.getByRole('button', { name: 'Mute completion sounds' })
            : key === 'Shift+Tab'
              ? page.getByRole('button', { name: 'New terminal' })
              : indicator(page);
        await expect(destination).toBeFocused();
      });
    }
  }

  test('shows a static Unknown badge for initial loading and never guesses Starting', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    const pending = deferred<RpcResult>();
    fixture.setReply(() => pending.promise);
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    await expectStaticIndicator(page);
    await indicator(page).click();
    await expectUnavailableRuntime(page);
    await expect(details(page)).not.toContainText(/Checking|Starting/);
    await fixture.advance(20_000);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    await expectStaticIndicator(page);
    const delayedResponse = page.waitForResponse(response =>
      response.url().includes('getSandboxStatus')
    );
    pending.resolve(
      success(
        fixture.snapshot({
          status: 'sleeping',
          detailCode: 'sandbox_stopped',
          estimatedSleepAt: null,
        })
      )
    );
    await (await delayedResponse).finished();
    await expect(details(page)).toContainText('out of date');
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    fixture.setReply(() =>
      success(
        fixture.snapshot({
          status: 'sleeping',
          detailCode: 'sandbox_stopped',
          estimatedSleepAt: null,
        })
      )
    );
    await fixture.refresh();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping');
  });

  test('polls every five seconds while idle or sleeping, but not hidden or offline', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    fixture.setReply(() =>
      success(
        fixture.snapshot({
          status: 'sleeping',
          detailCode: 'sandbox_stopped',
          estimatedSleepAt: null,
        })
      )
    );
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping');
    const initial = fixture.statusRequests.length;
    await fixture.advance(3_000);
    expect(fixture.statusRequests).toHaveLength(initial);
    await fixture.advance(2_000);
    await expect.poll(() => fixture.statusRequests.length).toBe(initial + 1);
    const pollDelay = fixture.statusRequests[initial].at - fixture.statusRequests[initial - 1].at;
    expect(pollDelay).toBeGreaterThanOrEqual(5_000);
    expect(pollDelay).toBeLessThan(7_000);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping');
    await fixture.advance(5_000);
    await expect.poll(() => fixture.statusRequests.length).toBe(initial + 2);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    const hiddenCount = fixture.statusRequests.length;
    await fixture.advance(20_000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(fixture.statusRequests).toHaveLength(hiddenCount);
    const resumed = deferred<RpcResult>();
    fixture.setReply(() => resumed.promise);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => fixture.statusRequests.length).toBeGreaterThan(hiddenCount);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    resumed.resolve(success(fixture.snapshot()));
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await page.context().setOffline(true);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    const offlineCount = fixture.statusRequests.length;
    await fixture.advance(20_000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(fixture.statusRequests).toHaveLength(offlineCount);
    fixture.setReply(() => success(fixture.snapshot()));
    await page.context().setOffline(false);
    await expect.poll(() => fixture.statusRequests.length).toBeGreaterThan(offlineCount);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await fixture.refresh();
  });

  for (const code of ['INTERNAL_SERVER_ERROR', 'UNAUTHORIZED', 'FORBIDDEN']) {
    test(`suppresses cached status and estimates immediately on ${code}`, async ({ page }) => {
      const fixture = await mountFixtures(page);
      await fixture.open();
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
      await indicator(page).click();
      await expect(sleepTime(page)).toHaveText('About 3 min if inactive');
      await debugSummary(page).click();
      await expect(debugDisclosure(page).locator('dl')).toBeVisible();
      await expectDebugValues(page, runtimeMetadata.kiloCliVersion, runtimeMetadata.wrapperVersion);
      fixture.setReply(() => failure(code));
      await fixture.refresh();
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
      await expect(details(page)).toContainText('does not mean the sandbox failed');
      await expect(sleepTime(page)).toHaveCount(0);
      await expectUnavailableRuntime(page);
      await expect(debugDisclosure(page).locator('dl')).toBeVisible();
      await expectSafe(page);
      fixture.setReply(() => success(fixture.snapshot()));
      await fixture.refresh();
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
      await expect(sleepTime(page)).toHaveText('About 3 min if inactive');
      await expectDebugValues(page, runtimeMetadata.kiloCliVersion, runtimeMetadata.wrapperVersion);
    });
  }

  test('waits two minutes of confirmed idle time before showing the sleep estimate', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    fixture.setReply(() =>
      success(fixture.snapshot({ estimatedSleepAt: fixture.statusRequests[0].at + 300_000 }))
    );
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await indicator(page).click();
    await expect(sleepTime(page)).toHaveCount(0);
    await expect(detailValue(details(page), 'Started').locator('time')).toBeVisible();
    const deadline = fixture.statusRequests[0].at + 300_000;
    const visibleAt = deadline - 300_000 + 120_000;
    const pending = deferred<RpcResult>();
    fixture.setReply(() => pending.promise);
    await fixture.refresh();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    await fixture.advance(visibleAt - 10_000 - (await page.evaluate(() => Date.now())));
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    await page.clock.resume();
    const delayedResponse = page.waitForResponse(response =>
      response.url().includes('getSandboxStatus')
    );
    pending.resolve(success(await fixture.currentSnapshot({ estimatedSleepAt: deadline })));
    await (await delayedResponse).finished();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    fixture.setReply(() => success(fixture.snapshot({ estimatedSleepAt: deadline })));
    await fixture.refresh();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    fixture.setReply(() => new Promise(() => {}));
    await fixture.refresh();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    await settlePausedStatus(page, 'Active');
    await fixture.advance(visibleAt - 1_000 - (await page.evaluate(() => Date.now())));
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await expect(sleepTime(page)).toHaveCount(0);
    const beforeEstimate = fixture.statusRequests.length;
    await fixture.advance(2_000);
    await expect(sleepTime(page)).toHaveAttribute('datetime', new Date(deadline).toISOString());
    await expect(sleepTime(page)).toHaveText('About 3 min if inactive');
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    expect(fixture.statusRequests).toHaveLength(beforeEstimate);
  });

  test('does not reveal sleep timing early when a delayed response reports less than two minutes idle', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    await page.clock.setFixedTime(baseTime);
    const pending = deferred<RpcResult>();
    fixture.setReply(() => pending.promise);
    await fixture.open();
    await expect.poll(() => fixture.statusRequests.length).toBe(1);
    await indicator(page).click();
    await page.clock.setSystemTime(baseTime);
    await page.clock.pauseAt(baseTime + 1_000);
    await fixture.advance(9_000);
    pending.resolve(
      success(
        fixture.snapshot({
          observedAt: baseTime + 10_000,
          estimatedSleepAt: baseTime + 200_000,
        })
      )
    );
    await settlePausedStatus(page, 'Active');
    await expect(detailValue(details(page), 'Provider')).toHaveText('Cloudflare');
    await expect(sleepTime(page)).toHaveCount(0);
    fixture.setReply(() => new Promise(() => {}));
    await fixture.advance(4_000);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await expect(sleepTime(page)).toHaveCount(0);
    await fixture.advance(1_000);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    await expect(details(page)).toContainText('out of date');
    await expectUnavailableRuntime(page);
  });

  for (const serverOffsetMs of [-20_000, 20_000]) {
    test(`keeps fresh runtime and a local countdown when the browser clock is ${serverOffsetMs < 0 ? 'ahead of' : 'behind'} the server`, async ({
      page,
    }) => {
      const fixture = await mountFixtures(page);
      fixture.setReply(request =>
        success(
          fixture.snapshot({
            observedAt: request.at + serverOffsetMs,
            estimatedSleepAt: request.at + serverOffsetMs + 130_000,
          })
        )
      );
      await fixture.open();
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
      await indicator(page).click();
      await expect(detailValue(details(page), 'Provider')).toHaveText('Cloudflare');
      await expect(detailValue(details(page), 'Sandbox type')).toHaveText('Standard');
      await debugSummary(page).click();
      await expectDebugValues(page, runtimeMetadata.kiloCliVersion, runtimeMetadata.wrapperVersion);
      await expect(detailValue(details(page), 'Started').locator('time')).toHaveAttribute(
        'datetime',
        new Date(runtimeMetadata.startedAt).toISOString()
      );
      await expect(sleepTime(page)).toHaveText('About 3 min if inactive');
      const requestAt = fixture.statusRequests[0].at;
      const serverDeadline = new Date(requestAt + serverOffsetMs + 130_000).toISOString();
      await expect(sleepTime(page)).toHaveAttribute('datetime', serverDeadline);
      const pending = deferred<RpcResult>();
      fixture.setReply(() => pending.promise);
      await fixture.refresh();
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
      const requestCount = fixture.statusRequests.length;
      await fixture.advance(requestAt + 11_000 - (await page.evaluate(() => Date.now())));
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
      await expect(sleepTime(page)).toHaveText('About 2 min if inactive');
      await expect(sleepTime(page)).toHaveAttribute('datetime', serverDeadline);
      await expect(detailValue(details(page), 'Provider')).toHaveText('Cloudflare');
      await expectDebugValues(page, runtimeMetadata.kiloCliVersion, runtimeMetadata.wrapperVersion);
      expect(fixture.statusRequests).toHaveLength(requestCount);
      await expectSafe(page);
    });
  }

  test('updates the relative countdown at a minute boundary without another status response', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    fixture.setReply(() =>
      success(fixture.snapshot({ estimatedSleepAt: fixture.statusRequests[0].at + 130_000 }))
    );
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await indicator(page).click();
    await expect(sleepTime(page)).toHaveText('About 3 min if inactive');
    const deadline = fixture.statusRequests[0].at + 130_000;
    const pending = deferred<RpcResult>();
    fixture.setReply(() => pending.promise);
    await fixture.refresh();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    await fixture.advance(deadline - 121_000 - (await page.evaluate(() => Date.now())));
    await expect(sleepTime(page)).toHaveText('About 3 min if inactive');
    await expect(sleepTime(page)).toHaveAttribute('datetime', new Date(deadline).toISOString());
    const beforeBoundary = fixture.statusRequests.length;
    await fixture.advance(1_000);
    await expect(sleepTime(page)).toHaveText('About 2 min if inactive');
    await expect(sleepTime(page)).toHaveAttribute('datetime', new Date(deadline).toISOString());
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    expect(fixture.statusRequests).toHaveLength(beforeBoundary);
  });

  test('warns in the final minute and remains Active at expiry until authoritative sleep', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    fixture.setReply(() =>
      success(fixture.snapshot({ estimatedSleepAt: fixture.statusRequests[0].at + 70_000 }))
    );
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await indicator(page).click();
    await expect(sleepTime(page)).toBeVisible();
    const deadline = fixture.statusRequests[0].at + 70_000;
    const pending = deferred<RpcResult>();
    fixture.setReply(() => pending.promise);
    await fixture.refresh();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    await fixture.advance(deadline - 61_000 - (await page.evaluate(() => Date.now())));
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await expect(sleepTime(page)).toHaveText('About 2 min if inactive');
    const beforeWarning = fixture.statusRequests.length;
    await fixture.advance(1_000);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping soon');
    await expect(details(page).getByText('Sleeping soon', { exact: true })).toBeVisible();
    await expect(sleepTime(page)).toHaveText('About 1 min if inactive');
    await expect(sleepTime(page)).toHaveAttribute('datetime', new Date(deadline).toISOString());
    await expectStaticIndicator(page);
    expect(fixture.statusRequests).toHaveLength(beforeWarning);
    await fixture.advance(deadline - 10_000 - (await page.evaluate(() => Date.now())));
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    await page.clock.resume();
    const delayedResponse = page.waitForResponse(response =>
      response.url().includes('getSandboxStatus')
    );
    pending.resolve(success(await fixture.currentSnapshot({ estimatedSleepAt: deadline })));
    await (await delayedResponse).finished();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    fixture.setReply(() => success(fixture.snapshot({ estimatedSleepAt: deadline })));
    await fixture.refresh();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping soon');
    const sleepResponse = deferred<RpcResult>();
    fixture.setReply(() => sleepResponse.promise);
    await fixture.refresh();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    await settlePausedStatus(page, 'Sleeping soon');
    await fixture.advance(deadline - 1_000 - (await page.evaluate(() => Date.now())));
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping soon');
    await expect(sleepTime(page)).toHaveText('About 1 min if inactive');
    const beforeExpiry = fixture.statusRequests.length;
    await fixture.advance(1_000);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await expect(sleepTime(page)).toHaveCount(0);
    expect(fixture.statusRequests).toHaveLength(beforeExpiry);
    await page.clock.resume();
    sleepResponse.resolve(
      success(
        await fixture.currentSnapshot({
          status: 'sleeping',
          detailCode: 'sandbox_stopped',
          estimatedSleepAt: null,
          runtime: { ...runtimeMetadata, stoppedAt: deadline },
        })
      )
    );
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping');
    await expect(detailValue(details(page), 'Stopped').locator('time')).toHaveAttribute(
      'datetime',
      new Date(deadline).toISOString()
    );
  });

  test('expires hung and stale observations within fifteen seconds without inventing sleep', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    fixture.setReply(request =>
      success(fixture.snapshot({ estimatedSleepAt: request.at + 2_000 }))
    );
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping soon');
    await indicator(page).click();
    await expect(sleepTime(page)).toBeVisible();
    const pending = deferred<RpcResult>();
    fixture.setReply(() => pending.promise);
    await fixture.advance(2_000);
    await expect(sleepTime(page)).toHaveCount(0);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    const freshUntil = fixture.statusRequests[0].at + 15_000;
    const beforeExpiry = freshUntil - 2_000 - (await page.evaluate(() => Date.now()));
    await fixture.advance(Math.max(0, beforeExpiry));
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    const remaining = freshUntil - (await page.evaluate(() => Date.now()));
    await fixture.advance(Math.max(0, remaining));
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    await fixture.advance(15_000);
    pending.resolve(success(await fixture.currentSnapshot()));
    await expect(details(page)).toContainText('out of date');
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    await expectUnavailableRuntime(page);
    fixture.setReply(() => success(fixture.snapshot()));
    await fixture.refresh();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
  });

  test('expires a hung observation when its deadline callback sees an earlier wall clock', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await indicator(page).click();
    await expect(sleepTime(page)).toBeVisible();
    const pending = deferred<RpcResult>();
    fixture.setReply(() => pending.promise);
    await fixture.refresh();
    const pendingRequestCount = fixture.statusRequests.length;
    const observedAt = fixture.statusRequests[0].at;
    await page.clock.setFixedTime(observedAt + 14_999);
    await fixture.advance(20_000);
    expect(await page.evaluate(() => Date.now())).toBe(observedAt + 14_999);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    await page.clock.setFixedTime(observedAt + 20_000);
    await fixture.advance(10_000);
    expect(fixture.statusRequests).toHaveLength(pendingRequestCount);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    await expect(details(page)).toContainText('out of date');
    await expectUnavailableRuntime(page);
    await expect(sleepTime(page)).toHaveCount(0);
    const delayedResponse = page.waitForResponse(response =>
      response.url().includes('getSandboxStatus')
    );
    pending.resolve(success(await fixture.currentSnapshot()));
    await (await delayedResponse).finished();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    fixture.setReply(() => success(fixture.snapshot()));
    await fixture.refresh();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await expect(sleepTime(page)).toBeVisible();
  });

  test('invalidates idle estimates during activity until fresh idle evidence arrives', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await indicator(page).click();
    await expect(sleepTime(page)).toBeVisible();
    await fixture.advance(1_000);
    await fixture.activity(firstWorkspace, 'busy');
    await expect(sleepTime(page)).toHaveCount(0);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await fixture.advance(1_000);
    await fixture.activity(firstWorkspace, 'idle');
    await expect(sleepTime(page)).toHaveCount(0);
    await fixture.refresh();
    await expect(sleepTime(page)).toBeVisible();
    fixture.setReply(() => success(fixture.snapshot({ estimatedSleepAt: null })));
    await fixture.refresh();
    await expect(sleepTime(page)).toHaveCount(0);
  });

  test('isolates sessions when delayed requests resolve out of order and on return navigation', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    const pending = deferred<RpcResult>();
    fixture.setReply(request =>
      request.cloudAgentSessionId === firstWorkspace
        ? pending.promise
        : success(
            fixture.snapshot({
              status: 'sleeping',
              detailCode: 'sandbox_stopped',
              provider: 'Vercel',
              estimatedSleepAt: null,
            })
          )
    );
    await fixture.refresh();
    await fixture.navigate(secondId);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping');
    pending.resolve(
      success(
        fixture.snapshot({ status: 'error', detailCode: 'sandbox_failed', estimatedSleepAt: null })
      )
    );
    await fixture.advance(1);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping');
    await indicator(page).click();
    await expect(detailValue(details(page), 'Provider')).toHaveText('Vercel');
    const returning = deferred<RpcResult>();
    fixture.setReply(() => returning.promise);
    await fixture.navigate(firstId);
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
    returning.resolve(success(await fixture.currentSnapshot()));
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    expect(fixture.statusRequests.some(r => r.cloudAgentSessionId === secondWorkspace)).toBe(true);
  });

  test('isolates personal and organization status in one QueryClient across pending requests and return navigation', async ({
    page,
  }) => {
    await withOrganization(page, async organizationId => {
      const organizationName = 'Sandbox status browser regression organization';
      const session: SessionFixture = {
        id: firstId,
        cloudId: firstWorkspace,
        title: 'Scoped sandbox chat',
      };
      const fixture = await mountFixtures(page, [session]);
      await fixture.open();
      const originalDocument = await page.evaluateHandle(() => document);
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
      await indicator(page).click();
      await expect(detailValue(details(page), 'Provider')).toHaveText('Cloudflare');
      await expect(sleepTime(page)).toBeVisible();
      await page.keyboard.press('Escape');

      async function switchScope(toOrganization: boolean) {
        session.organizationId = toOrganization ? organizationId : undefined;
        await page
          .getByRole('button', {
            name: toOrganization ? 'Personal Personal Workspace' : `${organizationName} Member`,
            exact: true,
          })
          .click();
        await page
          .getByRole('menuitem', {
            name: toOrganization ? `${organizationName} Member` : 'Personal Personal Workspace',
            exact: true,
          })
          .click();
        const basePath = toOrganization ? `/organizations/${organizationId}` : '';
        await page.locator(`a[href="${basePath}/cloud"]`).click();
        await page.getByText(session.title, { exact: true }).click();
        await expect(page).toHaveURL(`${basePath}/cloud/chat?sessionId=${firstId}`);
        expect(await originalDocument.evaluate(node => node === document)).toBe(true);
      }

      async function expectPendingUnknown() {
        await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
        await indicator(page).click();
        await expectUnavailableRuntime(page);
        await expect(sleepTime(page)).toHaveCount(0);
      }

      const personalPending = deferred<RpcResult>();
      const organizationInitial = deferred<RpcResult>();
      fixture.setReply(request =>
        request.organizationId ? organizationInitial.promise : personalPending.promise
      );
      await fixture.refresh();
      await switchScope(true);
      await expectPendingUnknown();
      personalPending.resolve(success(await fixture.currentSnapshot()));
      await fixture.advance(250);
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
      await expectUnavailableRuntime(page);
      await expect(sleepTime(page)).toHaveCount(0);
      organizationInitial.resolve(
        success(
          await fixture.currentSnapshot({
            status: 'sleeping',
            detailCode: 'sandbox_stopped',
            provider: 'Vercel',
            estimatedSleepAt: null,
          })
        )
      );
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping');
      await expect(detailValue(details(page), 'Provider')).toHaveText('Vercel');
      await expect(sleepTime(page)).toHaveCount(0);
      await page.keyboard.press('Escape');

      const organizationPending = deferred<RpcResult>();
      const personalReturning = deferred<RpcResult>();
      fixture.setReply(request =>
        request.organizationId ? organizationPending.promise : personalReturning.promise
      );
      await fixture.refresh();
      await switchScope(false);
      await expectPendingUnknown();
      organizationPending.resolve(success(await fixture.currentSnapshot({ provider: 'Vercel' })));
      await fixture.advance(250);
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unknown');
      await expectUnavailableRuntime(page);
      await expect(sleepTime(page)).toHaveCount(0);
      personalReturning.resolve(success(await fixture.currentSnapshot()));
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
      await expect(detailValue(details(page), 'Provider')).toHaveText('Cloudflare');
      await expect(sleepTime(page)).toBeVisible();
      await page.keyboard.press('Escape');

      const organizationReturning = deferred<RpcResult>();
      fixture.setReply(() => organizationReturning.promise);
      await switchScope(true);
      await expectPendingUnknown();
      organizationReturning.resolve(
        success(
          await fixture.currentSnapshot({
            status: 'sleeping',
            detailCode: 'sandbox_stopped',
            provider: 'Vercel',
            estimatedSleepAt: null,
          })
        )
      );
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Sleeping');
      await expect(detailValue(details(page), 'Provider')).toHaveText('Vercel');
      await expect(sleepTime(page)).toHaveCount(0);
      expect(
        fixture.statusRequests.some(request => request.organizationId === organizationId)
      ).toBe(true);
      expect(
        fixture.statusRequests.every(request => request.cloudAgentSessionId === firstWorkspace)
      ).toBe(true);
      expect(fixture.procedures).toContain('organizations.cloudAgentNext.getSandboxStatus');
      expect(fixture.procedures).toContain('cloudAgentNext.getSandboxStatus');
      await originalDocument.dispose();
    });
  });

  test('never requests status for excluded contexts, including activity, focus, reconnect and navigation', async ({
    page,
  }) => {
    const sessions: SessionFixture[] = [
      { id: firstId, cloudId: firstWorkspace, title: 'Eligible' },
      { id: 'ses_legacy', cloudId: 'agent_00000000-0000-4000-8000-000000000003', title: 'Legacy' },
      { id: 'ses_placeholder', cloudId: 'Starting session…', title: 'Placeholder' },
      { id: 'ses_remote', cloudId: secondWorkspace, title: 'Remote', kind: 'remote' },
      { id: 'ses_readonly', cloudId: secondWorkspace, title: 'Read only', kind: 'read-only' },
      {
        id: 'ses_wrongscope',
        cloudId: secondWorkspace,
        title: 'Different organization',
        organizationId: '00000000-0000-4000-8000-000000000099',
      },
      { id: 'ses_unrelated', cloudId: null, title: 'Unrelated', kind: 'unrelated' },
      { id: 'ses_unresolved', cloudId: secondWorkspace, title: 'Unresolved', kind: 'unresolved' },
    ];
    const fixture = await mountFixtures(page, sessions);
    await fixture.open();
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    for (const session of sessions.slice(1)) {
      await fixture.navigate(session.id);
      await expect(indicator(page)).toHaveCount(0);
      const count = fixture.statusRequests.length;
      await page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('offline'));
        window.dispatchEvent(new Event('online'));
      });
      await fixture.advance(10_000);
      expect(fixture.statusRequests).toHaveLength(count);
      await expect(indicator(page)).toHaveCount(0);
      if (session.id === 'ses_legacy') {
        await fixture.activity(session.cloudId ?? '', 'busy');
        await fixture.activity(session.cloudId ?? '', 'idle');
        await fixture.advance(5_000);
        expect(fixture.statusRequests).toHaveLength(count);
      }
    }
    await page.goto('/cloud');
    await fixture.advance(10_000);
    await expect(indicator(page)).toHaveCount(0);
    expect(fixture.statusRequests.every(r => r.cloudAgentSessionId === firstWorkspace)).toBe(true);
  });

  test('uses matching hover and keyboard focus highlights for toolbar buttons', async ({
    page,
  }) => {
    const fixture = await mountFixtures(page);
    await fixture.open();
    await page.addStyleTag({ content: 'button { transition: none !important; }' });
    await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
    await expectStaticIndicator(page);
    await expectToolbarGeometry(page);
    const highlights = [];
    for (const button of [
      indicator(page),
      page.getByRole('button', { name: 'Mute completion sounds', exact: true }),
      page.getByRole('button', { name: 'More options', exact: true }),
      page.getByRole('button', { name: 'Send feedback', exact: true }),
    ]) {
      await button.hover();
      await fixture.advance(250);
      const hover = await button.evaluate(element => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color };
      });
      expect(hover.background).not.toBe('rgba(0, 0, 0, 0)');
      await page.mouse.move(0, 0);
      await page.keyboard.press('Tab');
      await button.focus();
      await fixture.advance(250);
      await expect(button).toBeFocused();
      const focus = await button.evaluate(element => getComputedStyle(element).boxShadow);
      expect(focus).not.toBe('none');
      highlights.push({ hover, focus });
    }
    for (const highlight of highlights) expect(highlight).toEqual(highlights[0]);
    await page.getByRole('button', { name: 'Mute completion sounds', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Enable completion sounds', exact: true })
    ).toBeVisible();
    await expectToolbarGeometry(page);
  });

  for (const width of [375, 820, 1440]) {
    test(`keeps compact toolbar controls aligned and usable at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
      const fixture = await mountFixtures(page, [
        {
          id: firstId,
          cloudId: firstWorkspace,
          title:
            'A very long workspace title that must not obstruct sandbox status or other chat controls',
        },
      ]);
      fixture.setReply(() =>
        success(
          fixture.snapshot({
            status: 'unreachable',
            detailCode: 'connection_unavailable',
            estimatedSleepAt: null,
          })
        )
      );
      await fixture.open();
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Unreachable');
      await page.getByRole('button', { name: 'New terminal' }).focus();
      await indicator(page).focus();
      await page.keyboard.press('Enter');
      await fixture.advance(250);
      await expect(details(page)).toBeVisible();
      await expectToolbarGeometry(page);
      await expectStaticIndicator(page);
      await expectDebugCollapsed(page);
      for (const expanded of [false, true]) {
        if (expanded) {
          await debugSummary(page).click();
          await expect(debugDisclosure(page).locator('dl')).toBeVisible();
          await expectDebugValues(
            page,
            runtimeMetadata.kiloCliVersion,
            runtimeMetadata.wrapperVersion
          );
        }
        await expect(details(page)).toHaveCSS('padding', '16px');
        await expect
          .poll(async () => (await details(page).boundingBox())?.width)
          .toBe(Math.min(320, width - 32));
        const popup = await details(page).boundingBox();
        expect(popup?.x).toBeGreaterThanOrEqual(0);
        expect((popup?.x ?? 0) + (popup?.width ?? 0)).toBeLessThanOrEqual(width);
        expect(
          await details(page).evaluate(element => element.scrollWidth <= element.clientWidth)
        ).toBe(true);
        await expectSafe(page);
        await page.screenshot({
          path: testInfo.outputPath(
            `controlled-header-${width}-${expanded ? 'expanded' : 'collapsed'}.png`
          ),
          animations: 'disabled',
        });
      }
      for (const name of [
        'New terminal',
        'Mute completion sounds',
        'More options',
        'Send feedback',
      ]) {
        const control = page.getByRole('button', { name, exact: true });
        await expect(control).toBeVisible();
        const box = await control.boundingBox();
        expect(box?.x).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await expectSafe(page);
      await page.screenshot({ path: testInfo.outputPath(`controlled-header-${width}.png`) });
    });
  }

  test.describe('touch', () => {
    test.use({ hasTouch: true, viewport: { width: 375, height: 812 } });
    test('expands Debug with taps and reopens safe details collapsed', async ({ page }) => {
      const fixture = await mountFixtures(page);
      await fixture.open();
      await expect(indicator(page)).toHaveAccessibleName('Sandbox status: Active');
      await expectStaticIndicator(page, 44);
      await expectToolbarGeometry(page, 44);
      await indicator(page).tap();
      await fixture.advance(250);
      await expect(details(page)).toBeVisible();
      await expect(page.getByRole('tooltip')).toHaveCount(0);
      await expect(detailValue(details(page), 'Provider')).toHaveText('Cloudflare');
      await expect(sleepTime(page)).toHaveText('About 3 min if inactive');
      await expectDebugCollapsed(page);
      await expect(debugSummary(page)).toBeFocused();
      await debugSummary(page).tap();
      await expect(debugDisclosure(page)).toHaveJSProperty('open', true);
      await expect(debugDisclosure(page).locator('dl')).toBeVisible();
      await expectDebugValues(page, runtimeMetadata.kiloCliVersion, runtimeMetadata.wrapperVersion);
      await expect(page.getByRole('tooltip')).toHaveCount(0);
      await expect(details(page)).toHaveCSS('width', '320px');
      expect(
        await details(page).evaluate(element => element.scrollWidth <= element.clientWidth)
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await expectSafe(page);
      await debugSummary(page).tap();
      await expectDebugCollapsed(page);
      await debugSummary(page).tap();
      await expect(debugDisclosure(page)).toHaveJSProperty('open', true);
      await page.getByRole('combobox', { name: 'Ask anything…' }).tap();
      await expect(details(page)).toHaveCount(0);
      await fixture.advance(250);
      await indicator(page).tap();
      await fixture.advance(250);
      await expectDebugCollapsed(page);
      await expect(page.getByRole('tooltip')).toHaveCount(0);
    });
  });
});
