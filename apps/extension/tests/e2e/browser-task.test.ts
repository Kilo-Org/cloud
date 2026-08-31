/* eslint-disable import/no-nodejs-modules, import/max-dependencies, max-lines, no-await-in-loop, jest/no-conditional-in-test, jest/no-conditional-expect, jest/max-expects, jest/prefer-each, init-declarations, typescript/consistent-type-definitions, typescript/no-unsafe-type-assertion -- Playwright has no test.each; fixture casts describe injected page APIs, not product authority. */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page, WebSocketRoute } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import type { browser } from 'wxt/browser';
import { z } from 'zod';
import {
  browserProviderInboundMessageSchema,
  webOutboundWithBrowserMessageSchema,
} from '@kilocode/cloud-agent-sdk/schemas';
import type {
  BrowserJobSnapshot,
  BrowserProviderInboundMessage,
  BrowserResult,
} from '@kilocode/cloud-agent-sdk/schemas';
import { mockAgentsApi } from './agents-fixture';
import {
  launchExtensionContext,
  readExtensionLocalStorage,
  seedExtensionAuth,
  setExtensionStorage,
  startFixtureServer,
} from './extension-context-fixture';
import { dangerousToolNames, mockKiloApi, safeToolNames } from './kilo-api-fixture';
import { selectModelById } from './model-picker-e2e-helpers';

const model = 'deepseek/deepseek-v4-flash-0731';
const owner = `ses_parent_A1_${'long_owner_'.repeat(6)}`;
const executionLock = 'kilo:browser-execution';
const resultText = 'The approved page reports one completed action.';
const content = (text: string) => [{ choices: [{ delta: { content: text } }] }];
const toolCall = (name: string, args: Record<string, unknown>) => [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              function: { arguments: JSON.stringify(args), name },
              id: randomUUID(),
              index: 0,
              type: 'function',
            },
          ],
        },
      },
    ],
  },
];
const binding = (job: BrowserJobSnapshot) => ({
  browserTaskId: job.browserTaskId,
  generation: job.generation,
  invocationId: job.invocationId,
  jobId: job.jobId,
  providerId: job.providerId,
});

type Delivery = Extract<BrowserProviderInboundMessage, { type: 'provider_job' }>;
type Failure = Exclude<BrowserResult['reason'], 'completed'>;

// This peer supplies wire inputs, not runtime proof of the real relay or CLI.
const mockBrowserRelay = async (
  context: BrowserContext,
  input: {
    supported?: boolean;
    registrationError?: boolean;
    silent?: boolean;
    now?: () => number;
  } = {}
) => {
  const options = { registrationError: false, silent: false, supported: true, ...input };
  let socket: WebSocketRoute | undefined;
  let providerId: BrowserJobSnapshot['providerId'] | undefined;
  let generation = 0;
  let fence: { invocationId: string; tabId?: number } | undefined;
  const jobs = new Map<string, BrowserJobSnapshot>();
  const deliveries = new Map<string, Delivery>();
  const results: BrowserResult[] = [];
  const cancellations: string[] = [];
  const send = (message: BrowserProviderInboundMessage): void => {
    if (socket === undefined) {
      throw new Error('The provider has not registered.');
    }
    socket.send(JSON.stringify(browserProviderInboundMessageSchema.parse(message)));
  };
  const snapshot = (): void => {
    if (providerId !== undefined) {
      send({
        generation,
        jobs: [...jobs.values()].filter(job => job.generation === generation),
        providerId,
        type: 'provider_snapshot',
      });
    }
  };
  const settle = (job: BrowserJobSnapshot, result: BrowserResult): void => {
    if (jobs.get(job.jobId)?.result !== undefined) {
      return;
    }
    jobs.set(job.jobId, { ...job, queuePosition: undefined, result, status: result.status });
    snapshot();
  };
  const fail = (job: BrowserJobSnapshot, reason: Failure, uncertain = false): void => {
    let status: Exclude<BrowserResult['status'], 'succeeded'> = 'interrupted';
    if (reason.endsWith('_timeout')) {
      status = 'timed_out';
    } else if (reason === 'cancelled') {
      status = 'cancelled';
    } else if (reason === 'approval_denied') {
      status = 'failed';
    }
    settle(job, {
      browserTaskId: job.browserTaskId,
      effectsUncertain: uncertain,
      evidence: [],
      invocationId: job.invocationId,
      jobId: job.jobId,
      providerId: job.providerId,
      reason,
      status,
      summary: `The relay settled this invocation: ${reason}. Issued actions are not undone.`,
    });
  };
  const dispatch = (delivery: Delivery): void => {
    const job = { ...delivery.job, queuePosition: undefined, status: 'awaiting_approval' as const };
    jobs.set(job.jobId, job);
    fence = { invocationId: job.invocationId };
    send({ ...delivery, job });
  };
  await context.routeWebSocket('wss://ingest.kilosessions.ai/api/user/web**', route => {
    route.send(JSON.stringify({ data: {}, event: 'connected', type: 'system' }));
    route.onMessage(raw => {
      const message = webOutboundWithBrowserMessageSchema.parse(JSON.parse(String(raw)));
      if (message.type === 'ping') {
        if (!options.silent) {
          route.send(
            JSON.stringify({
              capabilities: { browserJobsV1: options.supported },
              nonce: message.nonce,
              type: 'pong',
            })
          );
        }
        return;
      }
      if (message.type === 'provider_register') {
        socket = route;
        ({ providerId } = message);
        if (
          options.registrationError ||
          (fence !== undefined && message.recovery?.invocationId !== fence.invocationId)
        ) {
          route.send(
            JSON.stringify({
              error: {
                code: 'provider_unavailable',
                message: 'Retrieve status before recovery.',
                retryable: true,
              },
              id: message.requestId,
              type: 'response',
            })
          );
          return;
        }
        generation = Math.max(generation, message.generation) + 1;
        fence = undefined;
        send({
          generation,
          leaseExpiresAt: new Date((input.now ?? Date.now)() + 15_000).toISOString(),
          providerId,
          requestId: message.requestId,
          type: 'provider_lease_ack',
        });
      } else if (message.type === 'provider_heartbeat') {
        send({
          generation,
          leaseExpiresAt: new Date((input.now ?? Date.now)() + 15_000).toISOString(),
          providerId: message.providerId,
          requestId: message.requestId,
          type: 'provider_lease_ack',
        });
        send({
          generation,
          jobs: [...jobs.values()].filter(job => job.generation === generation),
          providerId: message.providerId,
          requestId: message.requestId,
          type: 'provider_snapshot',
        });
      } else if (message.type === 'provider_status') {
        route.send(
          JSON.stringify(
            browserProviderInboundMessageSchema.parse({
              jobs: [...jobs.values()],
              providerId: message.providerId,
              requestId: message.requestId,
              type: 'provider_status_result',
              unresolvedFence: fence,
            })
          )
        );
      } else if (message.type === 'provider_approval') {
        const job = jobs.get(message.jobId);
        if (job === undefined) {
          throw new Error('Approval names an unknown job.');
        }
        if (message.approval.decision === 'denied') {
          fail(job, 'approval_denied');
        } else {
          fence = { invocationId: job.invocationId, tabId: message.approval.tab.tabId };
          jobs.set(job.jobId, {
            ...job,
            approvedTab: message.approval.tab,
            deadlines: {
              ...job.deadlines,
              execution: new Date(Date.now() + 600_000).toISOString(),
            },
            status: 'running',
          });
          snapshot();
        }
      } else if (message.type === 'provider_result') {
        const job = jobs.get(message.jobId);
        if (job === undefined) {
          throw new Error('Result names an unknown job.');
        }
        results.push(message.result);
        settle(job, message.result);
      } else if (message.type === 'provider_cancel') {
        const job = jobs.get(message.jobId);
        if (job === undefined) {
          throw new Error('Cancellation names an unknown job.');
        }
        cancellations.push(job.jobId);
        send({ ...binding(job), reason: 'cancelled', type: 'provider_job_cancel' });
        fail(job, 'cancelled');
      } else if (message.type === 'provider_unavailable') {
        for (const job of jobs.values()) {
          if (job.result === undefined) {
            fail(job, message.reason, message.effectsUncertain);
          }
        }
      } else if (message.type === 'provider_quiesced') {
        if (fence?.invocationId === message.invocationId) {
          fence = undefined;
        }
        const next = [...jobs.values()].find(job => job.status === 'queued');
        const delivery = next === undefined ? undefined : deliveries.get(next.jobId);
        if (delivery !== undefined) {
          dispatch(delivery);
        }
      }
    });
  });
  return {
    cancellations,
    dispatch,
    expireResults: () => {
      jobs.clear();
    },
    interrupt: (job: BrowserJobSnapshot, reason: Failure) => {
      send({ ...binding(job), reason, type: 'provider_job_cancel' });
      fail(jobs.get(job.jobId) ?? job, reason, true);
    },
    jobs,
    results,
    send,
    submit: (goal = 'Inspect the approved tab.', ownerLabel = owner, queued = false) => {
      if (providerId === undefined) {
        throw new Error('Enable the provider before submitting work.');
      }
      const now = Date.now();
      const job: BrowserJobSnapshot = {
        browserTaskId: `bt_${randomUUID()}`,
        createdAt: new Date(now).toISOString(),
        deadlines: {
          approval: new Date(now + 120_000).toISOString(),
          queue: new Date(now + 600_000).toISOString(),
        },
        expiresAt: new Date(now + 7 * 86_400_000).toISOString(),
        generation,
        invocationId: `b1.${now}.${createHash('sha256').update(randomUUID()).digest('hex')}`,
        jobId: `bj_${randomUUID()}`,
        ownerLabel,
        payloadFingerprint: createHash('sha256').update(goal).digest('hex'),
        providerId,
        ...(queued
          ? { queuePosition: [...jobs.values()].filter(row => row.status === 'queued').length + 1 }
          : {}),
        status: queued ? 'queued' : 'awaiting_approval',
      };
      const delivery: Delivery = {
        conversationMode: 'new',
        goal,
        job,
        ownerLabel,
        type: 'provider_job',
      };
      jobs.set(job.jobId, job);
      deliveries.set(job.jobId, delivery);
      if (queued) {
        snapshot();
      } else {
        dispatch(delivery);
      }
      return delivery;
    },
  };
};

type Harness = {
  context: BrowserContext;
  panel: Page;
  target: Page;
  other: Page;
  relay: Awaited<ReturnType<typeof mockBrowserRelay>>;
  openPanel: () => Promise<Page>;
};
const withHarness = async (
  run: (harness: Harness) => Promise<void>,
  options: {
    gateway?: Parameters<typeof mockKiloApi>[1];
    relay?: Parameters<typeof mockBrowserRelay>[1];
    init?: (context: BrowserContext) => Promise<void>;
  } = {}
): Promise<void> => {
  const fixture = await startFixtureServer({
    bodyHtml:
      '<button id="effect" onclick="document.querySelector(\'#count\').textContent = String(Number(document.querySelector(\'#count\').textContent) + 1)">Apply once</button><output id="count">0</output><p>Approved evidence A1.</p>',
    pathHtml: {
      '/other':
        '<!doctype html><title>Unapproved tab</title><output id="count">0</output><p>Foreign evidence B1.</p>',
    },
    title: 'Approved browser task tab',
  });
  const launched = await launchExtensionContext({
    recordVideo: {
      dir: test.info().outputPath('videos'),
      size: { height: 720, width: 320 },
    },
  });
  const { context, extensionId } = launched;
  const recordedPages = context.pages();
  context.on('page', page => {
    recordedPages.push(page);
  });
  try {
    await options.init?.(context);
    await mockAgentsApi(context, { activeSessions: [], historySessions: [] });
    await mockKiloApi(context, {
      firstCompletionEvents: content('Observed the requested page.'),
      models: [{ id: model, name: 'DeepSeek V4 Flash' }],
      ...options.gateway,
    });
    const relay = await mockBrowserRelay(context, options.relay);
    const target = await context.newPage();
    await target.goto(fixture.url);
    const other = await context.newPage();
    await other.goto(`${fixture.url}/other`);
    const openPanel = async (): Promise<Page> => {
      const page = await context.newPage();
      expect(page.viewportSize()).toEqual({ height: 720, width: 320 });
      await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      return page;
    };
    const panel = await openPanel();
    await seedExtensionAuth(panel);
    await panel.reload();
    await expect(panel.getByLabel('Message agent')).toBeVisible();
    await run({ context, openPanel, other, panel, relay, target });
  } finally {
    try {
      await context.close();
      for (const [index, page] of recordedPages.entries()) {
        const video = page.video();
        expect.soft(video, 'Mocked browser-task pages must retain video.').not.toBeNull();
        if (video !== null) {
          await test.info().attach(`browser-task-page-${index}`, {
            contentType: 'video/webm',
            path: await video.path(),
          });
        }
      }
    } finally {
      await fixture.close();
      await rm(launched.userDataDir, { force: true, recursive: true });
    }
  }
};
const supervision = (root: Page | Locator) =>
  root.getByRole('region', { name: 'CLI task supervision' });
const enable = async (
  panel: Page,
  dangerous = false,
  expected = 'Enabled — idle'
): Promise<void> => {
  await selectModelById(panel, model);
  await panel.getByLabel('Settings', { exact: true }).click();
  const settings = panel.getByRole('region', { name: 'CLI task settings' });
  await expect(settings.getByRole('switch', { exact: true, name: 'CLI tasks' })).toHaveAttribute(
    'aria-checked',
    'false'
  );
  await expect(settings.getByRole('switch', { exact: true, name: 'CLI tasks' })).toBeDisabled();
  // The existing model helper targets the local composer. Delegated settings have their own model trigger.
  await settings.getByLabel('Model', { exact: true }).click();
  await panel
    .getByRole('dialog', { name: 'Select model' })
    .locator(`button[data-model-id="${model}"]`)
    .click();
  await expect(settings.getByLabel('Model', { exact: true })).toHaveAttribute(
    'data-model-id',
    model
  );
  if (dangerous) {
    await settings.getByRole('button', { name: /Safe mode/u }).click();
    await settings
      .getByRole('button', { exact: true, name: 'Dangerous Arbitrary webpage control' })
      .click();
  }
  await expect(
    settings.getByRole('button', { name: dangerous ? /^Danger mode:/u : /^Safe mode:/u })
  ).toBeVisible();
  await settings.getByRole('switch', { exact: true, name: 'CLI tasks' }).click();
  await expect(settings.getByRole('switch', { exact: true, name: 'CLI tasks' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await panel.getByLabel('Close settings').click();
  await expect(supervision(panel)).toContainText(`CLI tasks: ${expected}`);
};
const approve = async (root: Page | Locator): Promise<void> => {
  const controls = supervision(root);
  await expect(controls.getByRole('button', { exact: true, name: 'Approve tab' })).toBeDisabled();
  await controls.getByLabel('Tab to approve').selectOption({ label: 'Approved browser task tab' });
  await controls.getByRole('button', { exact: true, name: 'Approve tab' }).click();
};
const capture = async (panel: Page, name: string): Promise<void> => {
  expect(panel.viewportSize()).toEqual({ height: 720, width: 320 });
  const viewport = await panel.evaluate(() => ({
    height: innerHeight,
    scale: visualViewport?.scale,
    visibility: document.visibilityState,
    width: innerWidth,
  }));
  await test.info().attach(`${name}-viewport`, {
    body: JSON.stringify(viewport, null, 2),
    contentType: 'application/json',
  });
  expect(viewport).toMatchObject({ height: 720, scale: 1, width: 320 });
  const dialogs = panel.getByRole('dialog');
  const root = (await dialogs.count()) > 0 ? dialogs.last() : panel;
  const stop = supervision(root).getByRole('button', { name: 'Stop CLI task' });
  if ((await stop.count()) > 0) {
    await expect(stop).toBeInViewport({ ratio: 1 });
    const box = await stop.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(32);
    expect(box?.width).toBeGreaterThanOrEqual(32);
  }
  expect(
    await panel.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
  const path = test.info().outputPath(`${name}.png`);
  await panel.screenshot({ path });
  await test.info().attach(name, { contentType: 'image/png', path });
};
const keyboardReach = async (panel: Page, control: Locator, dialog?: Locator): Promise<void> => {
  for (let step = 0; step < 100; step += 1) {
    if (await control.evaluate(element => element === document.activeElement)) {
      return;
    }
    await panel.keyboard.press('Tab');
    if (dialog !== undefined) {
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
  }
  await expect(control).toBeFocused();
};
const assertSupervision = async (root: Page | Locator): Promise<void> => {
  const controls = supervision(root);
  await expect(controls.getByText(`Owner session: ${owner}`, { exact: false })).toBeVisible();
  await expect(controls.getByText(/Bound tab: Approved browser task tab/u)).toBeVisible();
  await expect(controls.getByRole('button', { name: 'Stop CLI task' })).toBeVisible();
};

test.setTimeout(90_000);
for (const mode of ['Browser', 'Agents'] as const) {
  test(`${mode}: disabled, idle, consent, queue, bound tab, and one execution after duplicate delivery`, async () => {
    const completion = Promise.withResolvers<void>();
    await withHarness(
      async ({ panel, target, other, relay }) => {
        await target.goto(`${target.url()}?detail=${'long-path-segment-'.repeat(80)}`);
        await expect(supervision(panel)).toContainText('CLI tasks: Disabled');
        await capture(panel, `${mode}-disabled`);
        await enable(panel, true);
        await panel.getByRole('tab', { exact: true, name: mode }).click();
        await expect(supervision(panel)).toContainText('Enabled — idle');
        await expect(supervision(panel)).toContainText('Queue empty.');
        await expect(supervision(panel)).not.toContainText('Owner session:');
        await capture(panel, `${mode}-idle`);
        const delivery = relay.submit(
          `Read the approved page and apply exactly one action. ${'Long goal with a long URL https://example.test/path/'.repeat(24)}`
        );
        await expect(supervision(panel)).toContainText('Tab approval required');
        await expect(target.locator('#count')).toHaveText('0');
        await capture(panel, `${mode}-approval-320px`);
        await approve(panel);
        await expect(supervision(panel)).toContainText('CLI tasks: Running');
        await other.bringToFront();
        await panel.bringToFront();
        relay.send(delivery);
        const queued = relay.submit(
          'Foreign goal B1 must not enter A1 history.',
          'ses_parent_B1_distinct_owner',
          true
        );
        await expect(panel.getByRole('list', { name: 'Queued CLI tasks' })).toContainText(
          'Queue position: 1'
        );
        await expect(panel.getByRole('list', { name: 'Queued CLI tasks' })).toContainText(
          'ses_parent_B1'
        );
        await expect(panel.getByRole('list', { name: 'Queued CLI tasks' })).toContainText(
          'Queue deadline:'
        );
        await capture(panel, `${mode}-running-queued-320px`);
        await panel
          .getByRole('button', { name: `Cancel queued task ${queued.job.jobId.slice(-8)}` })
          .click();
        await expect(supervision(panel)).toContainText('Queue empty.');
        completion.resolve();
        await expect(target.locator('#count')).toHaveText('1');
        await expect(other.locator('#count')).toHaveText('0');
        await expect(supervision(panel)).toContainText(resultText);
        await expect(supervision(panel)).toContainText('Last outcome: succeeded');
        await expect(supervision(panel).getByRole('button', { name: 'Stop CLI task' })).toHaveCount(
          0
        );
        await panel.reload();
        await expect(supervision(panel)).toContainText(resultText);
        await expect(target.locator('#count')).toHaveText('1');
        await expect(
          supervision(panel).getByRole('button', { exact: true, name: 'Approve tab' })
        ).toHaveCount(0);
      },
      {
        gateway: {
          beforeFirstCompletion: () => completion.promise,
          firstCompletionEvents: toolCall('eval', {
            code: 'document.querySelector("#effect").click(); return document.querySelector("#count").textContent;',
          }),
          secondCompletionEvents: content(resultText),
          toolNames: dangerousToolNames,
        },
      }
    );
  });

  test(`${mode}: Reject leaves the target untouched and removes consent after reload`, async () => {
    await withHarness(async ({ panel, target, relay }) => {
      await enable(panel);
      await panel.getByRole('tab', { exact: true, name: mode }).click();
      relay.submit();
      await supervision(panel).getByRole('button', { exact: true, name: 'Reject' }).click();
      await expect(supervision(panel)).toContainText('approval_denied');
      await expect(supervision(panel)).toContainText('No observed evidence.');
      await expect(target.locator('#count')).toHaveText('0');
      await panel.reload();
      await expect(supervision(panel)).toContainText('approval_denied');
      await expect(panel.getByRole('button', { exact: true, name: 'Approve tab' })).toHaveCount(0);
      await capture(panel, `${mode}-denied-empty-evidence`);
    });
  });

  test(`${mode}: Stop invalidates an open delegated workflow approval, including persisted reload`, async () => {
    await withHarness(
      async ({ panel, target, relay }) => {
        await enable(panel);
        await panel.getByRole('tab', { exact: true, name: mode }).click();
        relay.submit('Save the proposed workflow only after explicit approval.');
        await approve(panel);
        const dialog = panel.getByRole('dialog', { name: 'Save workflow' });
        await expect(dialog).toBeVisible();
        await assertSupervision(dialog);
        await keyboardReach(panel, dialog.getByRole('button', { name: 'Stop CLI task' }), dialog);
        await capture(panel, `${mode}-workflow-approval`);
        await panel.keyboard.press('Enter');
        await expect(dialog).toBeHidden();
        await expect(supervision(panel)).toContainText('cancelled');
        await panel.reload();
        await expect(panel.getByLabel('Message agent')).toBeAttached();
        await expect(dialog).toHaveCount(0);
        await expect(panel.getByRole('button', { name: 'Approve and save' })).toHaveCount(0);
        expect(await readExtensionLocalStorage(panel, 'kiloAgentWorkflows')).toBeUndefined();
        await expect(target.locator('#count')).toHaveText('0');
      },
      {
        gateway: {
          firstCompletionEvents: toolCall('save_workflow', {
            description: 'Read an approved page.',
            name: 'Delegated workflow',
            scopeOrigin: 'https://example.test',
            script: 'return { done: true, result: await page.text("h1") };',
          }),
          toolNames: safeToolNames,
        },
      }
    );
  });
}

const heldExecutionModes = (panel: Page): Promise<(LockMode | undefined)[]> =>
  panel.evaluate(async name => {
    const state = await navigator.locks.query();
    return (state.held ?? []).filter(lock => lock.name === name).map(lock => lock.mode);
  }, executionLock);

test('two panels share local locks, drain before delegation, and retain a blocked local draft', async () => {
  const localCompletions = Promise.withResolvers<void>();
  await withHarness(async ({ panel, openPanel, context, relay }) => {
    await enable(panel);
    const second = await openPanel();
    await expect(supervision(second)).toContainText('Ownership not acquired');
    await context.route('**/api/gateway/v1/chat/completions', async route => {
      await localCompletions.promise;
      await route.abort();
    });
    for (const page of [panel, second]) {
      await page.getByLabel('Message agent').fill('Keep this local run open.');
      await page.getByLabel('Message agent').press('Enter');
      await expect(page.getByRole('button', { exact: true, name: 'Stop' })).toBeVisible();
    }
    await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared', 'shared']);
    const reload = supervision(second).getByRole('button', { name: 'Reload panel' });
    await expect(reload).toBeDisabled();
    relay.submit();
    await approve(panel);
    await expect(supervision(panel)).toContainText('Waiting for browser control');
    await expect(reload).toBeDisabled();
    for (const page of [panel, second]) {
      await page.getByRole('button', { exact: true, name: 'Stop' }).click();
    }
    await expect(supervision(panel)).toContainText('CLI tasks: Running');
    await expect.poll(() => heldExecutionModes(panel)).toEqual(['exclusive']);
    await expect(reload).toBeDisabled();
    await second.getByLabel('Message agent').fill('Preserve my unsent local draft.');
    await second.getByLabel('Message agent').press('Enter');
    await expect(second.getByLabel('Message agent')).toHaveValue('Preserve my unsent local draft.');
    await expect(second.getByText(/owns browser control/u).first()).toBeVisible();
    await supervision(panel).getByRole('button', { name: 'Stop CLI task' }).click();
    await expect(supervision(panel)).toContainText('cancelled');
    localCompletions.resolve();
    await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
    await expect(reload).toBeEnabled();
    await expect(second.getByLabel('Message agent')).toHaveValue('Preserve my unsent local draft.');
    await expect(second.getByRole('button', { name: 'Send message' })).toBeVisible();
  });
});

const heldProviderLocks = (panel: Page): Promise<LockInfo[]> =>
  panel.evaluate(async () => {
    const state = await navigator.locks.query();
    return (state.held ?? []).filter(lock => lock.name === 'kilo:browser-provider-owner');
  });

for (const profile of ['enabled', 'quarantined'] as const) {
  test(`native ownership retry preserves the ${profile} profile after explicit reload`, async () => {
    await withHarness(
      async ({ panel, openPanel, context, relay, target, other }) => {
        let requests = 0;
        context.on('request', request => {
          if (request.url().endsWith('/api/gateway/v1/chat/completions')) {
            requests += 1;
          }
        });
        const quarantined = profile === 'quarantined';
        const phase = quarantined ? 'Recovery required' : 'Enabled — idle';
        await setExtensionStorage(panel, {
          kiloBrowserExecutionSafety: {
            ...(quarantined ? { allTabs: true } : {}),
            tabIds: [],
            version: 1,
          },
        });
        await enable(panel, true, phase);
        const saved = await Promise.all(
          [
            'kiloAuth',
            'kiloBrowserProviderIdentity',
            'kiloBrowserProviderSettings',
            'kiloBrowserExecutionSafety',
          ].map(async key => ({ key, value: await readExtensionLocalStorage(panel, key) }))
        );
        const ownerLocks = await heldProviderLocks(panel);
        expect(ownerLocks).toEqual([
          expect.objectContaining({ clientId: expect.any(String), mode: 'exclusive' }),
        ]);
        if (quarantined) {
          const name = 'native-ownership-quarantined-original-owner-320px';
          const conversation = panel.getByRole('region', { name: 'Agent conversation' });
          await expect(
            conversation.locator('xpath=../following-sibling::p[@role="status"]')
          ).toBeVisible();
          await capture(panel, name);
          const geometry = await conversation.evaluate(section => {
            const viewport = section.parentElement;
            const greeting = section.querySelector(':scope > p');
            const warning = viewport?.nextElementSibling;
            if (
              viewport === null ||
              greeting === null ||
              !(warning instanceof HTMLElement) ||
              !warning.matches('p[role="status"]')
            ) {
              throw new Error('The empty conversation must precede the admission warning.');
            }
            // eslint-disable-next-line unicorn/consistent-function-scoping -- Playwright serializes this helper with the page callback.
            const rectangle = (element: Element) => {
              const { bottom, height, left, right, top, width } = element.getBoundingClientRect();
              return { bottom, height, left, right, top, width };
            };
            const conversationRect = rectangle(section);
            const greetingRect = rectangle(greeting);
            const viewportRect = rectangle(viewport);
            const overflowY = {
              conversation: getComputedStyle(section).overflowY,
              viewport: getComputedStyle(viewport).overflowY,
            };
            const clippingValues = new Set(['auto', 'clip', 'hidden', 'scroll']);
            const viewportBottom = clippingValues.has(overflowY.viewport)
              ? viewportRect.bottom
              : Number.POSITIVE_INFINITY;
            const conversationBottom = clippingValues.has(overflowY.conversation)
              ? conversationRect.bottom
              : Number.POSITIVE_INFINITY;
            // Clip each boundary independently; raw greeting bounds can exceed the viewport.
            return {
              conversation: conversationRect,
              greeting: greetingRect,
              overflowY,
              paintedConversationBottom: Math.min(conversationRect.bottom, viewportBottom),
              paintedGreetingBottom: Math.min(
                greetingRect.bottom,
                conversationBottom,
                viewportBottom
              ),
              viewport: viewportRect,
              warning: rectangle(warning),
            };
          });
          const geometryPath = test.info().outputPath(`${name}-geometry.json`);
          await writeFile(geometryPath, JSON.stringify(geometry, null, 2), 'utf8');
          await test.info().attach(`${name}-geometry`, {
            contentType: 'application/json',
            path: geometryPath,
          });
          expect(
            Math.max(geometry.paintedConversationBottom, geometry.paintedGreetingBottom),
            'The conversation must not paint into the quarantine warning.'
          ).toBeLessThanOrEqual(geometry.warning.top);
        }
        const second = await openPanel();
        const reload = supervision(second).getByRole('button', { name: 'Reload panel' });
        await expect(supervision(second)).toContainText('Ownership not acquired');
        await expect(reload).toBeEnabled();
        await Promise.all([second.waitForEvent('load'), reload.click()]);
        await expect(supervision(second)).toContainText('Ownership not acquired');
        expect(await heldProviderLocks(second)).toEqual(ownerLocks);
        await expect(target.locator('#count')).toHaveText('0');
        expect(requests).toBe(0);
        await capture(second, `native-ownership-${profile}-live-owner-retry`);

        await panel.close();
        await expect.poll(() => heldProviderLocks(second)).toEqual([]);
        await expect(supervision(second)).toContainText('Ownership not acquired');
        await expect(reload).toBeEnabled();
        await expect(second.getByRole('button', { name: 'Refresh status' })).toHaveCount(0);
        await Promise.all([second.waitForEvent('load'), reload.click()]);
        await expect(supervision(second)).toContainText(`CLI tasks: ${phase}`);
        await expect
          .poll(() => heldProviderLocks(second))
          .toEqual([expect.objectContaining({ clientId: expect.any(String), mode: 'exclusive' })]);
        expect(await heldProviderLocks(second)).not.toEqual(ownerLocks);
        for (const { key, value } of saved) {
          expect(await readExtensionLocalStorage(second, key)).toEqual(value);
        }
        await expect(reload).toHaveCount(0);
        await expect(second.getByRole('button', { exact: true, name: 'Approve tab' })).toHaveCount(
          0
        );
        await expect(second.getByRole('button', { name: 'Stop CLI task' })).toHaveCount(0);
        await expect(target.locator('#count')).toHaveText('0');
        await expect(other.locator('#count')).toHaveText('0');
        expect(requests).toBe(0);
        await capture(second, `native-ownership-${profile}-explicit-acquisition`);

        if (quarantined) {
          await supervision(second)
            .getByRole('button', { name: 'Check recovery readiness' })
            .click();
          await expect(supervision(second)).toContainText('Close all target tabs before recovery.');
          await expect(second.getByRole('button', { name: 'Recover browser control' })).toHaveCount(
            0
          );
          const draft = 'Keep this draft while browser control is quarantined.';
          await second.getByLabel('Message agent').fill(draft);
          await second.getByLabel('Message agent').press('Enter');
          await expect(second.getByLabel('Message agent')).toHaveValue(draft);
          await expect(target.locator('#count')).toHaveText('0');
          expect(requests).toBe(0);
          await test.step('Scroll to the footer and activate Send without clearing quarantine', async () => {
            const send = second.getByRole('button', { name: 'Send message' });
            const before = await send.boundingBox();
            // Use native scrolling, then ordinary keyboard navigation and an unforced click.
            await send.scrollIntoViewIfNeeded();
            await keyboardReach(second, send);
            await expect(send).toBeFocused();
            await expect(send).toBeInViewport({ ratio: 1 });
            await expect(send).toBeEnabled();
            await test.info().attach('native-ownership-quarantined-footer-scroll', {
              body: JSON.stringify({ after: await send.boundingBox(), before }, null, 2),
              contentType: 'application/json',
            });
            await capture(second, 'native-ownership-quarantined-footer-reachable');
            await send.click();
            await expect(second.getByLabel('Message agent')).toHaveValue(draft);
            await expect(supervision(second)).toContainText('Recovery required');
            await expect(
              second.getByRole('button', { name: 'Recover browser control' })
            ).toHaveCount(0);
            await expect(target.locator('#count')).toHaveText('0');
            await expect(other.locator('#count')).toHaveText('0');
            expect(requests).toBe(0);
          });
        } else {
          await expect(supervision(second)).toContainText('Queue empty.');
          relay.submit('Run only after fresh tab consent in the new owning panel.');
          await expect(supervision(second)).toContainText('Tab approval required');
          await expect(supervision(second)).toContainText('Bound tab: Not approved');
          await expect(supervision(second).getByLabel('Tab to approve')).toHaveValue('');
          await expect(target.locator('#count')).toHaveText('0');
          expect(requests).toBe(0);
          await test.step('Reach and select the consent controls before approving the tab', async () => {
            const controls = supervision(second);
            const tab = controls.getByLabel('Tab to approve');
            const approveTab = controls.getByRole('button', { exact: true, name: 'Approve tab' });
            await expect(approveTab).toBeDisabled();
            await tab.scrollIntoViewIfNeeded();
            await expect(tab).toBeInViewport({ ratio: 1 });
            await expect(tab).toBeEnabled();
            await capture(second, 'native-ownership-enabled-tab-consent');
            await tab.selectOption({ label: 'Approved browser task tab' });
            await expect(
              controls.getByText('Tab: Approved browser task tab', { exact: true })
            ).toBeVisible();
            for (const control of [
              approveTab,
              controls.getByRole('button', { exact: true, name: 'Reject' }),
              controls.getByRole('button', { exact: true, name: 'Refresh tabs' }),
            ]) {
              await control.scrollIntoViewIfNeeded();
              await expect(control).toBeInViewport({ ratio: 1 });
              await expect(control).toBeEnabled();
            }
            await expect(target.locator('#count')).toHaveText('0');
            expect(requests).toBe(0);
            await capture(second, 'native-ownership-enabled-selected-tab-consent');
            await approveTab.click();
          });
          await expect(supervision(second)).toContainText('Last outcome: succeeded');
          await expect(target.locator('#count')).toHaveText('1');
          await expect(other.locator('#count')).toHaveText('0');
          expect(requests).toBe(2);
          await test.step('Reach the final controls and retrieve status without replaying work', async () => {
            const controls = supervision(second);
            const refresh = controls.getByRole('button', { name: 'Refresh status' });
            await refresh.scrollIntoViewIfNeeded();
            await expect(refresh).toBeInViewport({ ratio: 1 });
            await refresh.click();
            await expect(controls).toContainText(
              'Status retrieved. This does not approve execution or resubmit work.'
            );
            const composer = second.getByLabel('Message agent');
            await composer.scrollIntoViewIfNeeded();
            await expect(composer).toBeInViewport({ ratio: 1 });
            await expect(composer).toBeEditable();
            const outcome = controls.getByText(/Last outcome: succeeded/u);
            await outcome.scrollIntoViewIfNeeded();
            await expect(outcome).toBeInViewport({ ratio: 1 });
            await expect(
              controls.getByRole('button', { exact: true, name: 'Approve tab' })
            ).toHaveCount(0);
            await expect(controls.getByRole('button', { name: 'Stop CLI task' })).toHaveCount(0);
            await expect(target.locator('#count')).toHaveText('1');
            await expect(other.locator('#count')).toHaveText('0');
            expect(requests).toBe(2);
          });
        }
        await capture(second, `native-ownership-${profile}-consent-and-safety`);
      },
      {
        gateway: {
          firstCompletionEvents: toolCall('eval', {
            code: 'document.querySelector("#effect").click(); return document.querySelector("#count").textContent;',
          }),
          secondCompletionEvents: content(resultText),
          toolNames: dangerousToolNames,
        },
      }
    );
  });
}

for (const loss of ['close', 'reload'] as const) {
  test(`native local owner ${loss} blocks local and delegated work until explicit recovery`, async () => {
    const issueAction = Promise.withResolvers<void>();
    const recoveredText = 'Explicitly submitted browser work completed.';
    await withHarness(
      async ({ panel, openPanel, context, relay, target, other }) => {
        let requests = 0;
        context.on('request', request => {
          if (request.url().endsWith('/api/gateway/v1/chat/completions')) {
            requests += 1;
          }
        });
        await enable(panel, true);
        const localOwner = await openPanel();
        await selectModelById(localOwner, model);
        await localOwner
          .getByLabel('Target tab')
          .selectOption({ label: 'Approved browser task tab' });
        await localOwner.getByRole('button', { name: /(?:Safe|Dangerous) mode/u }).click();
        await localOwner
          .getByRole('button', { exact: true, name: 'Dangerous Arbitrary webpage control' })
          .click();
        await localOwner.getByLabel('Message agent').fill('Issue the local page action and wait.');
        await localOwner.getByLabel('Message agent').press('Enter');
        await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
        const delivery = relay.submit('Do not run until local work safely drains.');
        await approve(panel);
        await expect(supervision(panel)).toContainText('Waiting for browser control');
        await expect.poll(() => requests).toBe(1);

        // Queue delegation first, so owner destruction follows the issued action before its eval timeout.
        issueAction.resolve();
        await expect(target.locator('#count')).toHaveText('1');
        await (loss === 'close' ? localOwner.close() : localOwner.reload());
        await target.evaluate(() => {
          document.dispatchEvent(new Event('finish-local-action'));
        });
        await expect(target.locator('html')).toHaveAttribute('data-local-action', 'finished');
        await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
        await expect(supervision(panel)).toContainText('Recovery required');
        // An orphaned local record, not a prior timeout quarantine, must retain exclusion.
        expect(await readExtensionLocalStorage(panel, 'kiloBrowserExecutionSafety')).toEqual(
          expect.objectContaining({
            localRuns: [expect.objectContaining({ tabId: expect.any(Number) })],
            tabIds: [],
          })
        );
        const draft = 'Keep this draft until explicit recovery.';
        await panel.getByLabel('Message agent').fill(draft);
        await panel.getByLabel('Message agent').press('Enter');
        await expect(panel.getByLabel('Message agent')).toHaveValue(draft);
        await expect(supervision(panel)).toContainText('an action may still be running');
        await expect(supervision(panel).getByRole('list', { name: 'Affected tabs' })).toContainText(
          'Approved browser task tab'
        );
        await supervision(panel).getByRole('button', { name: 'Check recovery readiness' }).click();
        await expect(supervision(panel)).toContainText('Close all affected tabs before recovery.');
        await expect(panel.getByRole('button', { name: 'Recover browser control' })).toHaveCount(0);
        relay.send(delivery);
        await expect(panel.getByRole('button', { exact: true, name: 'Approve tab' })).toHaveCount(
          0
        );
        await expect(target.locator('#count')).toHaveText('1');
        await expect(other.locator('#count')).toHaveText('0');
        expect(requests).toBe(1);
        await capture(panel, `native-local-owner-${loss}-blocked`);

        await target.close();
        await supervision(panel).getByRole('button', { name: 'Check recovery readiness' }).click();
        const recover = panel.getByRole('button', { name: 'Recover browser control' });
        await expect(recover).toBeVisible();
        await panel.getByLabel('Message agent').press('Enter');
        await expect(panel.getByLabel('Message agent')).toHaveValue(draft);
        expect(requests).toBe(1);
        await recover.click();
        await expect(supervision(panel)).toContainText('Enabled — idle');
        await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
        expect(requests).toBe(1);
        await expect(panel.getByLabel('Message agent')).toHaveValue(draft);
        await panel.getByLabel('Target tab').selectOption({ label: 'Unapproved tab' });
        await panel.getByRole('button', { name: /(?:Safe|Dangerous) mode/u }).click();
        await panel
          .getByRole('button', { exact: true, name: 'Dangerous Arbitrary webpage control' })
          .click();
        await panel.getByLabel('Message agent').press('Enter');
        await expect(panel.getByText(recoveredText, { exact: true })).toBeVisible();
        await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
        expect(requests).toBe(2);
        relay.submit('Run only this new explicitly approved invocation.');
        await expect(supervision(panel)).toContainText('Tab approval required');
        expect(requests).toBe(2);
        await supervision(panel)
          .getByLabel('Tab to approve')
          .selectOption({ label: 'Unapproved tab' });
        await supervision(panel).getByRole('button', { exact: true, name: 'Approve tab' }).click();
        await expect(supervision(panel)).toContainText('Last outcome: succeeded');
        expect(requests).toBe(3);
        await expect(other.locator('#count')).toHaveText('0');
        await capture(panel, `native-local-owner-${loss}-explicit-recovery`);
      },
      {
        gateway: {
          beforeFirstCompletion: () => issueAction.promise,
          firstCompletionEvents: toolCall('eval', {
            code: 'document.querySelector("#effect").click(); await new Promise(resolve => document.addEventListener("finish-local-action", resolve, { once: true })); document.documentElement.setAttribute("data-local-action", "finished"); return "finished";',
          }),
          secondCompletionEvents: content(recoveredText),
          thirdCompletionEvents: content(recoveredText),
          toolNames: dangerousToolNames,
        },
      }
    );
  });
}

for (const mode of ['Browser', 'Agents'] as const) {
  test(`${mode}: memory saving, retry, and confirmation retain keyboard-accessible supervision`, async () => {
    const finish = Promise.withResolvers<void>();
    await withHarness(
      async ({ panel, context, relay }) => {
        await enable(panel);
        await panel.getByRole('tab', { exact: true, name: mode }).click();
        let requests = 0;
        await context.route('**/api/gateway/v1/chat/completions', async route => {
          requests += 1;
          if (requests > 1) {
            await finish.promise;
          }
          await route.fallback();
        });
        await panel.evaluate(() => {
          const scope = globalThis as typeof globalThis & {
            chrome: {
              storage: { local: { set: (items: Record<string, unknown>) => Promise<void> } };
            };
            releaseMemoryWrite?: () => void;
          };
          const storage = scope.chrome.storage.local;
          const original = storage.set.bind(storage);
          const gate = Promise.withResolvers<void>();
          let failOnce = true;
          scope.releaseMemoryWrite = () => {
            gate.resolve();
          };
          storage.set = async items => {
            if (Object.hasOwn(items, 'kiloAgentMemories')) {
              await gate.promise;
              if (failOnce) {
                failOnce = false;
                throw new Error('The test storage rejects the first memory write.');
              }
            }
            await original(items);
          };
        });
        relay.submit('Save the proposed observation only after consent.');
        await approve(panel);
        const dialog = panel.getByRole('dialog', { name: 'Add to memory' });
        await expect(dialog).toBeVisible();
        await assertSupervision(dialog);
        await keyboardReach(panel, dialog.getByRole('button', { name: 'Save memory' }), dialog);
        await panel.keyboard.press('Enter');
        await expect(dialog.getByRole('button', { name: 'Save memory' })).toBeDisabled();
        await assertSupervision(dialog);
        await keyboardReach(panel, dialog.getByRole('button', { name: 'Stop CLI task' }), dialog);
        await capture(panel, `${mode}-memory-saving`);
        await panel.evaluate(() => {
          const scope = globalThis as typeof globalThis & { releaseMemoryWrite: () => void };
          scope.releaseMemoryWrite();
        });
        await expect(dialog).toContainText("Couldn't save memory. Try again.");
        await assertSupervision(dialog);
        await capture(panel, `${mode}-memory-retryable-error`);
        await dialog.getByRole('button', { exact: true, name: 'Retry' }).click();
        await expect(dialog).toContainText('Saved to memory');
        expect(await readExtensionLocalStorage(panel, 'kiloAgentMemories')).toEqual(
          expect.arrayContaining([expect.objectContaining({ text: 'Delegated observation A1.' })])
        );
        await assertSupervision(dialog);
        await keyboardReach(panel, dialog.getByRole('button', { name: 'Stop CLI task' }), dialog);
        await capture(panel, `${mode}-memory-confirmation`);
        await panel.keyboard.press('Enter');
        await expect(supervision(dialog)).toContainText('cancelled');
        finish.resolve();
        await dialog.getByRole('button', { exact: true, name: 'Done' }).click();
        await panel.reload();
        await expect(dialog).toHaveCount(0);
        expect(await readExtensionLocalStorage(panel, 'kiloAgentMemories')).toEqual(
          expect.arrayContaining([expect.objectContaining({ text: 'Delegated observation A1.' })])
        );
      },
      {
        gateway: {
          firstCompletionEvents: toolCall('save_memory', { text: 'Delegated observation A1.' }),
          secondCompletionEvents: content('The memory was saved.'),
          toolNames: safeToolNames,
        },
      }
    );
  });

  test(`${mode}: an expired result fence still requires tab closure and drained native locks`, async () => {
    const completion = Promise.withResolvers<void>();
    let clockOffset = 0;
    await withHarness(
      async ({ panel, target, openPanel, relay }) => {
        await enable(panel);
        await panel.getByRole('tab', { exact: true, name: mode }).click();
        const delivery = relay.submit();
        await approve(panel);
        await expect(supervision(panel)).toContainText('CLI tasks: Running');
        relay.interrupt(delivery.job, 'provider_lost');
        await expect(supervision(panel)).toContainText('Recovery required');
        await capture(panel, `${mode}-interrupted`);
        await expect
          .poll(() => readExtensionLocalStorage(panel, 'kiloBrowserExecutionSafety'))
          .toEqual(
            expect.objectContaining({ tabIds: expect.arrayContaining([expect.any(Number)]) })
          );
        // Only this deterministic browser case advances time. The peer supplies post-expiry history;
        // Reloading also expires the real extension's persisted results, not its safety record.
        clockOffset = 7 * 86_400_000 + 1000;
        relay.expireResults();
        completion.resolve();
        await panel.clock.install({ time: new Date(Date.now() + clockOffset) });
        await panel.reload();
        await supervision(panel).getByRole('button', { name: 'Refresh status' }).click();
        await supervision(panel).getByRole('button', { name: 'Check recovery readiness' }).click();
        await expect(panel.getByRole('button', { name: 'Recover browser control' })).toHaveCount(0);
        await expect(supervision(panel)).toContainText('Close');
        await target.close();
        const second = await openPanel();
        await second.evaluate(() => {
          const gate = Promise.withResolvers<void>();
          Object.assign(globalThis, {
            releaseRecoveryLock: () => {
              gate.resolve();
            },
          });
          void navigator.locks.request(
            'kilo:browser-execution',
            { mode: 'shared' },
            () => gate.promise
          );
        });
        await expect.poll(() => heldExecutionModes(panel)).toContain('shared');
        await supervision(panel).getByRole('button', { name: 'Check recovery readiness' }).click();
        await expect(panel.getByRole('button', { name: 'Recover browser control' })).toHaveCount(0);
        await capture(panel, `${mode}-recovery-blocked`);
        await second.evaluate(() => {
          const scope = globalThis as typeof globalThis & { releaseRecoveryLock: () => void };
          scope.releaseRecoveryLock();
        });
        await second.close();
        await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
        await supervision(panel).getByRole('button', { name: 'Check recovery readiness' }).click();
        await panel.getByRole('button', { name: 'Recover browser control' }).click();
        await expect(supervision(panel)).toContainText('Enabled — idle');
        await expect(panel.getByRole('button', { exact: true, name: 'Approve tab' })).toHaveCount(
          0
        );
        await expect(panel.getByRole('button', { name: 'Stop CLI task' })).toHaveCount(0);
        await capture(panel, `${mode}-recovered-without-replay`);
      },
      {
        gateway: { beforeFirstCompletion: () => completion.promise },
        relay: { now: () => Date.now() + clockOffset },
      }
    );
  });
}

for (const reason of ['approval_timeout', 'execution_timeout', 'permission_denied'] as const) {
  test(`${reason} has a finite non-success outcome and no execution after late dispatch`, async () => {
    const completion = Promise.withResolvers<void>();
    await withHarness(
      async ({ panel, target, relay }) => {
        await enable(panel);
        const delivery = relay.submit();
        await expect(supervision(panel)).toContainText('Tab approval required');
        if (reason === 'execution_timeout') {
          await approve(panel);
          await expect(supervision(panel)).toContainText('CLI tasks: Running');
        }
        relay.interrupt(delivery.job, reason);
        await expect(supervision(panel)).toContainText(reason);
        relay.send(delivery);
        await panel.reload();
        completion.resolve();
        await expect(supervision(panel)).toContainText(reason);
        await expect(panel.getByRole('button', { exact: true, name: 'Approve tab' })).toHaveCount(
          0
        );
        await expect(target.locator('#count')).toHaveText('0');
      },
      { gateway: { beforeFirstCompletion: () => completion.promise } }
    );
  });
}

test('provider cancellation wins over a delayed queued dispatch without replacing the active owner', async () => {
  await withHarness(async ({ panel, relay, target }) => {
    await enable(panel);
    relay.submit('Retain the active A1 consent.');
    await expect(supervision(panel)).toContainText('Retain the active A1 consent.');
    const queued = relay.submit('Never execute the cancelled B1 goal.', 'ses_parent_B1', true);
    await panel
      .getByRole('button', { name: `Cancel queued task ${queued.job.jobId.slice(-8)}` })
      .click();
    await expect(panel.getByRole('list', { name: 'Queued CLI tasks' })).toHaveCount(0);
    relay.send({
      ...queued,
      job: { ...queued.job, queuePosition: undefined, status: 'awaiting_approval' },
    });
    await expect(supervision(panel)).toContainText('Retain the active A1 consent.');
    await expect(supervision(panel)).not.toContainText('Never execute the cancelled B1 goal.');
    await expect(supervision(panel)).toContainText('Tab approval required');
    await expect(target.locator('#count')).toHaveText('0');
    await supervision(panel).getByRole('button', { exact: true, name: 'Reject' }).click();
  });
});

test('a vanished consent candidate retains the goal and never selects another tab', async () => {
  await withHarness(async ({ panel, relay, target, other }) => {
    await enable(panel);
    relay.submit('Keep this goal when its candidate closes.');
    await supervision(panel)
      .getByLabel('Tab to approve')
      .selectOption({ label: 'Approved browser task tab' });
    await target.close();
    await expect(supervision(panel)).toContainText('The goal is retained.');
    await expect(supervision(panel)).toContainText('Keep this goal when its candidate closes.');
    await expect(
      supervision(panel).getByRole('button', { exact: true, name: 'Approve tab' })
    ).toBeDisabled();
    await expect(other.locator('#count')).toHaveText('0');
  });
});

test('sign-out during quarantine preserves safety and provider identity after account history disappears', async () => {
  const completion = Promise.withResolvers<void>();
  await withHarness(
    async ({ panel, relay, target }) => {
      await enable(panel);
      const profile = await supervision(panel)
        .getByText(/^Profile:/u)
        .textContent();
      const delivery = relay.submit();
      await approve(panel);
      await expect(supervision(panel)).toContainText('CLI tasks: Running');
      relay.interrupt(delivery.job, 'provider_lost');
      await expect(supervision(panel)).toContainText('Recovery required');
      await expect
        .poll(() => readExtensionLocalStorage(panel, 'kiloBrowserExecutionSafety'))
        .toEqual(expect.objectContaining({ tabIds: expect.arrayContaining([expect.any(Number)]) }));
      const safety = await readExtensionLocalStorage(panel, 'kiloBrowserExecutionSafety');
      await panel.getByLabel('Settings', { exact: true }).click();
      await panel.getByRole('button', { name: 'Sign out' }).click();
      await expect(panel.getByRole('button', { exact: true, name: 'Sign in' })).toBeVisible();
      expect(await readExtensionLocalStorage(panel, 'kiloBrowserExecutionSafety')).toEqual(safety);
      relay.expireResults();
      await seedExtensionAuth(panel);
      await panel.reload();
      await expect(supervision(panel)).toContainText('CLI tasks: Disabled');
      await expect(supervision(panel).getByText(/^Profile:/u)).toHaveText(profile ?? '');
      await enable(panel, false, 'Recovery required');
      await supervision(panel).getByRole('button', { name: 'Refresh status' }).click();
      await supervision(panel).getByRole('button', { name: 'Check recovery readiness' }).click();
      await expect(panel.getByRole('button', { name: 'Recover browser control' })).toHaveCount(0);
      await expect(target.locator('#count')).toHaveText('0');
      await capture(panel, 'signed-in-quarantine-with-expired-results');
      completion.resolve();
    },
    { gateway: { beforeFirstCompletion: () => completion.promise } }
  );
});

test('Safe delegation rejects an unsafe model tool without a browser side effect', async () => {
  await withHarness(
    async ({ panel, relay, target }) => {
      await enable(panel);
      relay.submit('Do not execute an unsafe model tool.');
      await approve(panel);
      await expect(supervision(panel)).toContainText('permission_denied');
      await expect(supervision(panel)).not.toContainText('Last outcome: succeeded');
      await expect(target.locator('#count')).toHaveText('0');
    },
    {
      gateway: {
        firstCompletionEvents: toolCall('eval', {
          code: 'document.querySelector("#effect").click(); return 1;',
        }),
        toolNames: safeToolNames,
      },
    }
  );
});

for (const scenario of [
  { expected: 'Unsupported', options: { supported: false } },
  { expected: 'Unavailable', options: { registrationError: true } },
  { expected: 'Connecting', options: { silent: true } },
]) {
  test(`provider ${scenario.expected.toLowerCase()} explains the failure without dispatch`, async () => {
    await withHarness(
      async ({ panel, relay, target }) => {
        await enable(panel, false, scenario.expected);
        for (const mode of ['Browser', 'Agents']) {
          await panel.getByRole('tab', { exact: true, name: mode }).click();
          await expect(supervision(panel)).toContainText(`CLI tasks: ${scenario.expected}`);
          await expect(panel.getByRole('button', { exact: true, name: 'Approve tab' })).toHaveCount(
            0
          );
          await expect(target.locator('#count')).toHaveText('0');
          await capture(panel, `${mode}-${scenario.expected.toLowerCase()}`);
        }
        expect(relay.results).toHaveLength(0);
      },
      { relay: scenario.options }
    );
  });
}

test('missing native Web Locks disables delegation without disabling ordinary local work', async () => {
  await withHarness(
    async ({ panel, target }) => {
      await expect(supervision(panel)).toContainText('does not support Web Locks');
      await expect(panel.getByRole('button', { exact: true, name: 'Approve tab' })).toHaveCount(0);
      await panel.getByLabel('Message agent').fill('Read this page locally.');
      await panel.getByLabel('Message agent').press('Enter');
      await expect(panel.getByText('Observed the requested page.', { exact: true })).toBeVisible();
      await expect(target.locator('#count')).toHaveText('0');
    },
    {
      init: context =>
        context.addInitScript(() => {
          Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
        }),
    }
  );
});

for (const modal of [
  'Settings panel',
  'Select model',
  'Conversation history',
  'Run workflow',
] as const) {
  test(`${modal} keeps bound-tab supervision and keyboard Stop inside its focus boundary`, async () => {
    const completion = Promise.withResolvers<void>();
    await withHarness(
      async ({ panel, relay, target }) => {
        await enable(panel);
        if (modal === 'Run workflow') {
          const script = 'return { done: true, result: input.name };';
          await setExtensionStorage(panel, {
            kiloAgentWorkflows: [
              {
                approvedScriptHash: createHash('sha256').update(script).digest('hex'),
                createdAt: Date.now(),
                description: 'Prompt fixture',
                id: randomUUID(),
                name: 'Prompt fixture',
                params: [{ description: 'A name', name: 'name', required: true }],
                scopeOrigin: new URL(target.url()).origin,
                script,
                updatedAt: Date.now(),
              },
            ],
            kiloWorkflowSettings: {
              allowWorkflowsInSafeMode: true,
              autoApproveWorkflowChanges: false,
              autoApproveWorkflowRuns: false,
            },
          });
        }
        relay.submit();
        await approve(panel);
        await expect(supervision(panel)).toContainText('CLI tasks: Running');
        if (modal === 'Settings panel' || modal === 'Run workflow') {
          await panel.getByLabel('Settings', { exact: true }).click();
          if (modal === 'Run workflow') {
            await panel.getByLabel('Run workflow "Prompt fixture"').click();
          }
        } else if (modal === 'Select model') {
          await panel.getByLabel('Model', { exact: true }).click();
        } else {
          await panel.getByLabel('History', { exact: true }).click();
        }
        const dialog = panel.getByRole('dialog', {
          exact: modal !== 'Run workflow',
          name: modal === 'Run workflow' ? /Run workflow/u : modal,
        });
        await expect(dialog).toBeVisible();
        await assertSupervision(dialog);
        await keyboardReach(panel, dialog.getByRole('button', { name: 'Stop CLI task' }), dialog);
        await capture(panel, `modal-${modal.replaceAll(' ', '-')}`);
        await panel.keyboard.press('Enter');
        await expect(supervision(dialog)).toContainText('cancelled');
        completion.resolve();
        const closeNames = {
          'Conversation history': 'Close history',
          'Run workflow': 'Cancel',
          'Select model': 'Close model picker',
          'Settings panel': 'Close settings',
        };
        const openerNames = {
          'Conversation history': 'History',
          'Run workflow': 'Run workflow "Prompt fixture"',
          'Select model': 'Model',
          'Settings panel': 'Settings',
        };
        await keyboardReach(
          panel,
          dialog.getByRole('button', { exact: true, name: closeNames[modal] }),
          dialog
        );
        await panel.keyboard.press('Enter');
        await expect(dialog).toBeHidden();
        await expect(panel.getByLabel(openerNames[modal], { exact: true })).toBeFocused();
        await expect(target.locator('#count')).toHaveText('0');
      },
      { gateway: { beforeFirstCompletion: () => completion.promise } }
    );
  });
}

const nativeSendPending = (panel: Page) =>
  panel.getByRole('status').filter({
    hasText: 'Checking browser control… Your input is retained.',
  });
const nativeSendRequestSchema = z.object({
  messages: z.array(z.object({ content: z.unknown(), role: z.string() })),
});
const nativeSendUserTexts = (body: unknown): string[] =>
  nativeSendRequestSchema
    .parse(body)
    .messages.filter(message => message.role === 'user')
    .map(message =>
      z
        .string()
        .parse(message.content)
        .replace(/\n\n<system_environment>[\s\S]*$/u, '')
    );
const nativeSendGateway = (seenChatBodies: unknown[]) => ({
  firstCompletionEvents: toolCall('eval', {
    code: 'document.querySelector("#effect").click(); return document.querySelector("#count").textContent;',
  }),
  secondCompletionEvents: content(resultText),
  seenChatBodies,
  toolNames: dangerousToolNames,
});
const prepareNativeSend = async (panel: Page, titles: string[] = []): Promise<void> => {
  await selectModelById(panel, model);
  await panel.getByLabel('Target tab').selectOption({ label: 'Approved browser task tab' });
  await panel.getByRole('button', { name: /(?:Safe|Dangerous) mode/u }).click();
  await panel
    .getByRole('button', { exact: true, name: 'Dangerous Arbitrary webpage control' })
    .click();
  if (titles.length > 0) {
    const selectedTabId = Number(await panel.getByLabel('Target tab').inputValue());
    await setExtensionStorage(panel, {
      kiloAgentConversations: {
        activeConversationId: 'native-send-0',
        conversations: titles.map((title, index) => ({
          events: [{ id: `prior-${index}`, role: 'user', text: `Prior ${title}`, type: 'message' }],
          id: `native-send-${index}`,
          mode: 'dangerous',
          model,
          selectedTabId,
          title,
          updatedAt: new Date().toISOString(),
        })),
        openConversationIds: titles.map((_title, index) => `native-send-${index}`),
      },
    });
    await panel.reload();
  }
  await expect(panel.getByLabel('Message agent')).toHaveValue('');
  await expect(panel.getByRole('button', { exact: true, name: 'Send message' })).toBeDisabled();
};
const expectNativeSendPending = async (panel: Page, draft: string): Promise<void> => {
  await expect(nativeSendPending(panel)).toHaveCount(1);
  await expect(nativeSendPending(panel)).toBeVisible();
  await expect(nativeSendPending(panel)).toHaveText(
    'Checking browser control… Your input is retained.'
  );
  await expect(panel.getByLabel('Message agent')).toHaveValue(draft);
  await expect(panel.getByRole('button', { exact: true, name: 'Send message' })).toBeDisabled();
};

const nativeWorkflowName = 'Admission fixture';
// Each installation belongs to one action. Restore simultaneous gates in reverse order.
const holdNativeSendBoundary = async (
  panel: Page,
  boundary: 'safety' | 'locked-safety' | 'tab',
  action: 'send' | 'resume' | 'workflow-row' | 'workflow-form' = 'send'
) => {
  const options = {
    activation: action,
    kind: boundary,
    lockName: executionLock,
    workflowLabel: `Run workflow "${nativeWorkflowName}"`,
  };
  const handle = await panel.evaluateHandle(({ kind, activation, lockName, workflowLabel }) => {
    const scope = globalThis as typeof globalThis & {
      chrome: typeof browser;
    };
    const storage = scope.chrome.storage.local;
    const { tabs } = scope.chrome;
    // eslint-disable-next-line typescript/unbound-method -- Restore the original API; apply below preserves its receiver.
    const originalStorageGet = storage.get;
    const originalTabGet = tabs.get;
    const { locks } = navigator;
    // eslint-disable-next-line typescript/unbound-method -- Restore the native method; apply below preserves its receiver.
    const originalLockRequest = locks.request;
    const gate = Promise.withResolvers<void>();
    let nativeCallbackEntered = false;
    let rejectRead = false;
    let restored = false;
    const state = {
      activated: false,
      entered: false,
      failed: false,
      reject: () => {
        rejectRead = true;
        gate.resolve();
      },
      release: () => {
        gate.resolve();
      },
      restore: () => {
        if (restored) {
          return;
        }
        restored = true;
        gate.resolve();
        document.removeEventListener('keydown', arm, true);
        document.removeEventListener('click', arm, true);
        if (kind === 'locked-safety') {
          locks.request = originalLockRequest;
        }
        if (kind === 'safety' || kind === 'locked-safety') {
          storage.get = originalStorageGet;
        } else {
          tabs.get = originalTabGet;
        }
      },
      settled: false,
      submittedTabId: undefined as number | undefined,
    };
    const arm = (event: Event): void => {
      const input = document.querySelector('#agent-message');
      const workflow = activation === 'workflow-row' || activation === 'workflow-form';
      if (!workflow && !(input instanceof HTMLTextAreaElement)) {
        return;
      }
      let control: Element | null | undefined;
      if (activation === 'workflow-row') {
        control = [...document.querySelectorAll('button')].find(
          button => button.getAttribute('aria-label') === workflowLabel
        );
      } else if (activation === 'workflow-form') {
        const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
          element => element.getAttribute('aria-label') === workflowLabel
        );
        control = [...(dialog?.querySelectorAll('button') ?? [])].find(
          button => button.textContent?.trim() === 'Run'
        );
      } else if (activation === 'resume') {
        control = [...document.querySelectorAll('button')].find(
          button => button.textContent?.trim() === 'Resume queued message'
        );
      } else if (input instanceof HTMLTextAreaElement) {
        control = input.form?.querySelector('button[type="submit"]');
      }
      const workflowField =
        activation === 'workflow-form' &&
        event.target instanceof HTMLInputElement &&
        event.target.closest('[role="dialog"]')?.getAttribute('aria-label') === workflowLabel;
      const enter =
        event instanceof KeyboardEvent &&
        event.key === 'Enter' &&
        !event.shiftKey &&
        (event.target === (activation === 'send' ? input : control) || workflowField);
      const click =
        event.type === 'click' &&
        event.target instanceof Node &&
        control?.contains(event.target) === true;
      if (!enter && !click) {
        return;
      }
      if (!workflow) {
        const target = document.querySelector('[aria-label="Target tab"]');
        if (!(target instanceof HTMLSelectElement)) {
          throw new Error('Send must have a target selector.');
        }
        state.submittedTabId = Number(target.value);
      }
      state.activated = true;
      document.removeEventListener('keydown', arm, true);
      document.removeEventListener('click', arm, true);
    };
    const readAfterRelease = async <Value>(read: () => Value): Promise<Awaited<Value>> => {
      state.entered = true;
      try {
        await gate.promise;
        if (rejectRead) {
          throw new Error('The native Send test rejects the safety read.');
        }
        return await read();
      } catch (error) {
        state.failed = true;
        throw error;
      } finally {
        state.settled = true;
      }
    };
    if (kind === 'locked-safety') {
      locks.request = ((...args: unknown[]) => {
        const [name, requestOptions, callback] = args;
        if (
          state.activated &&
          name === lockName &&
          requestOptions !== null &&
          typeof requestOptions === 'object' &&
          'mode' in requestOptions &&
          requestOptions.mode === 'shared' &&
          typeof callback === 'function'
        ) {
          // Observe entry only. The native manager still grants and releases the unchanged lock.
          const entered: LockGrantedCallback<unknown> = lock => {
            if (lock !== null) {
              nativeCallbackEntered = true;
            }
            // eslint-disable-next-line promise/prefer-await-to-callbacks -- Preserve the native callback's exact result and scheduling.
            return (callback as LockGrantedCallback<unknown>)(lock);
          };
          args[2] = entered;
        }
        return (originalLockRequest as (...nativeArgs: unknown[]) => unknown).apply(locks, args);
      }) as typeof originalLockRequest;
    }
    if (kind === 'safety' || kind === 'locked-safety') {
      storage.get = ((...args: unknown[]) => {
        const [keys, callback] = args;
        // Forward every native overload unchanged, including callback-only callers.
        const read = () =>
          (originalStorageGet as (...nativeArgs: unknown[]) => unknown).apply(storage, args);
        const includesSafety =
          keys === 'kiloBrowserExecutionSafety' ||
          (Array.isArray(keys) && keys.includes('kiloBrowserExecutionSafety')) ||
          (keys !== null &&
            typeof keys === 'object' &&
            Object.hasOwn(keys, 'kiloBrowserExecutionSafety'));
        // Preserve callback callers. The runtime safety read uses the Promise overload.
        if (!state.activated || !includesSafety || callback !== undefined) {
          return read();
        }
        // A pre-callback background read must pass even if the lock becomes held before it resolves.
        if (kind === 'locked-safety' && !nativeCallbackEntered) {
          return read();
        }
        // A background refresh can share this read; only the UI status proves pending Send.
        return readAfterRelease(read);
      }) as typeof originalStorageGet;
    } else {
      tabs.get = ((...args: unknown[]) => {
        const [tabId, callback] = args;
        const read = () =>
          (originalTabGet as (...nativeArgs: unknown[]) => unknown).apply(tabs, args);
        if (
          !state.activated ||
          state.entered ||
          tabId !== state.submittedTabId ||
          callback !== undefined
        ) {
          return read();
        }
        return readAfterRelease(read);
      }) as typeof originalTabGet;
    }
    document.addEventListener('keydown', arm, true);
    document.addEventListener('click', arm, true);
    return state;
  }, options);
  return {
    activated: () => handle.evaluate(state => state.activated),
    dispose: async () => {
      try {
        await handle.evaluate(state => {
          state.restore();
        });
      } finally {
        await handle.dispose();
      }
    },
    outcome: () => handle.evaluate(state => ({ failed: state.failed, settled: state.settled })),
    reject: () =>
      handle.evaluate(state => {
        state.reject();
      }),
    release: () =>
      handle.evaluate(state => {
        state.release();
      }),
    restore: () =>
      handle.evaluate(state => {
        state.restore();
      }),
    wait: async () => {
      await expect.poll(() => handle.evaluate(state => state.entered)).toBe(true);
    },
  };
};

for (const activation of ['Enter', 'Send'] as const) {
  test(`native gap A1: ${activation} retains focus and submits captured text once`, async () => {
    const seenChatBodies: unknown[] = [];
    await withHarness(
      async ({ panel, target, other }) => {
        await prepareNativeSend(panel);
        const input = panel.getByLabel('Message agent');
        const send = panel.getByRole('button', { exact: true, name: 'Send message' });
        const conversation = panel.getByRole('region', { name: 'Agent conversation' });
        const submitted = `Apply the ${activation} action once.`;
        const draft = `  ${submitted}  `;
        const newerDraft = 'Keep this newer unsent text.';
        const gate = await holdNativeSendBoundary(panel, 'safety');
        try {
          await input.fill(draft);
          if (activation === 'Enter') {
            await input.press('Enter');
            await expect(input).toBeFocused();
          } else {
            await send.click();
            await expect(send).toBeFocused();
          }
          await expectNativeSendPending(panel, draft);
          await gate.wait();
          await expect.poll(() => heldExecutionModes(panel)).toEqual([]);

          // Retry the focused control without forcing a click on a disabled button.
          await panel.keyboard.press('Enter');
          await expect(activation === 'Enter' ? input : send).toBeFocused();
          await expectNativeSendPending(panel, draft);
          await expect(conversation.getByText(submitted, { exact: true })).toHaveCount(0);
          await expect(target.locator('#count')).toHaveText('0');
          await expect(other.locator('#count')).toHaveText('0');
          expect(seenChatBodies).toHaveLength(0);
          if (activation === 'Send') {
            await input.fill(newerDraft);
            await expectNativeSendPending(panel, newerDraft);
          }

          await gate.release();
          await expect(nativeSendPending(panel)).toHaveCount(0);
          await expect(conversation.getByText(resultText, { exact: true })).toBeVisible();
          await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
          await expect(conversation.getByText(submitted, { exact: true })).toHaveCount(1);
          await expect(target.locator('#count')).toHaveText('1');
          await expect(other.locator('#count')).toHaveText('0');
          await expect(input).toHaveValue(activation === 'Send' ? newerDraft : '');
          expect(seenChatBodies.map(body => nativeSendUserTexts(body))).toEqual([
            [submitted],
            [submitted],
          ]);
        } finally {
          await gate.dispose();
        }
      },
      { gateway: nativeSendGateway(seenChatBodies) }
    );
  });
}

test('native gap A1: native contention rejects Send until an explicit retry', async () => {
  const seenChatBodies: unknown[] = [];
  await withHarness(
    async ({ panel, openPanel, target, other }) => {
      await prepareNativeSend(panel);
      const second = await openPanel();
      const input = panel.getByLabel('Message agent');
      const draft = 'Keep the draft while another native owner holds control.';
      const gate = await holdNativeSendBoundary(panel, 'safety');
      try {
        await input.fill(draft);
        await input.press('Enter');
        await expectNativeSendPending(panel, draft);
        await gate.wait();
        const contender = await second.evaluateHandle(name => {
          const hold = Promise.withResolvers<void>();
          const released = navigator.locks.request(name, { mode: 'exclusive' }, () => hold.promise);
          return {
            release: async () => {
              hold.resolve();
              await released;
            },
          };
        }, executionLock);
        try {
          await expect.poll(() => heldExecutionModes(panel)).toEqual(['exclusive']);
          await expectNativeSendPending(panel, draft);
          await gate.release();
          await expect(nativeSendPending(panel)).toHaveCount(0);
          await expect(
            panel.getByRole('status').filter({ hasText: 'owns browser control' }).first()
          ).toBeVisible();
          await expect(input).toHaveValue(draft);
          await expect(panel.getByRole('region', { name: 'Agent conversation' })).not.toContainText(
            draft
          );
          await expect(target.locator('#count')).toHaveText('0');
          await expect(other.locator('#count')).toHaveText('0');
          expect(seenChatBodies).toHaveLength(0);

          await contender.evaluate(held => held.release());
          await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
          await expect(
            panel.getByRole('status').filter({
              hasText:
                'Your message is retained. Submit it again when browser control is available.',
            })
          ).toBeVisible();
          await expect(nativeSendPending(panel)).toHaveCount(0);
          await expect(input).toHaveValue(draft);
          await expect(target.locator('#count')).toHaveText('0');
          await expect(other.locator('#count')).toHaveText('0');
          expect(seenChatBodies).toHaveLength(0);

          await panel.getByRole('button', { exact: true, name: 'Send message' }).click();
          await expect(panel.getByText(resultText, { exact: true })).toBeVisible();
          await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
          await expect(nativeSendPending(panel)).toHaveCount(0);
          await expect(input).toHaveValue('');
          await expect(target.locator('#count')).toHaveText('1');
          await expect(other.locator('#count')).toHaveText('0');
          expect(seenChatBodies.map(body => nativeSendUserTexts(body))).toEqual([[draft], [draft]]);
        } finally {
          try {
            await contender.evaluate(held => held.release());
          } finally {
            await contender.dispose();
          }
        }
      } finally {
        await gate.dispose();
      }
    },
    { gateway: nativeSendGateway(seenChatBodies) }
  );
});

test('native gap A1: storage failure retains Send until explicit recovery and retry', async () => {
  const seenChatBodies: unknown[] = [];
  await withHarness(
    async ({ panel, target, other }) => {
      await enable(panel);
      await prepareNativeSend(panel);
      const input = panel.getByLabel('Message agent');
      const draft = 'Keep this draft through the safety storage failure.';
      const gate = await holdNativeSendBoundary(panel, 'safety');
      try {
        await input.fill(draft);
        await input.press('Enter');
        await expectNativeSendPending(panel, draft);
        await gate.wait();
        await gate.reject();
        await expect(nativeSendPending(panel)).toHaveCount(0);
        await expect(
          panel
            .getByRole('status')
            .filter({
              hasText:
                'Browser safety state is unavailable. No browser work can start. Restore storage access before recovery.',
            })
            .first()
        ).toBeVisible();
        await expect(input).toHaveValue(draft);
        await expect(panel.getByRole('region', { name: 'Agent conversation' })).not.toContainText(
          draft
        );
        await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
        await expect(target.locator('#count')).toHaveText('0');
        await expect(other.locator('#count')).toHaveText('0');
        expect(seenChatBodies).toHaveLength(0);

        await gate.restore();
        const controls = supervision(panel);
        await controls.getByRole('button', { name: 'Check recovery readiness' }).click();
        const recover = controls.getByRole('button', { name: 'Recover browser control' });
        await expect(recover).toBeEnabled();
        await expect(nativeSendPending(panel)).toHaveCount(0);
        await expect(input).toHaveValue(draft);
        await expect(target.locator('#count')).toHaveText('0');
        await expect(other.locator('#count')).toHaveText('0');
        expect(seenChatBodies).toHaveLength(0);
        await recover.click();
        await expect(controls).toContainText('Enabled — idle');
        await expect(nativeSendPending(panel)).toHaveCount(0);
        await expect(input).toHaveValue(draft);
        await expect(target.locator('#count')).toHaveText('0');
        await expect(other.locator('#count')).toHaveText('0');
        expect(seenChatBodies).toHaveLength(0);

        await panel.getByRole('button', { exact: true, name: 'Send message' }).click();
        await expect(panel.getByText(resultText, { exact: true })).toBeVisible();
        await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
        await expect(nativeSendPending(panel)).toHaveCount(0);
        await expect(input).toHaveValue('');
        await expect(target.locator('#count')).toHaveText('1');
        await expect(other.locator('#count')).toHaveText('0');
        expect(seenChatBodies.map(body => nativeSendUserTexts(body))).toEqual([[draft], [draft]]);
      } finally {
        await gate.dispose();
      }
    },
    { gateway: nativeSendGateway(seenChatBodies) }
  );
});

for (const change of ['changed', 'closed'] as const) {
  test(`native gap A1: ${change} target retains Send without retargeting`, async () => {
    const seenChatBodies: unknown[] = [];
    await withHarness(
      async ({ panel, target, other }) => {
        await prepareNativeSend(panel);
        const input = panel.getByLabel('Message agent');
        const draft = `Retain this message when the target is ${change}.`;
        const gate = await holdNativeSendBoundary(panel, 'tab');
        try {
          await input.fill(draft);
          await input.press('Enter');
          await expectNativeSendPending(panel, draft);
          await gate.wait();
          await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
          await expect(target.locator('#count')).toHaveText('0');
          await (change === 'changed'
            ? panel.getByLabel('Target tab').selectOption({ label: 'Unapproved tab' })
            : target.close());
          await expectNativeSendPending(panel, draft);
          expect(seenChatBodies).toHaveLength(0);
          await gate.release();
          await expect.poll(gate.outcome).toEqual({ failed: change === 'closed', settled: true });
          await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
          await expect(nativeSendPending(panel)).toHaveCount(0);
          await expect(
            panel.getByRole('status').filter({
              hasText:
                'The target tab changed or closed. Your message is retained. Select a target tab and submit again.',
            })
          ).toBeVisible();
          await expect(input).toHaveValue(draft);
          await expect(panel.getByRole('region', { name: 'Agent conversation' })).not.toContainText(
            draft
          );
          if (change === 'changed') {
            await expect(target.locator('#count')).toHaveText('0');
          }
          await panel.getByLabel('Target tab').selectOption({ label: 'Unapproved tab' });
          await expect(
            panel.getByRole('button', { exact: true, name: 'Send message' })
          ).toBeEnabled();
          await expect(input).toHaveValue(draft);
          await expect(other.locator('#count')).toHaveText('0');
          expect(seenChatBodies).toHaveLength(0);
        } finally {
          await gate.dispose();
        }
      },
      { gateway: nativeSendGateway(seenChatBodies) }
    );
  });
}

test('native gap A1: closing a nonempty conversation cancels Send and History retains its draft', async () => {
  const seenChatBodies: unknown[] = [];
  await withHarness(
    async ({ panel, target, other }) => {
      const title = 'Cancelled Send';
      await prepareNativeSend(panel, [title]);
      const input = panel.getByLabel('Message agent');
      const draft = 'Retain this cancelled conversation draft.';
      const tabs = panel.getByRole('tablist', { name: 'Conversation tabs' });
      const gate = await holdNativeSendBoundary(panel, 'tab');
      try {
        await input.fill(draft);
        await input.press('Enter');
        await expectNativeSendPending(panel, draft);
        await gate.wait();
        await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
        await tabs.getByRole('button', { exact: true, name: `Close Prior ${title}` }).click();
        await expect(tabs.getByRole('tab', { exact: true, name: `Prior ${title}` })).toHaveCount(0);
        await expect(nativeSendPending(panel)).toHaveCount(0);
        await expect(input).toHaveValue('');
        await gate.release();
        await expect.poll(gate.outcome).toEqual({ failed: false, settled: true });
        await expect.poll(() => heldExecutionModes(panel)).toEqual([]);

        await panel.getByRole('button', { exact: true, name: 'History' }).click();
        await panel
          .getByRole('dialog', { name: 'Conversation history' })
          .getByRole('button', { exact: true, name: `Open Prior ${title}` })
          .click();
        await expect(
          tabs.getByRole('tab', { exact: true, name: `Prior ${title}` })
        ).toHaveAttribute('aria-selected', 'true');
        await expect(input).toHaveValue(draft);
        await expect(nativeSendPending(panel)).toHaveCount(0);
        await expect(
          panel.getByRole('button', { exact: true, name: 'Send message' })
        ).toBeEnabled();
        const conversation = panel.getByRole('region', { name: 'Agent conversation' });
        await expect(conversation.getByText(`Prior ${title}`, { exact: true })).toBeVisible();
        await expect(conversation.getByText(draft, { exact: true })).toHaveCount(0);
        await expect(target.locator('#count')).toHaveText('0');
        await expect(other.locator('#count')).toHaveText('0');
        expect(seenChatBodies).toHaveLength(0);
      } finally {
        await gate.dispose();
      }
    },
    { gateway: nativeSendGateway(seenChatBodies) }
  );
});

test('native gap A1: blank and whitespace drafts never start Send admission', async () => {
  const seenChatBodies: unknown[] = [];
  await withHarness(
    async ({ panel, target, other }) => {
      await prepareNativeSend(panel);
      const input = panel.getByLabel('Message agent');
      // A tab gate leaves any accidental admission pending without trapping background safety reads.
      const gate = await holdNativeSendBoundary(panel, 'tab');
      try {
        for (const draft of ['', '   \n  ']) {
          await input.fill(draft);
          await expect(
            panel.getByRole('button', { exact: true, name: 'Send message' })
          ).toBeDisabled();
          await input.press('Enter');
          await expect(input).toBeFocused();
          await expect(input).toHaveValue(draft);
          await expect(nativeSendPending(panel)).toHaveCount(0);
          await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
          await expect(target.locator('#count')).toHaveText('0');
          await expect(other.locator('#count')).toHaveText('0');
          expect(seenChatBodies).toHaveLength(0);
        }
      } finally {
        await gate.dispose();
      }
    },
    { gateway: nativeSendGateway(seenChatBodies) }
  );
});

for (const outcome of ['success', 'failure'] as const) {
  test(`native gap A5 Send: late lookup ${outcome} cannot clear a newer Send`, async () => {
    const seenChatBodies: unknown[] = [];
    await withHarness(
      async ({ panel, target, other }) => {
        const title = 'Send race';
        await prepareNativeSend(panel, [title]);
        await panel.getByLabel('Target tab').selectOption({ label: 'Unapproved tab' });
        const input = panel.getByLabel('Message agent');
        const oldDraft = 'Never submit this cancelled older Send.';
        const newDraft = 'Submit only this newer Send.';
        const tabs = panel.getByRole('tablist', { name: 'Conversation tabs' });
        const older = await holdNativeSendBoundary(panel, 'tab');
        try {
          await input.fill(oldDraft);
          await input.press('Enter');
          await expectNativeSendPending(panel, oldDraft);
          await older.wait();
          await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
          await tabs.getByRole('button', { exact: true, name: `Close Prior ${title}` }).click();
          await expect(nativeSendPending(panel)).toHaveCount(0);
          await expect(tabs.getByRole('tab', { exact: true, name: `Prior ${title}` })).toHaveCount(
            0
          );
          await expect(other.locator('#count')).toHaveText('0');
          if (outcome === 'failure') {
            await other.close();
          }
          await panel.getByRole('button', { exact: true, name: 'History' }).click();
          await panel
            .getByRole('dialog', { name: 'Conversation history' })
            .getByRole('button', { exact: true, name: `Open Prior ${title}` })
            .click();
          await expect(input).toHaveValue(oldDraft);
          await expect(nativeSendPending(panel)).toHaveCount(0);
          await panel.getByLabel('Target tab').selectOption({ label: 'Approved browser task tab' });
          const newer = await holdNativeSendBoundary(panel, 'tab');
          try {
            await input.fill(newDraft);
            await input.press('Enter');
            await expectNativeSendPending(panel, newDraft);
            await newer.wait();
            await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared', 'shared']);
            await older.release();
            await expect
              .poll(older.outcome)
              .toEqual({ failed: outcome === 'failure', settled: true });
            await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
            await expectNativeSendPending(panel, newDraft);
            const conversation = panel.getByRole('region', { name: 'Agent conversation' });
            await expect(conversation.getByText(oldDraft, { exact: true })).toHaveCount(0);
            await expect(conversation.getByText(newDraft, { exact: true })).toHaveCount(0);
            await expect(target.locator('#count')).toHaveText('0');
            expect(seenChatBodies).toHaveLength(0);

            await newer.release();
            await expect(nativeSendPending(panel)).toHaveCount(0);
            await expect(conversation.getByText(resultText, { exact: true })).toBeVisible();
            await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
            await expect(conversation.getByText(oldDraft, { exact: true })).toHaveCount(0);
            await expect(conversation.getByText(newDraft, { exact: true })).toHaveCount(1);
            await expect(input).toHaveValue('');
            await expect(target.locator('#count')).toHaveText('1');
            if (outcome === 'success') {
              await expect(other.locator('#count')).toHaveText('0');
            }
            expect(seenChatBodies.map(body => nativeSendUserTexts(body))).toEqual([
              [`Prior ${title}`, newDraft],
              [`Prior ${title}`, newDraft],
            ]);
          } finally {
            await newer.dispose();
          }
        } finally {
          await older.dispose();
        }
      },
      { gateway: nativeSendGateway(seenChatBodies) }
    );
  });
}

test('native gap A5 Send: conversation switches isolate pending drafts and settled results', async () => {
  const seenChatBodies: unknown[] = [];
  const secondResult = 'Only the second conversation completed this message.';
  await withHarness(
    async ({ panel, target, other }) => {
      await prepareNativeSend(panel, ['First Send', 'Second Send']);
      const tabs = panel.getByRole('tablist', { name: 'Conversation tabs' });
      const firstTab = tabs.getByRole('tab', { exact: true, name: 'Prior First Send' });
      const secondTab = tabs.getByRole('tab', { exact: true, name: 'Prior Second Send' });
      const input = panel.getByLabel('Message agent');
      const firstDraft = 'Apply the first conversation action.';
      const secondDraft = 'Answer only in the second conversation.';
      const newerDraft = 'Keep the second conversation draft after both attempts settle.';
      const first = await holdNativeSendBoundary(panel, 'tab');
      try {
        await input.fill(firstDraft);
        await input.press('Enter');
        await expectNativeSendPending(panel, firstDraft);
        await first.wait();
        await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
        await secondTab.click();
        await expect(nativeSendPending(panel)).toHaveCount(0);
        await expect(input).toHaveValue('');
        await input.fill(secondDraft);
        await expect(
          panel.getByRole('button', { exact: true, name: 'Send message' })
        ).toBeEnabled();
        await firstTab.click();
        await expectNativeSendPending(panel, firstDraft);
        await secondTab.click();
        await expect(nativeSendPending(panel)).toHaveCount(0);
        await expect(input).toHaveValue(secondDraft);
        const second = await holdNativeSendBoundary(panel, 'tab');
        try {
          await input.press('Enter');
          await expectNativeSendPending(panel, secondDraft);
          await second.wait();
          await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared', 'shared']);
          await input.fill(newerDraft);
          await first.release();
          await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
          await expectNativeSendPending(panel, newerDraft);
          const conversation = panel.getByRole('region', { name: 'Agent conversation' });
          await expect(conversation.getByText(firstDraft, { exact: true })).toHaveCount(0);
          await expect(conversation.getByText(resultText, { exact: true })).toHaveCount(0);
          await expect(target.locator('#count')).toHaveText('1');
          expect(seenChatBodies.map(body => nativeSendUserTexts(body))).toEqual([
            ['Prior First Send', firstDraft],
            ['Prior First Send', firstDraft],
          ]);

          await second.release();
          await expect(nativeSendPending(panel)).toHaveCount(0);
          await expect(conversation.getByText(secondResult, { exact: true })).toBeVisible();
          await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
          await expect(conversation.getByText(secondDraft, { exact: true })).toHaveCount(1);
          await expect(input).toHaveValue(newerDraft);
          await firstTab.click();
          await expect(nativeSendPending(panel)).toHaveCount(0);
          await expect(input).toHaveValue('');
          await expect(conversation.getByText(firstDraft, { exact: true })).toHaveCount(1);
          await expect(conversation.getByText(resultText, { exact: true })).toBeVisible();
          await expect(conversation.getByText(secondResult, { exact: true })).toHaveCount(0);
          await secondTab.click();
          await expect(nativeSendPending(panel)).toHaveCount(0);
          await expect(input).toHaveValue(newerDraft);
          await expect(conversation.getByText(secondResult, { exact: true })).toBeVisible();
          await expect(conversation.getByText(resultText, { exact: true })).toHaveCount(0);
          await expect(target.locator('#count')).toHaveText('1');
          await expect(other.locator('#count')).toHaveText('0');
          expect(seenChatBodies.map(body => nativeSendUserTexts(body))).toEqual([
            ['Prior First Send', firstDraft],
            ['Prior First Send', firstDraft],
            ['Prior Second Send', secondDraft],
          ]);
        } finally {
          await second.dispose();
        }
      } finally {
        await first.dispose();
      }
    },
    {
      gateway: {
        ...nativeSendGateway(seenChatBodies),
        thirdCompletionEvents: content(secondResult),
      },
    }
  );
});

const nativeQueueRun = 'Finish local run A before resuming Q.';
const nativeQueueRunResult = 'Local run A completed normally.';
const nativeQueueResume = (panel: Page) =>
  panel.getByRole('button', { exact: true, name: 'Resume queued message' });
const nativeQueueGateway = (seenChatBodies: unknown[], finish: Promise<void>) => {
  const gateway = nativeSendGateway(seenChatBodies);
  return {
    ...gateway,
    beforeFirstCompletion: () => finish,
    firstCompletionEvents: content(nativeQueueRunResult),
    secondCompletionEvents: gateway.firstCompletionEvents,
    thirdCompletionEvents: gateway.secondCompletionEvents,
  };
};
const holdNativeQueueContender = (panel: Page) =>
  panel.evaluateHandle(name => {
    const hold = Promise.withResolvers<void>();
    const released = navigator.locks.request(name, { mode: 'exclusive' }, () => hold.promise);
    return {
      release: async () => {
        hold.resolve();
        await released;
      },
    };
  }, executionLock);
const expectNativeQueueEmpty = async (panel: Page): Promise<void> => {
  await expect(nativeQueueResume(panel)).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Cancel queued message' })).toHaveCount(0);
  await expect(panel.getByText(/^Queued:/u)).toHaveCount(0);
};
const expectNativeQueueRetained = async (panel: Page, queued: string): Promise<void> => {
  await expect(panel.getByText(`Queued: ${queued}`, { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Cancel queued message' })).toBeEnabled();
  await expect(nativeQueueResume(panel)).toBeEnabled();
  await expect(nativeQueueResume(panel)).toHaveAttribute('aria-busy', 'false');
  await expect(nativeSendPending(panel)).toHaveCount(0);
  await expect(panel.getByLabel('Message agent')).toHaveValue('');
};
const expectNativeQueuePending = async (panel: Page, queued: string): Promise<void> => {
  await expectNativeSendPending(panel, '');
  await expect(nativeQueueResume(panel)).toHaveAttribute('aria-busy', 'true');
  await expect(nativeQueueResume(panel)).toBeDisabled();
  await expect(panel.getByText(`Queued: ${queued}`, { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Cancel queued message' })).toBeEnabled();
};
const expectNativeQueueDrained = async (
  { panel, target, other }: Harness,
  effects: number
): Promise<void> => {
  await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
  if (!target.isClosed()) {
    await expect(target.locator('#count')).toHaveText(String(effects));
  }
  if (!other.isClosed()) {
    await expect(other.locator('#count')).toHaveText('0');
  }
};
const expectNativeQueueUnsubmitted = async (
  { panel, target, other }: Harness,
  queued: string,
  seenChatBodies: unknown[]
): Promise<void> => {
  const conversation = panel.getByRole('region', { name: 'Agent conversation' });
  await expect(conversation.getByText(nativeQueueRun, { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(queued, { exact: true })).toHaveCount(0);
  if (!target.isClosed()) {
    await expect(target.locator('#count')).toHaveText('0');
  }
  if (!other.isClosed()) {
    await expect(other.locator('#count')).toHaveText('0');
  }
  expect(seenChatBodies.map(body => nativeSendUserTexts(body))).toEqual([[nativeQueueRun]]);
};
const expectNativeQueueCompletion = async (
  harness: Harness,
  submitted: string,
  seenChatBodies: unknown[]
): Promise<void> => {
  const { panel } = harness;
  const conversation = panel.getByRole('region', { name: 'Agent conversation' });
  await expect(conversation.getByText(resultText, { exact: true })).toBeVisible();
  await expectNativeQueueDrained(harness, 1);
  await expect(nativeSendPending(panel)).toHaveCount(0);
  await expectNativeQueueEmpty(panel);
  await expect(conversation.getByText(nativeQueueRun, { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(submitted, { exact: true })).toHaveCount(1);
  expect(seenChatBodies.map(body => nativeSendUserTexts(body))).toEqual([
    [nativeQueueRun],
    [nativeQueueRun, submitted],
    [nativeQueueRun, submitted],
  ]);
};
const prepareNativeQueue = async (
  harness: Harness,
  queued: string,
  { seenChatBodies, finish }: { seenChatBodies: unknown[]; finish: () => void }
): Promise<void> => {
  const { panel, openPanel } = harness;
  const input = panel.getByLabel('Message agent');
  try {
    await expectNativeQueueEmpty(panel);
    await input.fill(nativeQueueRun);
    await input.press('Enter');
    await expect(panel.getByRole('button', { exact: true, name: 'Stop' })).toBeVisible();
    await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
    await expect.poll(() => seenChatBodies.length).toBe(1);
    await input.fill(queued);
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await expect(panel.getByText(`Queued: ${queued}`, { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Cancel queued message' })).toBeVisible();
    await expect(nativeQueueResume(panel)).toHaveCount(0);
    await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);

    const second = await openPanel();
    try {
      const contender = await holdNativeQueueContender(second);
      try {
        await expect
          .poll(() =>
            panel.evaluate(async name => {
              const state = await navigator.locks.query();
              return (state.pending ?? [])
                .filter(lock => lock.name === name)
                .map(lock => lock.mode);
            }, executionLock)
          )
          .toEqual(['exclusive']);
        await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
        // A must finish normally: Stop would discard Q instead of testing the automatic drain.
        finish();
        await expect(panel.getByText(nativeQueueRunResult, { exact: true })).toBeVisible();
        await expect.poll(() => heldExecutionModes(panel)).toEqual(['exclusive']);
        await expectNativeQueueRetained(panel, queued);
        await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);
        await contender.evaluate(held => held.release());
      } finally {
        // Release A before waiting for a contender that can still be queued behind A.
        finish();
        try {
          await contender.evaluate(held => held.release());
        } finally {
          await contender.dispose();
        }
      }
    } finally {
      await second.close();
    }
    await expectNativeQueueDrained(harness, 0);
    await expect(
      panel.getByRole('status').filter({
        hasText:
          'Your queued message is retained. Use Resume queued message when browser control is available.',
      })
    ).toBeVisible();
    await expectNativeQueueRetained(panel, queued);
    await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);
  } finally {
    finish();
    await expectNativeQueueDrained(harness, 0);
  }
};

test('native gap A2: keyboard Resume retains focus and consumes captured Q once', async () => {
  const completion = Promise.withResolvers<void>();
  const seenChatBodies: unknown[] = [];
  await withHarness(
    async harness => {
      const { panel } = harness;
      const queued = 'Apply queued Q exactly once.';
      await prepareNativeSend(panel);
      await prepareNativeQueue(harness, queued, { finish: completion.resolve, seenChatBodies });
      const resume = nativeQueueResume(panel);
      const gate = await holdNativeSendBoundary(panel, 'safety', 'resume');
      try {
        await keyboardReach(panel, resume);
        await expect(resume).toBeFocused();
        await panel.keyboard.press('Enter');
        await expectNativeQueuePending(panel, queued);
        await gate.wait();
        await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
        await expect(resume).toBeFocused();
        await panel.keyboard.press('Enter');
        await expect(resume).toBeFocused();
        await expectNativeQueuePending(panel, queued);
        await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);

        await gate.release();
        await expectNativeQueueCompletion(harness, queued, seenChatBodies);
        await expect(panel.getByLabel('Message agent')).toHaveValue('');
      } finally {
        try {
          await gate.dispose();
        } finally {
          await expectNativeQueueDrained(harness, 1);
        }
      }
    },
    { gateway: nativeQueueGateway(seenChatBodies, completion.promise) }
  );
});

test('native gap A2: native contention retains Q until explicit Resume', async () => {
  const completion = Promise.withResolvers<void>();
  const seenChatBodies: unknown[] = [];
  await withHarness(
    async harness => {
      const { panel, openPanel } = harness;
      const queued = 'Retain Q through fresh native contention.';
      await prepareNativeSend(panel);
      await prepareNativeQueue(harness, queued, { finish: completion.resolve, seenChatBodies });
      const second = await openPanel();
      const gate = await holdNativeSendBoundary(panel, 'safety', 'resume');
      try {
        await nativeQueueResume(panel).click();
        await expectNativeQueuePending(panel, queued);
        await gate.wait();
        const contender = await holdNativeQueueContender(second);
        try {
          await expect.poll(() => heldExecutionModes(panel)).toEqual(['exclusive']);
          await gate.release();
          await expectNativeQueueRetained(panel, queued);
          await expect(
            panel.getByRole('status').filter({ hasText: 'owns browser control' }).first()
          ).toBeVisible();
          await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);

          await contender.evaluate(held => held.release());
          await gate.restore();
          await expectNativeQueueDrained(harness, 0);
          await expect(
            panel.getByRole('status').filter({
              hasText:
                'Your queued message is retained. Use Resume queued message when browser control is available.',
            })
          ).toBeVisible();
          await expectNativeQueueRetained(panel, queued);
          await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);
          await nativeQueueResume(panel).click();
          await expectNativeQueueCompletion(harness, queued, seenChatBodies);
          await expect(panel.getByLabel('Message agent')).toHaveValue('');
        } finally {
          try {
            await contender.evaluate(held => held.release());
          } finally {
            await contender.dispose();
          }
        }
      } finally {
        try {
          await gate.dispose();
        } finally {
          await second.close();
          await expectNativeQueueDrained(harness, 1);
        }
      }
    },
    { gateway: nativeQueueGateway(seenChatBodies, completion.promise) }
  );
});

test('native gap A2: storage failure retains Q until explicit recovery and Resume', async () => {
  const completion = Promise.withResolvers<void>();
  const seenChatBodies: unknown[] = [];
  await withHarness(
    async harness => {
      const { panel } = harness;
      const queued = 'Retain Q through unavailable safety storage.';
      await enable(panel);
      await prepareNativeSend(panel);
      await prepareNativeQueue(harness, queued, { finish: completion.resolve, seenChatBodies });
      const gate = await holdNativeSendBoundary(panel, 'safety', 'resume');
      try {
        await nativeQueueResume(panel).click();
        await expectNativeQueuePending(panel, queued);
        await gate.wait();
        await gate.reject();
        await expectNativeQueueRetained(panel, queued);
        await expect(
          panel
            .getByRole('status')
            .filter({
              hasText:
                'Browser safety state is unavailable. No browser work can start. Restore storage access before recovery.',
            })
            .first()
        ).toBeVisible();
        await expectNativeQueueDrained(harness, 0);
        await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);

        await gate.restore();
        await expectNativeQueueRetained(panel, queued);
        await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);
        const controls = supervision(panel);
        await controls.getByRole('button', { name: 'Check recovery readiness' }).click();
        const recover = controls.getByRole('button', { name: 'Recover browser control' });
        await expect(recover).toBeEnabled();
        await expectNativeQueueRetained(panel, queued);
        await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);
        await recover.click();
        await expect(controls).toContainText('Enabled — idle');
        await expectNativeQueueRetained(panel, queued);
        await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);

        await nativeQueueResume(panel).click();
        await expectNativeQueueCompletion(harness, queued, seenChatBodies);
        await expect(panel.getByLabel('Message agent')).toHaveValue('');
      } finally {
        try {
          await gate.dispose();
        } finally {
          await expectNativeQueueDrained(harness, 1);
        }
      }
    },
    { gateway: nativeQueueGateway(seenChatBodies, completion.promise) }
  );
});

for (const change of ['changed', 'closed'] as const) {
  test(`native gap A2: ${change} target retains Q without retargeting`, async () => {
    const completion = Promise.withResolvers<void>();
    const seenChatBodies: unknown[] = [];
    await withHarness(
      async harness => {
        const { panel, target } = harness;
        const queued = `Retain Q when its target is ${change}.`;
        await prepareNativeSend(panel);
        await prepareNativeQueue(harness, queued, { finish: completion.resolve, seenChatBodies });
        const gate = await holdNativeSendBoundary(panel, 'tab', 'resume');
        try {
          await nativeQueueResume(panel).click();
          await expectNativeQueuePending(panel, queued);
          await gate.wait();
          await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
          await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);
          await (change === 'changed'
            ? panel.getByLabel('Target tab').selectOption({ label: 'Unapproved tab' })
            : target.close());
          await expectNativeQueuePending(panel, queued);
          await gate.release();
          await expect.poll(gate.outcome).toEqual({ failed: change === 'closed', settled: true });
          await expectNativeQueueDrained(harness, 0);
          await expectNativeQueueRetained(panel, queued);
          await expect(
            panel.getByRole('status').filter({
              hasText:
                'The target tab changed or closed. Your queued message is retained. Select a target tab and use Resume queued message.',
            })
          ).toBeVisible();
          await gate.restore();
          await panel.getByLabel('Target tab').selectOption({ label: 'Unapproved tab' });
          await expectNativeQueueRetained(panel, queued);
          await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);
        } finally {
          try {
            await gate.dispose();
          } finally {
            await expectNativeQueueDrained(harness, 0);
          }
        }
      },
      { gateway: nativeQueueGateway(seenChatBodies, completion.promise) }
    );
  });
}

test('native gap A2: Cancel queued message invalidates a held target lookup', async () => {
  const completion = Promise.withResolvers<void>();
  const seenChatBodies: unknown[] = [];
  await withHarness(
    async harness => {
      const { panel } = harness;
      const queued = 'Never dispatch cancelled Q.';
      await prepareNativeSend(panel);
      await prepareNativeQueue(harness, queued, { finish: completion.resolve, seenChatBodies });
      const gate = await holdNativeSendBoundary(panel, 'tab', 'resume');
      try {
        await nativeQueueResume(panel).click();
        await expectNativeQueuePending(panel, queued);
        await gate.wait();
        await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
        await panel.getByRole('button', { name: 'Cancel queued message' }).click();
        await expectNativeQueueEmpty(panel);
        await expect(nativeSendPending(panel)).toHaveCount(0);
        await expect(panel.getByLabel('Message agent')).toHaveValue('');
        await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);

        await gate.release();
        await expect.poll(gate.outcome).toEqual({ failed: false, settled: true });
        await expectNativeQueueDrained(harness, 0);
        await expectNativeQueueEmpty(panel);
        await expect(nativeSendPending(panel)).toHaveCount(0);
        await expect(panel.getByLabel('Message agent')).toHaveValue('');
        await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);
      } finally {
        try {
          await gate.dispose();
        } finally {
          await expectNativeQueueDrained(harness, 0);
        }
      }
    },
    { gateway: nativeQueueGateway(seenChatBodies, completion.promise) }
  );
});

for (const outcome of ['success', 'failure'] as const) {
  test(`native gap A5 Queue: late lookup ${outcome} cannot clear a newer Send`, async () => {
    const completion = Promise.withResolvers<void>();
    const seenChatBodies: unknown[] = [];
    await withHarness(
      async harness => {
        const { panel, other } = harness;
        const queued = 'Never submit Q after its cancellation.';
        const newDraft = 'Submit only the newer Send B.';
        const followUp = 'Keep this unsent draft after B.';
        await prepareNativeSend(panel);
        await prepareNativeQueue(harness, queued, { finish: completion.resolve, seenChatBodies });
        await panel.getByLabel('Target tab').selectOption({ label: 'Unapproved tab' });
        const older = await holdNativeSendBoundary(panel, 'tab', 'resume');
        try {
          await nativeQueueResume(panel).click();
          await expectNativeQueuePending(panel, queued);
          await older.wait();
          await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
          await panel.getByRole('button', { name: 'Cancel queued message' }).click();
          await expectNativeQueueEmpty(panel);
          await expect(nativeSendPending(panel)).toHaveCount(0);
          await expect(panel.getByLabel('Message agent')).toHaveValue('');
          await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);
          if (outcome === 'failure') {
            await other.close();
          }
          await panel.getByLabel('Target tab').selectOption({ label: 'Approved browser task tab' });
          const newer = await holdNativeSendBoundary(panel, 'tab');
          try {
            const input = panel.getByLabel('Message agent');
            await input.fill(newDraft);
            await input.press('Enter');
            await expectNativeSendPending(panel, newDraft);
            await newer.wait();
            await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared', 'shared']);
            await input.fill(followUp);
            await older.release();
            await expect
              .poll(older.outcome)
              .toEqual({ failed: outcome === 'failure', settled: true });
            await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
            await expectNativeSendPending(panel, followUp);
            await expectNativeQueueEmpty(panel);
            await expectNativeQueueUnsubmitted(harness, queued, seenChatBodies);
            const conversation = panel.getByRole('region', { name: 'Agent conversation' });
            await expect(conversation.getByText(newDraft, { exact: true })).toHaveCount(0);
            await expect(conversation.getByText(followUp, { exact: true })).toHaveCount(0);

            await newer.release();
            await expectNativeQueueCompletion(harness, newDraft, seenChatBodies);
            await expect(input).toHaveValue(followUp);
            await expect(conversation.getByText(queued, { exact: true })).toHaveCount(0);
            await expect(conversation.getByText(followUp, { exact: true })).toHaveCount(0);
          } finally {
            await newer.dispose();
          }
        } finally {
          try {
            await older.dispose();
          } finally {
            await expectNativeQueueDrained(harness, 1);
          }
        }
      },
      { gateway: nativeQueueGateway(seenChatBodies, completion.promise) }
    );
  });
}

type NativeWorkflowInput = { name: string; note?: string };
const nativeWorkflowResult = 'Native workflow admission result';
const nativeWorkflowStorageBlocker =
  'Browser safety state is unavailable. No browser work can start. Restore storage access before recovery.';
const nativeWorkflowForm = (panel: Page) =>
  panel.getByRole('dialog', { exact: true, name: `Run workflow "${nativeWorkflowName}"` });
const nativeWorkflowRoot = (panel: Page, parameters: boolean) =>
  parameters
    ? nativeWorkflowForm(panel)
    : panel.getByRole('dialog', { exact: true, name: 'Settings panel' });
const nativeWorkflowRun = (panel: Page, parameters: boolean) =>
  parameters
    ? nativeWorkflowForm(panel).getByRole('button', { exact: true, name: 'Run' })
    : panel.getByRole('button', { exact: true, name: `Run workflow "${nativeWorkflowName}"` });
const nativeWorkflowPending = (root: Locator) =>
  root.getByRole('status').filter({
    hasText: 'Checking browser control… Your workflow has not started.',
  });
const fillNativeWorkflow = async (panel: Page, input: NativeWorkflowInput): Promise<void> => {
  const form = nativeWorkflowForm(panel);
  await form.getByRole('textbox', { exact: true, name: 'name — A name' }).fill(input.name);
  await form
    .getByRole('textbox', { exact: true, name: 'note (optional) — A note' })
    .fill(input.note ?? '');
};
const prepareNativeWorkflow = async (
  { panel, target }: Harness,
  input?: NativeWorkflowInput
): Promise<void> => {
  await prepareNativeSend(panel, ['Settings admission']);
  const script = `await page.click("#effect"); return { done: true, result: { input, marker: "${nativeWorkflowResult}" } };`;
  await setExtensionStorage(panel, {
    kiloAgentWorkflows: [
      {
        approvedScriptHash: createHash('sha256').update(script).digest('hex'),
        createdAt: Date.now(),
        description: 'One native action with the supplied input.',
        id: randomUUID(),
        name: nativeWorkflowName,
        params:
          input === undefined
            ? []
            : [
                { description: 'A name', name: 'name', required: true },
                { description: 'A note', name: 'note', required: false },
              ],
        scopeOrigin: new URL(target.url()).origin,
        script,
        updatedAt: Date.now(),
      },
    ],
    kiloWorkflowSettings: {
      allowWorkflowsInSafeMode: true,
      autoApproveWorkflowChanges: false,
      autoApproveWorkflowRuns: false,
    },
  });
  await panel.getByLabel('Settings', { exact: true }).click();
  await expect(nativeWorkflowRun(panel, false)).toBeEnabled();
  if (input !== undefined) {
    await nativeWorkflowRun(panel, false).click();
    await fillNativeWorkflow(panel, input);
  }
};
const expectNativeWorkflowFields = async (
  panel: Page,
  input: NativeWorkflowInput,
  readOnly: boolean
): Promise<void> => {
  for (const [name, value] of [
    ['name — A name', input.name],
    ['note (optional) — A note', input.note ?? ''],
  ] as const) {
    const field = nativeWorkflowForm(panel).getByRole('textbox', { exact: true, name });
    await expect(field).toHaveValue(value);
    await expect(field).toHaveJSProperty('readOnly', readOnly);
    await expect(field).toBeEnabled();
    if (!readOnly) {
      await expect(field).toBeEditable();
    }
  }
};
const expectNativeWorkflowPending = async (
  panel: Page,
  input?: NativeWorkflowInput
): Promise<void> => {
  const root = nativeWorkflowRoot(panel, input !== undefined);
  const pending = nativeWorkflowPending(root);
  await expect(root).toBeVisible();
  await expect(pending).toHaveCount(1);
  await expect(pending).toBeVisible();
  await expect(pending).toHaveText('Checking browser control… Your workflow has not started.');
  await expect(nativeWorkflowRun(panel, input !== undefined)).toBeDisabled();
  await expect(nativeWorkflowRun(panel, input !== undefined)).toHaveAttribute('aria-busy', 'true');
  if (input !== undefined) {
    await expectNativeWorkflowFields(panel, input, true);
  }
};
const expectNativeWorkflowRetained = async (
  panel: Page,
  input?: NativeWorkflowInput
): Promise<void> => {
  await expect(nativeWorkflowRoot(panel, false)).toBeVisible();
  await expect(nativeWorkflowRoot(panel, input !== undefined)).toBeVisible();
  await expect(nativeWorkflowPending(nativeWorkflowRoot(panel, input !== undefined))).toHaveCount(
    0
  );
  await expect(nativeWorkflowRun(panel, input !== undefined)).toBeEnabled();
  await expect(nativeWorkflowRun(panel, input !== undefined)).toHaveAttribute('aria-busy', 'false');
  if (input !== undefined) {
    await expectNativeWorkflowFields(panel, input, false);
  }
};
const expectNativeWorkflowUnpublished = async (
  { panel, target, other }: Harness,
  seenChatBodies: unknown[]
): Promise<void> => {
  await expect(
    panel.getByRole('button', { exact: true, includeHidden: true, name: 'Resume workflow' })
  ).toHaveCount(0);
  // A published workflow must not add a turn to the seeded conversation before admission.
  expect(await readExtensionLocalStorage(panel, 'kiloAgentConversations')).toMatchObject({
    conversations: [
      {
        events: [
          expect.objectContaining({
            role: 'user',
            text: 'Prior Settings admission',
            type: 'message',
          }),
        ],
      },
    ],
  });
  await expect(target.locator('#count')).toHaveText('0');
  await expect(other.locator('#count')).toHaveText('0');
  expect(seenChatBodies).toHaveLength(0);
};
const expectNativeWorkflowCompletion = async (
  harness: Harness,
  input?: NativeWorkflowInput
): Promise<void> => {
  const { panel } = harness;
  await expect(nativeWorkflowRoot(panel, false)).toBeHidden();
  await expect(nativeWorkflowForm(panel)).toBeHidden();
  const workflow = panel
    .getByRole('region', { name: 'Agent conversation' })
    .locator('details')
    .filter({ hasText: nativeWorkflowResult });
  const summary = workflow.locator('summary');
  await expect(summary).toContainText('completed');
  await summary.click();
  const result = workflow.getByText(nativeWorkflowResult, { exact: false });
  await expect(result).toHaveCount(1);
  await expect(result).toBeVisible();
  await (input === undefined
    ? expect(result).not.toContainText('"name"')
    : expect(result).toContainText(`"input": ${JSON.stringify(input, null, 2)}`));
  if (input?.note === undefined) {
    await expect(result).not.toContainText('"note"');
  }
  await expect(panel.getByRole('button', { exact: true, name: 'Resume workflow' })).toHaveCount(0);
  await expectNativeQueueDrained(harness, 1);
};
const closeNativeWorkflowSettings = async (panel: Page): Promise<void> => {
  const cancel = nativeWorkflowForm(panel).getByRole('button', { exact: true, name: 'Cancel' });
  if (await cancel.isVisible()) {
    await cancel.click();
  }
  const close = panel.getByRole('button', { exact: true, name: 'Close settings' });
  if (await close.isVisible()) {
    await close.click();
  }
};

for (const parameters of [false, true]) {
  for (const outcome of [
    'success',
    'native contention',
    'storage failure',
    'cancellation',
  ] as const) {
    test(`native gap A4: ${parameters ? 'parameters' : 'no parameters'} ${outcome} settles Settings admission`, async () => {
      const seenChatBodies: unknown[] = [];
      await withHarness(
        async harness => {
          const { panel, openPanel } = harness;
          const input = parameters
            ? { name: 'Original A name', note: 'Original A note' }
            : undefined;
          if (outcome === 'storage failure') {
            await enable(panel);
          }
          await prepareNativeWorkflow(harness, input);
          const run = nativeWorkflowRun(panel, parameters);
          const root = nativeWorkflowRoot(panel, parameters);
          const gate = await holdNativeSendBoundary(
            panel,
            outcome === 'cancellation' ? 'locked-safety' : 'safety',
            parameters ? 'workflow-form' : 'workflow-row'
          );
          let effects = 0;
          try {
            await run.click();
            await expect(run).toBeFocused();
            await expectNativeWorkflowPending(panel, input);
            await gate.wait();
            await expect
              .poll(() => heldExecutionModes(panel))
              .toEqual(outcome === 'cancellation' ? ['shared'] : []);
            await panel.keyboard.press('Enter');
            await expect(run).toBeFocused();
            await expectNativeWorkflowPending(panel, input);
            if (input !== undefined) {
              for (const name of ['name — A name', 'note (optional) — A note']) {
                const field = root.getByRole('textbox', { exact: true, name });
                await field.click();
                await field.press('End');
                await panel.keyboard.type(' overwritten while pending');
              }
              await expectNativeWorkflowFields(panel, input, true);
              const cancel = root.getByRole('button', { exact: true, name: 'Cancel' });
              await keyboardReach(panel, cancel, root);
              await expect(cancel).toBeFocused();
              await expect(cancel).toBeEnabled();
            }
            await expectNativeWorkflowUnpublished(harness, seenChatBodies);

            if (outcome === 'success') {
              effects = 1;
              await gate.release();
              await expect.poll(gate.outcome).toEqual({ failed: false, settled: true });
              await gate.restore();
              await expectNativeWorkflowCompletion(harness, input);
            } else if (outcome === 'native contention') {
              const second = await openPanel();
              try {
                const contender = await holdNativeQueueContender(second);
                try {
                  await expect.poll(() => heldExecutionModes(panel)).toEqual(['exclusive']);
                  await gate.release();
                  await expectNativeWorkflowRetained(panel, input);
                  await expect(root.getByText(/owns browser control/u).first()).toBeVisible();
                  await expectNativeWorkflowUnpublished(harness, seenChatBodies);
                  await gate.restore();
                  await contender.evaluate(held => held.release());
                  await expectNativeQueueDrained(harness, 0);
                  await expect(
                    root.getByText(/Workflow input is retained\./u).first()
                  ).toBeVisible();
                  await expectNativeWorkflowRetained(panel, input);
                  await expectNativeWorkflowUnpublished(harness, seenChatBodies);

                  effects = 1;
                  await run.click();
                  await expectNativeWorkflowCompletion(harness, input);
                } finally {
                  await contender.evaluate(held => held.release());
                  await contender.dispose();
                }
              } finally {
                await second.close();
              }
            } else if (outcome === 'storage failure') {
              await gate.reject();
              await expectNativeWorkflowRetained(panel, input);
              await expect(
                root.getByText(nativeWorkflowStorageBlocker, { exact: true }).first()
              ).toBeVisible();
              await expect.poll(gate.outcome).toEqual({ failed: true, settled: true });
              await expectNativeQueueDrained(harness, 0);
              await expectNativeWorkflowUnpublished(harness, seenChatBodies);
              await gate.restore();
              await expectNativeWorkflowRetained(panel, input);
              await expectNativeWorkflowUnpublished(harness, seenChatBodies);

              const controls = supervision(root);
              await controls.getByRole('button', { name: 'Check recovery readiness' }).click();
              const recover = controls.getByRole('button', { name: 'Recover browser control' });
              await expect(recover).toBeEnabled();
              await expectNativeWorkflowRetained(panel, input);
              await expectNativeWorkflowUnpublished(harness, seenChatBodies);
              await recover.click();
              await expect(controls).toContainText('Enabled — idle');
              await expectNativeWorkflowRetained(panel, input);
              await expectNativeWorkflowUnpublished(harness, seenChatBodies);

              effects = 1;
              await run.click();
              await expectNativeWorkflowCompletion(harness, input);
            } else {
              if (parameters) {
                await panel.keyboard.press('Enter');
                await expect(nativeWorkflowForm(panel)).toBeHidden();
                await expect(nativeWorkflowRun(panel, false)).toBeEnabled();
                await expect(nativeWorkflowRun(panel, false)).toHaveAttribute('aria-busy', 'false');
              } else {
                await panel.getByRole('button', { exact: true, name: 'Close settings' }).click();
                await expect(root).toBeHidden();
              }
              await expect(nativeWorkflowPending(root)).toHaveCount(0);
              await gate.release();
              await expect.poll(gate.outcome).toEqual({ failed: false, settled: true });
              await gate.restore();
              // Observe the cancelled continuation's lock release before checking for late work.
              await expectNativeQueueDrained(harness, 0);
              await expect(nativeWorkflowForm(panel)).toBeHidden();
              await expectNativeWorkflowUnpublished(harness, seenChatBodies);
            }
          } finally {
            try {
              await closeNativeWorkflowSettings(panel);
            } finally {
              try {
                await gate.dispose();
              } finally {
                await expectNativeQueueDrained(harness, effects);
              }
            }
          }
        },
        { gateway: { seenChatBodies } }
      );
    });
  }
}

test('native gap A4: blank required name disables Run without admission', async () => {
  const seenChatBodies: unknown[] = [];
  await withHarness(
    async harness => {
      const { panel } = harness;
      const input = { name: '', note: 'Retain the optional note without a required name.' };
      await prepareNativeWorkflow(harness, input);
      const form = nativeWorkflowForm(panel);
      const run = nativeWorkflowRun(panel, true);
      const gate = await holdNativeSendBoundary(panel, 'safety', 'workflow-form');
      try {
        for (const name of ['', '   ']) {
          const field = form.getByRole('textbox', { exact: true, name: 'name — A name' });
          await field.fill(name);
          await expect(run).toBeDisabled();
          await expect(run).toHaveAttribute('aria-busy', 'false');
          await field.press('Enter');
          expect(await gate.activated()).toBe(true);
          // Periodic safety reads can enter without a submission. Observe the armed boundary and UI.
          await gate.wait();
          await expect(nativeWorkflowPending(form)).toHaveCount(0);
          await expect(run).toBeDisabled();
          await expect(run).toHaveAttribute('aria-busy', 'false');
          await expectNativeWorkflowFields(panel, { ...input, name }, false);
          await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
          const cancel = form.getByRole('button', { exact: true, name: 'Cancel' });
          await keyboardReach(panel, cancel, form);
          await expect(cancel).toBeFocused();
          await expect(cancel).toBeEnabled();
          await expectNativeWorkflowUnpublished(harness, seenChatBodies);
        }
        await panel.keyboard.press('Enter');
        await expect(form).toBeHidden();
        await expect(nativeWorkflowRun(panel, false)).toBeEnabled();
        await gate.restore();
        await expectNativeQueueDrained(harness, 0);
        await expectNativeWorkflowUnpublished(harness, seenChatBodies);
      } finally {
        try {
          await closeNativeWorkflowSettings(panel);
        } finally {
          try {
            await gate.dispose();
          } finally {
            await expectNativeQueueDrained(harness, 0);
          }
        }
      }
    },
    { gateway: { seenChatBodies } }
  );
});

test('native gap A4: blank optional note stays absent from the returned input', async () => {
  const seenChatBodies: unknown[] = [];
  await withHarness(
    async harness => {
      const { panel } = harness;
      const input = { name: 'Required name only' };
      await prepareNativeWorkflow(harness, input);
      const gate = await holdNativeSendBoundary(panel, 'safety', 'workflow-form');
      try {
        const run = nativeWorkflowRun(panel, true);
        await run.click();
        await expect(run).toBeFocused();
        await expectNativeWorkflowPending(panel, input);
        await gate.wait();
        await expectNativeWorkflowUnpublished(harness, seenChatBodies);
        await gate.release();
        await expect.poll(gate.outcome).toEqual({ failed: false, settled: true });
        await gate.restore();
        await expectNativeWorkflowCompletion(harness, input);
      } finally {
        try {
          await closeNativeWorkflowSettings(panel);
        } finally {
          try {
            await gate.dispose();
          } finally {
            await expectNativeQueueDrained(harness, 1);
          }
        }
      }
    },
    { gateway: { seenChatBodies } }
  );
});

for (const outcome of ['success', 'storage failure'] as const) {
  test(`native gap A5 Parameters: cancelled A cannot clear B ${outcome}`, async () => {
    const seenChatBodies: unknown[] = [];
    await withHarness(
      async harness => {
        const { panel } = harness;
        const oldInput = { name: 'Cancelled A name', note: 'Cancelled A note' };
        const newInput = { name: 'Current B name', note: 'Current B note' };
        await prepareNativeWorkflow(harness, oldInput);
        const older = await holdNativeSendBoundary(panel, 'locked-safety', 'workflow-form');
        let effects = 0;
        try {
          await nativeWorkflowRun(panel, true).click();
          await expectNativeWorkflowPending(panel, oldInput);
          await older.wait();
          await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
          await expectNativeWorkflowUnpublished(harness, seenChatBodies);
          const form = nativeWorkflowForm(panel);
          const cancel = form.getByRole('button', { exact: true, name: 'Cancel' });
          await keyboardReach(panel, cancel, form);
          await panel.keyboard.press('Enter');
          await expect(form).toBeHidden();
          await expect(nativeWorkflowRun(panel, false)).toBeEnabled();
          await expect(nativeWorkflowRun(panel, false)).toHaveAttribute('aria-busy', 'false');
          await nativeWorkflowRun(panel, false).click();
          await fillNativeWorkflow(panel, newInput);
          const sharedRefresh = await holdNativeSendBoundary(panel, 'safety', 'workflow-form');
          let newer: Awaited<ReturnType<typeof holdNativeSendBoundary>> | undefined;
          try {
            const run = nativeWorkflowRun(panel, true);
            await run.click();
            await expect(run).toBeFocused();
            await expectNativeWorkflowPending(panel, newInput);
            await expectNativeWorkflowUnpublished(harness, seenChatBodies);
            await older.release();
            await expect.poll(older.outcome).toEqual({ failed: false, settled: true });
            await sharedRefresh.wait();
            // A has released its native lock; its release tail still shares B's first refresh.
            await expect.poll(() => heldExecutionModes(panel)).toEqual([]);
            await expectNativeWorkflowPending(panel, newInput);
            await expect(run).toBeFocused();

            newer = await holdNativeSendBoundary(panel, 'safety', 'workflow-form');
            // Arm the next read with the still-focused Run, without submitting another attempt.
            await panel.keyboard.press('Enter');
            expect(await newer.activated()).toBe(true);
            await sharedRefresh.release();
            await expect.poll(sharedRefresh.outcome).toEqual({ failed: false, settled: true });
            await newer.wait();
            // The shared refresh lets A finish before B's native callback requests its own refresh.
            await expect.poll(() => heldExecutionModes(panel)).toEqual(['shared']);
            await expectNativeWorkflowPending(panel, newInput);
            await expect(run).toBeFocused();
            expect(await newer.outcome()).toEqual({ failed: false, settled: false });
            await expectNativeWorkflowUnpublished(harness, seenChatBodies);

            if (outcome === 'success') {
              effects = 1;
              await newer.release();
              await expect.poll(newer.outcome).toEqual({ failed: false, settled: true });
              await newer.restore();
              await sharedRefresh.restore();
              await older.restore();
              await expectNativeWorkflowCompletion(harness, newInput);
            } else {
              await newer.reject();
              await expectNativeWorkflowRetained(panel, newInput);
              await expect(
                form.getByRole('alert').filter({ hasText: nativeWorkflowStorageBlocker })
              ).toBeVisible();
              await expect.poll(newer.outcome).toEqual({ failed: true, settled: true });
              await expectNativeQueueDrained(harness, 0);
              await expectNativeWorkflowUnpublished(harness, seenChatBodies);
              await newer.restore();
              await sharedRefresh.restore();
              await older.restore();
              await expectNativeWorkflowRetained(panel, newInput);
              await expectNativeWorkflowUnpublished(harness, seenChatBodies);
            }
          } finally {
            try {
              await closeNativeWorkflowSettings(panel);
            } finally {
              try {
                await newer?.dispose();
              } finally {
                await sharedRefresh.dispose();
              }
            }
          }
        } finally {
          try {
            await closeNativeWorkflowSettings(panel);
          } finally {
            try {
              await older.dispose();
            } finally {
              await expectNativeQueueDrained(harness, effects);
            }
          }
        }
      },
      { gateway: { seenChatBodies } }
    );
  });
}
