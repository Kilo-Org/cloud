import { expect, test, type Page } from '@playwright/test';
import type { StoredMessage, ToolPart } from '@/components/cloud-agent-next/types';

const sessionId = 'ses_tool_group_scroll';
const created = Date.parse('2026-11-10T12:00:00Z');

function tool(index: number): ToolPart {
  return {
    id: `part-${String(index < 80 ? index + 1 : index + 2).padStart(3, '0')}`,
    messageID: 'assistant-tools',
    sessionID: sessionId,
    type: 'tool',
    callID: `call-${index}`,
    tool: 'bash',
    state: {
      status: 'completed',
      input: { command: `echo "Inspecting file ${index + 1}"` },
      output: `Inspection output for file ${index + 1}\n`.repeat(30),
      title: 'Inspect file',
      metadata: {},
      time: { start: created + index * 1000, end: created + (index + 1) * 1000 },
    },
  };
}

const messages: StoredMessage[] = [
  {
    info: {
      id: 'assistant-tools',
      sessionID: sessionId,
      role: 'assistant',
      parentID: 'user-request',
      time: { created, completed: created + 90_000 },
      modelID: 'test-model',
      providerID: 'test-provider',
      mode: 'code',
      agent: 'code',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: 'part-000',
        messageID: 'assistant-tools',
        sessionID: sessionId,
        type: 'text',
        text: 'I will inspect the files before summarizing the results.',
      },
      ...Array.from({ length: 80 }, (_, index) => tool(index)),
      {
        id: 'part-081',
        messageID: 'assistant-tools',
        sessionID: sessionId,
        type: 'text',
        text: 'All 80 files have been inspected. The conversation stays readable.',
      },
      tool(80),
      tool(81),
      {
        id: 'part-084',
        messageID: 'assistant-tools',
        sessionID: sessionId,
        type: 'text',
        text: 'The final two checks passed too.',
      },
    ],
  },
];

async function mountTranscript(page: Page) {
  await page.addInitScript(() => localStorage.setItem('cloud-agent:collapse-tools', 'true'));
  const session = {
    session_id: sessionId,
    cloud_agent_session_id: null,
    title: 'Grouped tool call scrolling',
    organization_id: null,
    created_on_platform: 'cloud-agent-web',
    created_at: new Date(created).toISOString(),
    updated_at: new Date(created).toISOString(),
    version: 2,
    git_url: 'https://github.com/example/tool-group-scrolling.git',
    git_branch: 'fix/grouped-tool-scrolling',
    parent_session_id: null,
    status: 'idle',
    status_updated_at: new Date(created).toISOString(),
    total_cost_microdollars: 0,
    associatedPr: null,
    runtimeState: null,
  };
  await page.routeWebSocket('**/api/user/web', () => {});
  await page.route('**/api/trpc/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const procedures = url.pathname.split('/api/trpc/')[1].split(',');
    const batch = url.searchParams.get('batch') === '1';
    const input =
      request.method() === 'GET'
        ? JSON.parse(url.searchParams.get('input') ?? '{}')
        : request.postDataJSON();
    const results = await Promise.all(
      procedures.map(async (procedure, index) => {
        let data: unknown;
        switch (procedure) {
          case 'cliSessionsV2.list':
          case 'cliSessionsV2.search':
            data = { cliSessions: [session], total: 1 };
            break;
          case 'cliSessionsV2.get':
          case 'cliSessionsV2.getWithRuntimeState':
            data = session;
            break;
          case 'cliSessionsV2.getSessionMessagesPage':
            data = {
              kiloSessionId: sessionId,
              history: { messages, nextCursor: null, omittedItemCount: 0 },
            };
            break;
          case 'cliSessionsV2.getSessionMessages':
            data = { info: { id: sessionId }, messages };
            break;
          case 'cliSessionsV2.recentRepositories':
            data = { repositories: [] };
            break;
          case 'activeSessions.list':
            data = { sessions: [] };
            break;
          case 'activeSessions.createWebTicket':
            data = { token: 'controlled-web-ticket' };
            break;
          case 'kiloPass.getSidebarPromoEligibility':
            data = { showPromoBanner: false };
            break;
          default: {
            const args = (batch ? input?.[index] : input) ?? {};
            const upstream = new URL(`/api/trpc/${procedure}`, url.origin);
            if (request.method() === 'GET')
              upstream.searchParams.set('input', JSON.stringify(args));
            try {
              const response = await route.fetch({
                url: upstream.toString(),
                ...(request.method() === 'POST' ? { postData: JSON.stringify(args) } : {}),
              });
              return response.json();
            } catch {
              throw new Error(`Fixture prerequisite failed: ${procedure}`);
            }
          }
        }
        return { result: { data } };
      })
    );
    await route.fulfill({ json: batch ? results : results[0] });
  });
  await page.goto(`/cloud/chat?sessionId=${sessionId}`);
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 768, height: 1024 },
  { width: 375, height: 667 },
]) {
  test(`expanded tool groups scroll without growing the chat at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await mountTranscript(page);
    const group = page.getByRole('button', { name: /80 tool calls/ });
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-tool-card]')).toHaveCount(0);
    await group.click();
    const contentId = await group.getAttribute('aria-controls');
    if (!contentId) throw new Error('Missing tool group content ID');
    const content = page.locator(`[id="${contentId}"]`);
    await expect(content).toBeVisible();
    await expect(content.locator('[data-tool-card]')).toHaveCount(80);
    await page.screenshot({ path: testInfo.outputPath('expanded.png') });
    await testInfo.attach('expanded tool group', {
      path: testInfo.outputPath('expanded.png'),
      contentType: 'image/png',
    });

    const dimensions = await content.evaluate(element => ({
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    await testInfo.attach('group dimensions', {
      body: JSON.stringify(dimensions),
      contentType: 'application/json',
    });
    expect(dimensions.height).toBeLessThanOrEqual(Math.min(384, viewport.height / 2) + 1);
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
    await expect(content).toHaveCSS('overflow-y', 'auto');
    await expect(content).toHaveCSS('overscroll-behavior-y', 'contain');

    await content.focus();
    await page.keyboard.press('PageDown');
    await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await content.evaluate(element => (element.scrollTop = element.scrollHeight));
    await expect(content.getByText('echo "Inspecting file 80"', { exact: true })).toBeInViewport();
    await content.locator('[data-tool-card] button').last().click();
    await expect(content.getByText(/Inspection output for file 80/)).toBeVisible();
    expect(await content.evaluate(element => element.getBoundingClientRect().height)).toBe(
      dimensions.height
    );

    await content.evaluate(element => (element.scrollTop = element.scrollHeight));
    const answer = page.getByText('All 80 files have been inspected.', { exact: false });
    await content.hover();
    const answerTop = await answer.evaluate(element => element.getBoundingClientRect().top);
    await page.mouse.wheel(0, 2000);
    await page.evaluate(
      () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await expect
      .poll(() => answer.evaluate(element => element.getBoundingClientRect().top))
      .toBe(answerTop);
    await page.screenshot({ path: testInfo.outputPath('scrolled.png') });
    await testInfo.attach('scrolled tool group', {
      path: testInfo.outputPath('scrolled.png'),
      contentType: 'image/png',
    });

    await group.click();
    await expect(content).toBeHidden();
    await expect(answer).toBeVisible();
    await group.click();
    await expect(content).toBeVisible();
    await expect(content.locator('[data-tool-card]')).toHaveCount(80);
    await group.click();
    const shortGroup = page.getByRole('button', { name: /2 tool calls/ });
    await shortGroup.click();
    const shortContent = page.getByRole('region', { name: /2 tool calls/ });
    expect(
      await shortContent.evaluate(element => element.getBoundingClientRect().height)
    ).toBeLessThan(160);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width
    );
  });
}
