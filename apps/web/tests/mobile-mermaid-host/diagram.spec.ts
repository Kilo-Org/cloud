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
import { DARK_PIE_FILLS } from '../../../mobile/src/components/agents/mermaid-pie-fills';

const IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="blue"/></svg>';
const DATA_IMAGE = `data:image/svg+xml;base64,${Buffer.from(IMAGE_SVG).toString('base64')}`;

type HostWindow = typeof window & {
  kiloRenderDiagram: (diagram: {
    source: string;
    dark: boolean;
    background: string;
    themeVariables?: Record<string, string>;
  }) => void;
  ReactNativeWebView: { postMessage: (message: string) => void };
  diagramMessages: Array<{ kind: string; height?: number; source?: string }>;
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

test('redraws a loaded page instead of loading another one', async ({ page, host }) => {
  // The app keeps one page per diagram and pushes a color change or a new source
  // into it, so the vendored script is read once; a second page would be a
  // second copy of it.
  await renderDiagram(page, 'flowchart TD\n  A[Start] --> B[Finish]');
  await expectRenderedDiagram(page);
  const reportedBefore = await page.evaluate(() => (window as HostWindow).diagramMessages.length);

  const source = 'flowchart LR\n  C[Left] --> D[Right]';
  await page.evaluate(source => {
    (window as HostWindow).kiloRenderDiagram({ source, dark: true, background: '#111111' });
  }, source);

  // One diagram in the host, not the previous one beside it.
  await expect(page.locator('#d > svg')).toHaveCount(1);
  await expect(page.locator('#d')).toContainText('Left');
  await expect(page.locator('#d')).not.toContainText('Start');
  // The new report names the source it belongs to, so the app can ignore a
  // report from a diagram it already replaced.
  await expect
    .poll(() =>
      page.evaluate(
        ([from, wanted]) =>
          (window as HostWindow).diagramMessages
            .slice(from as number)
            .some(message => message.kind === 'height' && message.source === wanted),
        [reportedBefore, source] as const
      )
    )
    .toBe(true);
  expect(await page.evaluate(() => (window as HostWindow).policyViolations)).toEqual([]);
  expect(host.resources.filter(url => url === host.scriptUrl)).toHaveLength(1);
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

test('renders an HTML label fixture', async ({ page, host }) => {
  const imageUrl = `${host.recorderUrl}/label.svg`;
  await renderDiagram(page, `flowchart TD\n  A["<img src='${imageUrl}' width='24' height='24'>"]`);
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

// The page applies `themeVariables` to `mermaid.initialize`, which is the branch
// that makes a pie slice visible: without it Mermaid's dark theme paints the
// first slice and its legend swatch near the page colour. This case renders the
// real page and reads the fills back, so a map passed under the wrong key, or a
// ramp whose first two fills the page no longer receives, fails here instead of
// regressing silently.
test('applies the dark pie theme to the rendered slices and legend', async ({ page, host }) => {
  // The two fills the page must paint, plus full opacity: mermaid blends every
  // fill toward the page at its own 0.7 default, so the readback would not equal
  // the ramp's own values. The ramp and the rest of the map are owned by
  // `mermaid-pie-theme.test.ts`.
  const variables = {
    pie1: DARK_PIE_FILLS[0],
    pie2: DARK_PIE_FILLS[1],
    pieOpacity: '1',
  };
  await page.evaluate(themeVariables => {
    (window as HostWindow).kiloRenderDiagram({
      source: 'pie title Status\n  "Working" : 3\n  "Idle" : 5',
      dark: true,
      background: '#0E0E10',
      themeVariables,
    });
  }, variables);
  await expectRenderedDiagram(page);

  // Slices paint in descending value, so "Idle" (5) takes pie1 and "Working" (3)
  // takes pie2. The legend keeps the diagram's own order, so a swatch is matched
  // to its slice by label, not by index. The renderer writes the swatch as a
  // style, which the browser normalises to `rgb(...)`, so both reads are
  // compared as colours rather than as strings.
  const readback = await page.evaluate(() => {
    const toHex = (value: string) => {
      const probe = document.createElement('span');
      probe.style.color = value;
      document.body.append(probe);
      const computed = getComputedStyle(probe).color;
      probe.remove();
      const parts = /(\d+)\D+(\d+)\D+(\d+)/.exec(computed);
      return parts === null
        ? computed
        : `#${[parts[1], parts[2], parts[3]]
            .map(channel => Number(channel).toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase()}`;
    };
    return {
      sliceFills: [...document.querySelectorAll('#d path.pieCircle')].map(slice =>
        toHex(slice.getAttribute('fill') ?? '')
      ),
      swatches: [...document.querySelectorAll('#d g.legend')].map(entry => ({
        label: entry.querySelector('text')?.textContent ?? '',
        fill: toHex((entry.querySelector('rect') as SVGElement | null)?.style.fill ?? ''),
      })),
    };
  });

  expect(readback.sliceFills).toEqual([variables.pie1, variables.pie2]);
  expect(readback.swatches).toEqual([
    { label: 'Working', fill: variables.pie2 },
    { label: 'Idle', fill: variables.pie1 },
  ]);
  expect(host.requests).toEqual([]);
});

// The document policy, not one renderer code path, is the page's network
// boundary: a request the page starts itself must be refused and reported.
test('keeps page subresources off the network', async ({ page, host }) => {
  await renderDiagram(page, 'flowchart TD\n  A[Start] --> B[Finish]');
  await expectRenderedDiagram(page);
  const fetchRefused = await page.evaluate(async recorderUrl => {
    let refused = false;
    try {
      await fetch(`${recorderUrl}/probe`);
    } catch {
      refused = true;
    }
    const image = new Image();
    const settled = Promise.withResolvers<void>();
    image.addEventListener('load', () => settled.resolve(), { once: true });
    image.addEventListener('error', () => settled.resolve(), { once: true });
    image.src = `${recorderUrl}/probe.svg`;
    await settled.promise;
    return refused;
  }, host.recorderUrl);
  expect(fetchRefused).toBe(true);
  // The page reports each refusal as an asynchronous event, so wait for both.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as HostWindow).policyViolations
          .map(({ directive, blockedURI }) => `${directive} ${blockedURI}`)
          .sort()
      )
    )
    .toEqual([`connect-src ${host.recorderUrl}/probe`, `img-src ${host.recorderUrl}/probe.svg`]);
  expect(host.requests).toEqual([]);
});
