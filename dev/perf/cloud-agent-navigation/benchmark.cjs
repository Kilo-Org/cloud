const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { fixtureSchema, localOrigin, requestPath, summarize } = require('./metrics.cjs');
const webRequire = createRequire(path.resolve(__dirname, '../../../apps/web/package.json'));
const { chromium } = webRequire('@playwright/test');

async function run() {
  const baseUrl = localOrigin(process.env.BASE_URL ?? 'http://localhost:3000');
  if (!process.env.FIXTURES || !process.env.STORAGE_STATE)
    throw new Error('Set FIXTURES and STORAGE_STATE');
  const fixture = fixtureSchema.parse(JSON.parse(await fs.readFile(process.env.FIXTURES, 'utf8')));
  const mode = process.env.MODE ?? 'timing';
  if (!['timing', 'react', 'cpu'].includes(mode))
    throw new Error('MODE must be timing, react, or cpu');
  const rounds = Number(process.env.ROUNDS ?? 4);
  const observeMs = Number(process.env.OBSERVE_MS ?? 2000);
  const idleMs = Number(process.env.IDLE_MS ?? 0);
  if (
    !Number.isInteger(rounds) ||
    rounds < 1 ||
    !Number.isFinite(observeMs) ||
    observeMs < 0 ||
    !Number.isFinite(idleMs) ||
    idleMs < 0
  ) {
    throw new Error('Invalid ROUNDS, OBSERVE_MS, or IDLE_MS');
  }
  const output = path.resolve(process.env.OUT ?? '/tmp/kilo2/cloud-navigation.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: [
      '--no-sandbox',
      ...(process.env.BLOCK_EXTERNAL === '1'
        ? ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost']
        : []),
    ],
  });
  const samples = [];
  try {
    for (let round = 0; round < rounds; round++) {
      // A fresh browser cache each round; switch-back interactions within it are warm.
      const context = await browser.newContext({
        storageState: process.env.STORAGE_STATE,
        viewport: { width: 1440, height: 1000 },
      });
      await context.addInitScript(
        ({ mode, readySelector }) => {
          window.__navigationLongTasks = [];
          window.__navigationCommits = [];
          if (typeof PerformanceObserver !== 'undefined') {
            new PerformanceObserver(list => {
              window.__navigationLongTasks.push(
                ...list
                  .getEntries()
                  .map(entry => ({ start: entry.startTime, duration: entry.duration }))
              );
            }).observe({ type: 'longtask', buffered: true });
          }
          const observer = new MutationObserver(() => {
            if (!document.querySelector(readySelector)) return;
            observer.disconnect();
            requestAnimationFrame(() => {
              window.__navigationFirstContent = performance.now();
            });
          });
          observer.observe(document, { childList: true, subtree: true });
          if (mode !== 'react') return;
          let rendererId = 0;
          window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            supportsFiber: true,
            inject: () => ++rendererId,
            onCommitFiberUnmount() {},
            onPostCommitFiberRoot() {},
            onCommitFiberRoot(_id, root) {
              const rendered = [];
              const start = root.current.actualStartTime;
              function visit(fiber) {
                if (
                  fiber.flags & 1 &&
                  fiber.actualStartTime >= start &&
                  typeof fiber.type !== 'string'
                ) {
                  const type = fiber.type;
                  const name = type?.displayName ?? type?.name ?? type?.render?.name;
                  if (name) rendered.push({ name, actualDuration: fiber.actualDuration });
                }
                if (fiber.child) visit(fiber.child);
                if (fiber.sibling) visit(fiber.sibling);
              }
              visit(root.current);
              window.__navigationCommits.push({
                at: performance.now(),
                actualDuration: root.current.actualDuration,
                rendered,
              });
            },
          };
        },
        { mode, readySelector: fixture.initialReadySelector }
      );
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Performance.enable');
      if (mode === 'cpu') await cdp.send('Profiler.enable');
      let requests = new Map();
      cdp.on('Network.requestWillBeSent', event =>
        requests.set(event.requestId, {
          path: requestPath(event.request.url),
          startedAt: event.timestamp,
          decodedBytes: 0,
          encodedBytes: 0,
        })
      );
      cdp.on('Network.responseReceived', event => {
        const request = requests.get(event.requestId);
        if (!request) return;
        request.firstByteAt = event.timestamp;
        request.status = event.response.status;
      });
      cdp.on('Network.dataReceived', event => {
        const request = requests.get(event.requestId);
        if (request) request.decodedBytes += event.dataLength;
      });
      cdp.on('Network.loadingFinished', event => {
        const request = requests.get(event.requestId);
        if (request) {
          request.endedAt = event.timestamp;
          request.encodedBytes = event.encodedDataLength;
        }
      });
      cdp.on('Network.loadingFailed', event => {
        const request = requests.get(event.requestId);
        if (request) {
          request.failed = true;
          request.endedAt = event.timestamp;
        }
      });

      async function measure(name, budgetMs, action) {
        requests = new Map();
        const pageStartedAt = await page.evaluate(() => {
          window.__navigationLongTasks = [];
          window.__navigationCommits = [];
          return performance.now();
        });
        const clock = await cdp.send('Performance.getMetrics');
        const startedAt = clock.metrics.find(metric => metric.name === 'Timestamp').value;
        if (mode === 'cpu') await cdp.send('Profiler.start');
        const contentMs = await action();
        await page.waitForTimeout(name === 'idle' ? idleMs : observeMs);
        let cpuProfile;
        if (mode === 'cpu') {
          const { profile } = await cdp.send('Profiler.stop');
          for (const node of profile.nodes) node.callFrame.url = requestPath(node.callFrame.url);
          cpuProfile = `${output}.${round}.${name}.cpuprofile`;
          await fs.writeFile(cpuProfile, JSON.stringify(profile), { mode: 0o600 });
        }
        const render = await page.evaluate(
          start => ({
            longTasks: window.__navigationLongTasks
              .filter(task => task.start >= start)
              .map(task => ({ ...task, start: task.start - start })),
            commits: window.__navigationCommits
              .filter(commit => commit.at >= start)
              .map(commit => ({ ...commit, at: commit.at - start })),
          }),
          name === 'page-load' ? 0 : pageStartedAt
        );
        samples.push({
          name,
          round,
          contentMs,
          budgetMs,
          ...render,
          cpuProfile,
          requests: [...requests.values()].map(request => ({
            ...request,
            startedAt: (request.startedAt - startedAt) * 1000,
            firstByteAt:
              request.firstByteAt === undefined
                ? undefined
                : (request.firstByteAt - startedAt) * 1000,
            endedAt:
              request.endedAt === undefined ? undefined : (request.endedAt - startedAt) * 1000,
          })),
        });
      }

      await measure('page-load', 1200, async () => {
        await page.goto(`${baseUrl}${fixture.initialPath}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__navigationFirstContent !== undefined);
        return page.evaluate(() => window.__navigationFirstContent);
      });
      for (const interaction of fixture.interactions) {
        await measure(interaction.name, interaction.budgetMs, () =>
          page.evaluate(
            input =>
              new Promise((resolve, reject) => {
                const target = document.querySelector(input.clickSelector);
                if (!(target instanceof HTMLElement)) {
                  reject(new Error('Click target missing'));
                  return;
                }
                const started = performance.now();
                const timeout = setTimeout(() => {
                  observer.disconnect();
                  reject(new Error('Content deadline exceeded'));
                }, 30000);
                const check = () => {
                  const ready = [...document.querySelectorAll(input.readySelector)].some(
                    element =>
                      element.getClientRects().length > 0 &&
                      (input.readyText === undefined ||
                        element.textContent.includes(input.readyText))
                  );
                  if (!ready) return;
                  observer.disconnect();
                  clearTimeout(timeout);
                  requestAnimationFrame(() => resolve(performance.now() - started));
                };
                const observer = new MutationObserver(check);
                observer.observe(document, {
                  childList: true,
                  subtree: true,
                  characterData: true,
                  attributes: true,
                });
                target.click();
                check();
              }),
            interaction
          )
        );
      }
      if (idleMs > 0) await measure('idle', undefined, async () => 0);
      await context.close();
    }
    const summary = summarize(samples);
    await fs.writeFile(
      output,
      JSON.stringify({ version: 1, mode, rounds, observeMs, idleMs, summary, samples }, null, 2),
      { mode: 0o600 }
    );
    console.table(summary);
    console.log(`Saved ${output}`);
    if (process.env.ENFORCE_BUDGETS === '1' && summary.some(item => item.withinBudget === false))
      process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
