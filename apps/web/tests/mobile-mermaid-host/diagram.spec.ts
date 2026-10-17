import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test as base, type Page } from '@playwright/test';

import {
  HOST_PAGE,
  SCRIPT_FILE_NAME,
} from '../../../mobile/src/components/agents/markdown-mermaid-host';

const IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="blue"/></svg>';
const DATA_IMAGE = `data:image/svg+xml;base64,${Buffer.from(IMAGE_SVG).toString('base64')}`;

type HostWindow = typeof window & {
  kiloRenderDiagram: (diagram: { source: string; dark: boolean; background: string }) => void;
  ReactNativeWebView: { postMessage: (message: string) => void };
  diagramMessages: Array<{ kind: string; height?: number }>;
  policyViolations: Array<{ directive: string; blockedURI: string }>;
};

type HostFixture = {
  recorderUrl: string;
  requests: string[];
  resources: string[];
  scriptUrl: string;
};

const test = base.extend<{ host: HostFixture }>({
  host: async ({ page }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'mobile-mermaid-host-'));
    const requests: string[] = [];
    const resources: string[] = [];
    const recorder = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      response.end(IMAGE_SVG);
    });

    try {
      await copyFile(
        resolve(__dirname, '../../../mobile/assets/vendor/mermaid-11.12.0.min.txt'),
        join(directory, SCRIPT_FILE_NAME)
      );
      const pagePath = join(directory, 'diagram.html');
      await writeFile(pagePath, HOST_PAGE);
      await new Promise<void>((resolve, reject) => {
        recorder.once('error', reject);
        recorder.listen(0, '127.0.0.1', resolve);
      });
      const address = recorder.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected a loopback HTTP recorder');
      }
      const recorderUrl = `http://127.0.0.1:${address.port}`;
      const probe = await page.request.get(`${recorderUrl}/ready`);
      expect(probe.ok()).toBe(true);
      expect(requests).toEqual(['/ready']);
      requests.length = 0;

      page.on('request', request => resources.push(request.url()));
      await page.addInitScript(() => {
        const hostWindow = window as HostWindow;
        hostWindow.diagramMessages = [];
        hostWindow.policyViolations = [];
        hostWindow.ReactNativeWebView = {
          postMessage: message => hostWindow.diagramMessages.push(JSON.parse(message)),
        };
        document.addEventListener('securitypolicyviolation', event => {
          hostWindow.policyViolations.push({
            directive: event.effectiveDirective,
            blockedURI: event.blockedURI,
          });
        });
      });
      await page.goto(pathToFileURL(pagePath).href);
      await page.waitForFunction(
        () => typeof (window as HostWindow).kiloRenderDiagram === 'function'
      );
      await use({
        recorderUrl,
        requests,
        resources,
        scriptUrl: pathToFileURL(join(directory, SCRIPT_FILE_NAME)).href,
      });
    } finally {
      await page.close();
      recorder.closeAllConnections();
      if (recorder.listening) {
        await new Promise<void>((resolve, reject) => {
          recorder.close(error => (error ? reject(error) : resolve()));
        });
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
});

async function renderDiagram(page: Page, source: string) {
  await page.evaluate(source => {
    (window as HostWindow).kiloRenderDiagram({ source, dark: false, background: '#ffffff' });
  }, source);
  await page.waitForFunction(() => (window as HostWindow).diagramMessages.length > 0);
}

async function expectRenderedDiagram(page: Page) {
  await expect(page.locator('#d > svg')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as HostWindow).diagramMessages.some(
          message =>
            message.kind === 'height' && typeof message.height === 'number' && message.height > 0
        )
      )
    )
    .toBe(true);
  expect(await page.evaluate(() => (window as HostWindow).diagramMessages)).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'error' })])
  );
  expect(await page.evaluate(() => (window as HostWindow).policyViolations)).toEqual([]);
}

test('renders a flowchart with the bundled script', async ({ page, host }) => {
  await renderDiagram(page, 'flowchart TD\n  A[Start] --> B[Finish]');
  await expectRenderedDiagram(page);
  await expect(page.locator('#d .node')).toHaveCount(2);
  await expect(page.locator('#d')).toContainText('Start');
  await expect(page.locator('#d')).toContainText('Finish');
  expect(host.resources).toContain(host.scriptUrl);
  expect(host.requests).toEqual([]);
});

test('completes an image-shape fixture', async ({ page, host }) => {
  const imageUrl = `${host.recorderUrl}/image.svg`;
  await renderDiagram(
    page,
    `flowchart TD\n  A@{ img: "${imageUrl}", label: "Image", h: 24, w: 24 }`
  );
  await expect
    .poll(() => page.evaluate(() => (window as HostWindow).policyViolations))
    .toContainEqual({
      directive: 'img-src',
      blockedURI: expect.stringContaining(host.recorderUrl),
    });
  expect(host.requests).toEqual([]);
});

test('renders a data image shape', async ({ page, host }) => {
  await renderDiagram(
    page,
    `flowchart TD\n  A@{ img: "${DATA_IMAGE}", label: "Image", h: 24, w: 24 }`
  );
  await expectRenderedDiagram(page);
  const images = page.locator('#d svg image');
  await expect(images).toHaveCount(1);
  expect(
    await images.evaluateAll(elements =>
      elements.map(element => element.getAttribute('href') ?? element.getAttribute('xlink:href'))
    )
  ).toEqual([DATA_IMAGE]);
  expect(host.requests).toEqual([]);
});
