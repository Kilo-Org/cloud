import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  compareProof,
  prepareProof,
  ProofManifestSchema,
  readPreparation,
  sourceMarker,
  targetReadiness,
  validatePreparedSource,
  verifyRuntimeSource,
  writeCaptureReceipt,
  type Preparation,
  type Revision,
} from './baseline';
import type { RunOutcome } from './capture';
import type { Finding } from './findings';
import type { ProbeDump } from './tree';

const PRODUCT = 'apps/mobile/src/components/card.tsx';
const INTENT = 'apps/mobile/src/app/+native-intent.tsx';
const TARGET = {
  id: 'card',
  link: 'kiloapp:///design-proof-card',
  route: '/design-proof-card',
  screen: '(auth)/design-proof-card',
  readyTestID: 'card-ready',
  diagnostic: { component: PRODUCT, exportName: 'default', props: { title: 'Diagnostic data' } },
};
const manifest = ProofManifestSchema.parse({ version: 1, targets: [TARGET] });

function syntheticRepo(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-proof-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init');
  git('config', 'user.email', 'synthetic@example.invalid');
  git('config', 'user.name', 'Synthetic design proof');
  for (const [file, content] of [
    [
      INTENT,
      'export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {\n  return initial ? path : null;\n}\n',
    ],
    [PRODUCT, 'export default function Card() { return "base product"; }\n'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  }
  git('add', '.');
  git('commit', '-m', 'base product');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(
    path.join(repo, PRODUCT),
    'export default function Card() { return "head product"; }\n'
  );
  git('add', '.');
  git('commit', '-m', 'head product');
  const head = git('rev-parse', 'HEAD');
  const targets = path.join(root, 'targets.json');
  fs.writeFileSync(targets, JSON.stringify(manifest));
  const out = path.join(root, 'prepared');
  return { root, repo, git, base, head, targets, out };
}

test('real git preparation keeps true base/head product and generates identical diagnostic plumbing', async t => {
  const fixture = syntheticRepo(t);
  const originalIntent = fs.readFileSync(path.join(fixture.repo, INTENT), 'utf8');
  const env = path.join(fixture.repo, '.env.local');
  fs.writeFileSync(env, 'SYNTHETIC_DO_NOT_COPY=preserved\n');
  const preparation = await prepareProof(fixture);
  assert.match(
    fs.readFileSync(path.join(preparation.base.directory, PRODUCT), 'utf8'),
    /base product/
  );
  assert.match(
    fs.readFileSync(path.join(preparation.head.directory, PRODUCT), 'utf8'),
    /head product/
  );
  const route = 'apps/mobile/src/app/(auth)/design-proof-card.tsx';
  assert.equal(
    fs.readFileSync(path.join(preparation.base.directory, route), 'utf8'),
    fs.readFileSync(path.join(preparation.head.directory, route), 'utf8')
  );
  assert.match(
    fs.readFileSync(path.join(preparation.base.directory, route), 'utf8'),
    /if \(!__DEV__\) return React.createElement\(Redirect, \{ href: '\/\(auth\)\/login' \}\)/
  );
  assert.match(
    fs.readFileSync(path.join(preparation.base.directory, INTENT), 'utf8'),
    new RegExp(sourceMarker(preparation, 'base'))
  );
  assert.match(
    fs.readFileSync(path.join(preparation.base.directory, INTENT), 'utf8'),
    /return "\/\(auth\)\/design-proof-card"/
  );
  assert.equal(fs.existsSync(path.join(preparation.base.directory, '.env.local')), false);
  assert.equal(fs.readFileSync(env, 'utf8'), 'SYNTHETIC_DO_NOT_COPY=preserved\n');
  assert.equal(fs.readFileSync(path.join(fixture.repo, INTENT), 'utf8'), originalIntent);
  assert.equal(fixture.git('rev-parse', 'HEAD'), fixture.head);
  assert.deepEqual(readPreparation(path.join(fixture.out, 'preparation.json')), preparation);
  validatePreparedSource(preparation, 'base', preparation.base.directory);
  validatePreparedSource(preparation, 'head', preparation.head.directory);
  await assert.rejects(() => prepareProof(fixture), /EEXIST/);
});

test('preparation rejects symbolic refs, unrelated histories and unsafe executable-source manifests', async t => {
  const fixture = syntheticRepo(t);
  await assert.rejects(() => prepareProof({ ...fixture, base: 'HEAD~1' }));
  assert.equal(fs.existsSync(fixture.out), false);
  await assert.rejects(() => prepareProof({ ...fixture, base: fixture.head, head: fixture.base }));
  for (const component of [
    '../card.tsx',
    'apps/mobile/src/app/_layout.tsx',
    'apps/mobile/src/components/../auth.tsx',
  ]) {
    assert.equal(
      ProofManifestSchema.safeParse({
        version: 1,
        targets: [{ ...TARGET, diagnostic: { component } }],
      }).success,
      false
    );
  }
  assert.equal(
    ProofManifestSchema.safeParse({ version: 1, targets: [{ ...TARGET, copy: PRODUCT }] }).success,
    false
  );
  assert.equal(
    ProofManifestSchema.safeParse({
      version: 1,
      targets: [{ ...TARGET, link: 'https://production.example/card' }],
    }).success,
    false
  );
  assert.equal(
    ProofManifestSchema.safeParse({ version: 1, targets: [TARGET, TARGET] }).success,
    false
  );
  assert.equal(
    ProofManifestSchema.safeParse({ version: 1, targets: [{ ...TARGET, screen: '/login' }] })
      .success,
    false
  );
});

test('diagnostic prerequisite must exist on base, never copied from head', async t => {
  const fixture = syntheticRepo(t);
  const component = 'apps/mobile/src/components/head-only.tsx';
  fs.writeFileSync(
    path.join(fixture.repo, component),
    'export default function HeadOnly() { return null; }'
  );
  fixture.git('add', '.');
  fixture.git('commit', '-m', 'new head only product');
  fs.writeFileSync(
    fixture.targets,
    JSON.stringify({ version: 1, targets: [{ ...TARGET, diagnostic: { component } }] })
  );
  await assert.rejects(
    () => prepareProof({ ...fixture, head: fixture.git('rev-parse', 'HEAD') }),
    /Missing regular source file/
  );
  assert.equal(fs.existsSync(fixture.out), false);
});

test('prepared run rejects changed product, changed fixtures and unrelated files', async t => {
  const fixture = syntheticRepo(t);
  const preparation = await prepareProof(fixture);
  const base = preparation.base.directory;
  const product = path.join(base, PRODUCT);
  const original = fs.readFileSync(product, 'utf8');
  fs.writeFileSync(product, 'head product copied over base');
  assert.throws(
    () => validatePreparedSource(preparation, 'base', base),
    /Unrelated product source/
  );
  fs.writeFileSync(product, original);
  const fixtureFile = path.join(base, 'apps/mobile/src/app/(auth)/design-proof-card.tsx');
  const generated = fs.readFileSync(fixtureFile, 'utf8');
  fs.writeFileSync(fixtureFile, `${generated}\n// tampered\n`);
  assert.throws(
    () => validatePreparedSource(preparation, 'base', base),
    /diagnostic source changed/
  );
  fs.writeFileSync(fixtureFile, generated);
  fs.writeFileSync(
    path.join(base, 'apps/mobile/src/components/unrelated.tsx'),
    'export default null;'
  );
  assert.throws(
    () => validatePreparedSource(preparation, 'base', base),
    /Unrelated product source/
  );
  assert.throws(
    () => validatePreparedSource(preparation, 'base', preparation.head.directory),
    /Run from prepared base/
  );
});

function capture(
  preparation: Preparation,
  revision: Revision,
  dir: string,
  options: {
    route?: string;
    screen?: string;
    ready?: boolean;
    findings?: (Finding & { count?: number })[];
    width?: number;
    nodes?: ProbeDump['nodes'];
  } = {}
) {
  fs.mkdirSync(dir);
  const dump: ProbeDump = {
    version: 1,
    env: {
      platform: 'android',
      osVersion: '36',
      route: options.route ?? TARGET.route,
      screen: options.screen ?? TARGET.screen,
      window: { width: options.width ?? 400, height: 800 },
      pixelRatio: 1,
      fontScale: 1,
      colorScheme: 'light',
      isRTL: false,
      language: 'en',
      languagePreference: 'en',
      safeArea: { top: 0, left: 0, right: 0, bottom: 0 },
      tapTarget: { min: 48, touch: 48 },
    },
    nodes: options.nodes ?? [
      {
        parent: -1,
        tag: 'View',
        rect: [0, 0, 400, 800],
        testID: options.ready === false ? undefined : TARGET.readyTestID,
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'screen.json'), JSON.stringify(dump));
  // Deliberately synthetic bytes: these tests exercise receipt binding, not visual claims.
  fs.writeFileSync(path.join(dir, 'screen.png'), 'synthetic-image');
  const outcome: RunOutcome = {
    cells: [
      {
        id: 'base',
        config: { id: 'base', dark: false, rtl: false, compact: false, landscape: false },
        screens: [
          {
            target: TARGET.id,
            link: TARGET.link,
            dump: 'screen.json',
            screenshot: 'screen.png',
            annotated: 'annotated.png',
            env: dump.env,
          },
        ],
      },
    ],
    findings: options.findings ?? [],
  };
  // Same omission of per-screen env as writeArtifacts.
  fs.writeFileSync(
    path.join(dir, 'findings.json'),
    JSON.stringify({
      ...outcome,
      cells: outcome.cells.map(cell => ({
        ...cell,
        screens: cell.screens.map(({ env: _env, ...screen }) => screen),
      })),
    })
  );
  writeCaptureReceipt(preparation, revision, outcome, dir);
  return outcome;
}

const error: Finding = {
  rule: 'clipped',
  severity: 'error',
  cell: 'base',
  target: TARGET.id,
  element: { index: 0, path: 'Card/Text', tag: 'Text', rect: [0, 0, 10, 10] },
  measured: 10,
  expected: '0',
  unit: 'dp',
  message: 'Synthetic clipped text',
};

test('actual compare operation attributes only ready same-screen exact-source captures', async t => {
  const fixture = syntheticRepo(t);
  const preparation = await prepareProof(fixture);
  const baseRun = path.join(fixture.root, 'base-run');
  const headRun = path.join(fixture.root, 'head-run');
  capture(preparation, 'base', baseRun);
  capture(preparation, 'head', headRun, { findings: [error] });
  const result = await compareProof(
    preparation,
    baseRun,
    headRun,
    path.join(fixture.root, 'comparison')
  );
  assert.equal(result.status, 'comparable');
  assert.equal(result.introduced.length, 1);
  assert.deepEqual(result.reasons, []);
});

test('pre-existing findings are not attributed to head', async t => {
  const fixture = syntheticRepo(t);
  const preparation = await prepareProof(fixture);
  const baseRun = path.join(fixture.root, 'base-run');
  const headRun = path.join(fixture.root, 'head-run');
  capture(preparation, 'base', baseRun, { findings: [error] });
  capture(preparation, 'head', headRun, { findings: [error] });
  assert.equal(
    (await compareProof(preparation, baseRun, headRun, path.join(fixture.root, 'comparison')))
      .introduced.length,
    0
  );
});

for (const state of [
  { route: '/login' },
  { route: '/splash' },
  { screen: '/unopened' },
  { ready: false },
  {
    findings: [
      {
        ...error,
        rule: 'env-mismatch' as const,
        severity: 'warning' as const,
        message: 'deep link did not open',
      },
    ],
  },
  { findings: [{ ...error, rule: 'capture-alignment' as const, severity: 'warning' as const }] },
]) {
  test(`unready base ${JSON.stringify(state)} is inconclusive, never introduced`, async t => {
    const fixture = syntheticRepo(t);
    const preparation = await prepareProof(fixture);
    const baseRun = path.join(fixture.root, 'base-run');
    const headRun = path.join(fixture.root, 'head-run');
    capture(preparation, 'base', baseRun, state);
    capture(preparation, 'head', headRun, { findings: [error] });
    const result = await compareProof(
      preparation,
      baseRun,
      headRun,
      path.join(fixture.root, 'comparison')
    );
    assert.equal(result.status, 'inconclusive');
    assert.deepEqual(result.introduced, []);
    assert.match(result.reasons.join(' '), /base:/);
  });
}

test('comparison rejects changed capture bytes and swapped provenance', async t => {
  const fixture = syntheticRepo(t);
  const preparation = await prepareProof(fixture);
  const baseRun = path.join(fixture.root, 'base-run');
  const headRun = path.join(fixture.root, 'head-run');
  capture(preparation, 'base', baseRun);
  capture(preparation, 'head', headRun);
  await assert.rejects(
    () => compareProof(preparation, headRun, baseRun, path.join(fixture.root, 'comparison')),
    /Unbound base/
  );
  fs.appendFileSync(path.join(baseRun, 'screen.json'), ' ');
  await assert.rejects(
    () => compareProof(preparation, baseRun, headRun, path.join(fixture.root, 'comparison')),
    /Changed base capture artifact/
  );
});

test('matching screen with different device geometry cannot exonerate head', async t => {
  const fixture = syntheticRepo(t);
  const preparation = await prepareProof(fixture);
  const baseRun = path.join(fixture.root, 'base-run');
  const headRun = path.join(fixture.root, 'head-run');
  capture(preparation, 'base', baseRun);
  capture(preparation, 'head', headRun, { width: 600, findings: [error] });
  const result = await compareProof(
    preparation,
    baseRun,
    headRun,
    path.join(fixture.root, 'comparison')
  );
  assert.equal(result.status, 'inconclusive');
  assert.deepEqual(result.introduced, []);
  assert.match(result.reasons.join(' '), /device environments differ/);
});

test('empty/missing screen coverage and escaped dump paths fail closed', async t => {
  const fixture = syntheticRepo(t);
  const preparation = await prepareProof(fixture);
  assert.deepEqual(targetReadiness({ cells: [], findings: [] }, manifest, fixture.root), [
    'No matrix cells captured',
  ]);
  assert.match(
    targetReadiness(
      { cells: [{ id: 'base', screens: [] }], findings: [] },
      manifest,
      fixture.root
    ).join(' '),
    /missing screen/
  );
  const baseRun = path.join(fixture.root, 'base-run');
  const outcome = capture(preparation, 'base', baseRun);
  outcome.cells[0].screens[0].dump = '../targets.json';
  assert.throws(() => targetReadiness(outcome, manifest, baseRun), /escapes/);
});

test('manifest screen identity uses the raw segments.join producer key, not a route path', () => {
  const screen = ['(app)', '(tabs)', 'profile'].join('/');
  const parsed = ProofManifestSchema.parse({
    version: 1,
    targets: [
      {
        id: 'profile',
        link: 'kiloapp:///profile',
        route: '/profile',
        screen,
        readyTestID: 'profile-ready',
      },
    ],
  });
  assert.equal(parsed.targets[0].screen, '(app)/(tabs)/profile');
  assert.equal(manifest.targets[0].screen, ['(auth)', 'design-proof-card'].join('/'));
  assert.equal(
    ProofManifestSchema.safeParse({
      version: 1,
      targets: [{ ...TARGET, screen: '/design-proof-card' }],
    }).success,
    false
  );
});

test('readiness rejects markers hidden by ancestors, clipping or an unfocused native screen', async t => {
  const fixture = syntheticRepo(t);
  const preparation = await prepareProof(fixture);
  const headRun = path.join(fixture.root, 'visible-head');
  capture(preparation, 'head', headRun, { findings: [error] });
  const variants: { name: string; nodes: ProbeDump['nodes'] }[] = [
    {
      name: 'ancestor-opacity',
      nodes: [
        { parent: -1, tag: 'View', rect: [0, 0, 400, 800], style: { opacity: 0 } },
        { parent: 0, tag: 'View', rect: [10, 10, 50, 50], testID: TARGET.readyTestID },
      ],
    },
    {
      name: 'ancestor-display',
      nodes: [
        { parent: -1, tag: 'View', rect: [0, 0, 400, 800], style: { display: 'none' } },
        { parent: 0, tag: 'View', rect: [10, 10, 50, 50], testID: TARGET.readyTestID },
      ],
    },
    {
      name: 'ancestor-clip',
      nodes: [
        { parent: -1, tag: 'View', rect: [0, 0, 400, 800] },
        { parent: 0, tag: 'View', rect: [0, 0, 20, 20], style: { overflow: 'hidden' } },
        { parent: 1, tag: 'View', rect: [50, 50, 50, 50], testID: TARGET.readyTestID },
      ],
    },
    {
      name: 'inactive-screen',
      nodes: [
        { parent: -1, tag: 'View', rect: [0, 0, 400, 800] },
        { parent: 0, tag: 'RNSScreen', rect: [0, 0, 400, 800], screenState: 0 },
        { parent: 1, tag: 'View', rect: [10, 10, 50, 50], testID: TARGET.readyTestID },
      ],
    },
    {
      name: 'covered-screen',
      nodes: [
        { parent: -1, tag: 'RNSScreenStack', rect: [0, 0, 400, 800] },
        { parent: 0, tag: 'RNSScreen', rect: [0, 0, 400, 800], screenState: 2 },
        { parent: 1, tag: 'View', rect: [10, 10, 50, 50], testID: TARGET.readyTestID },
        { parent: 0, tag: 'RNSScreen', rect: [0, 0, 400, 800], screenState: 2 },
      ],
    },
  ];
  for (const variant of variants) {
    const baseRun = path.join(fixture.root, variant.name);
    const outcome = capture(preparation, 'base', baseRun, { nodes: variant.nodes });
    assert.match(
      targetReadiness(outcome, manifest, baseRun).join(' '),
      /target not ready/,
      variant.name
    );
    const compared = await compareProof(
      preparation,
      baseRun,
      headRun,
      path.join(fixture.root, `${variant.name}-comparison`)
    );
    assert.equal(compared.status, 'inconclusive', variant.name);
    assert.deepEqual(compared.introduced, [], variant.name);
  }
});

for (const failedFile of [
  'base/apps/mobile/src/app/(auth)/design-proof-card.tsx',
  'head/apps/mobile/src/app/(auth)/design-proof-card.tsx',
  'preparation.json',
]) {
  test(`preparation rolls back owned worktrees/output after failed write: ${failedFile}`, async t => {
    const fixture = syntheticRepo(t);
    const registeredBefore = fixture.git('worktree', 'list', '--porcelain');
    const originalWrite = fs.promises.writeFile;
    const failure = t.mock.method(
      fs.promises,
      'writeFile',
      async (...args: Parameters<typeof fs.promises.writeFile>) => {
        if (String(args[0]).endsWith(failedFile))
          throw new Error('Injected preparation write failure');
        return originalWrite(...args);
      }
    );
    await assert.rejects(() => prepareProof(fixture), /Injected preparation write failure/);
    failure.mock.restore();
    assert.equal(fs.existsSync(fixture.out), false);
    assert.equal(fixture.git('worktree', 'list', '--porcelain'), registeredBefore);
    const retried = await prepareProof(fixture);
    validatePreparedSource(retried, 'base', retried.base.directory);
    validatePreparedSource(retried, 'head', retried.head.directory);
    const receipt = fs.readFileSync(path.join(fixture.out, 'preparation.json'), 'utf8');
    await assert.rejects(() => prepareProof(fixture), /EEXIST/);
    assert.equal(
      fs.readFileSync(path.join(fixture.out, 'preparation.json'), 'utf8'),
      receipt,
      'preexisting output is never rolled back'
    );
  });
}

test('second-worktree checkout failure rolls back only newly owned output and supports retry', async t => {
  const fixture = syntheticRepo(t);
  fixture.git('config', 'core.hooksPath', path.join(fixture.repo, '.git/hooks'));
  const registeredBefore = fixture.git('worktree', 'list', '--porcelain');
  const hook = path.join(fixture.repo, '.git/hooks/post-checkout');
  // The first checkout deliberately blocks the next destination with owned diagnostic bytes.
  const headDestination = path.join(fixture.out, 'head');
  fs.writeFileSync(
    hook,
    `#!/bin/sh\nmkdir -p '${headDestination}'\nprintf 'synthetic failure' > '${headDestination}/checkout-blocker'\n`
  );
  fs.chmodSync(hook, 0o755);
  const sentinel = path.join(fixture.repo, '.env.local');
  fs.writeFileSync(sentinel, 'PRESERVE_EXISTING_RUNTIME=1\n');
  await assert.rejects(() => prepareProof(fixture));
  assert.equal(fs.existsSync(fixture.out), false);
  assert.equal(fixture.git('worktree', 'list', '--porcelain'), registeredBefore);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'PRESERVE_EXISTING_RUNTIME=1\n');
  fs.unlinkSync(hook);
  const retried = await prepareProof(fixture);
  validatePreparedSource(retried, 'base', retried.base.directory);
});

test('comparison reuses report sibling normalization and sums raw and collapsed group counts', async t => {
  const fixture = syntheticRepo(t);
  const preparation = await prepareProof(fixture);
  const variants: {
    name: string;
    base: (Finding & { count?: number })[];
    head: (Finding & { count?: number })[];
    introducedCount: number;
  }[] = [
    {
      name: 'moved-sibling',
      introducedCount: 0,
      base: [{ ...error, element: { ...error.element, path: 'Card/Text[2]' }, count: 3 }],
      head: [{ ...error, element: { ...error.element, path: 'Card/Text[9]' }, count: 3 }],
    },
    {
      name: 'same-total-mixed-collapsed-and-raw',
      introducedCount: 0,
      base: [{ ...error, element: { ...error.element, path: 'Card/Text[2]' }, count: 3 }],
      head: [
        { ...error, element: { ...error.element, path: 'Card/Text[7]' }, count: 2 },
        { ...error, element: { ...error.element, path: 'Card/Text[8]' } },
      ],
    },
    {
      name: 'increased-total',
      introducedCount: 4,
      base: [{ ...error, element: { ...error.element, path: 'Card/Text[2]' }, count: 2 }],
      head: [
        { ...error, element: { ...error.element, path: 'Card/Text[7]' }, count: 2 },
        { ...error, element: { ...error.element, path: 'Card/Text[8]' }, count: 2 },
      ],
    },
    {
      name: 'warning-to-error',
      introducedCount: 1,
      base: [{ ...error, severity: 'warning', count: 2 }],
      head: [error],
    },
  ];
  for (const variant of variants) {
    const baseRun = path.join(fixture.root, `${variant.name}-base`);
    const headRun = path.join(fixture.root, `${variant.name}-head`);
    capture(preparation, 'base', baseRun, { findings: variant.base });
    capture(preparation, 'head', headRun, { findings: variant.head });
    const result = await compareProof(
      preparation,
      baseRun,
      headRun,
      path.join(fixture.root, `${variant.name}-result`)
    );
    assert.equal(result.status, 'comparable', variant.name);
    assert.equal(
      result.introduced.reduce((sum, finding) => sum + finding.count, 0),
      variant.introducedCount,
      variant.name
    );
    if (variant.name === 'increased-total')
      assert.equal(result.introduced[0].element.path, 'Card/Text[7]');
  }
});

test('comparison rejects invalid collapsed counts at the input boundary', async t => {
  const fixture = syntheticRepo(t);
  const preparation = await prepareProof(fixture);
  const baseRun = path.join(fixture.root, 'base-run');
  capture(preparation, 'base', baseRun);
  for (const [index, count] of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].entries()) {
    const headRun = path.join(fixture.root, `head-run-${index}`);
    capture(preparation, 'head', headRun, { findings: [{ ...error, count }] });
    const out = path.join(fixture.root, `invalid-count-${index}`);
    await assert.rejects(() => compareProof(preparation, baseRun, headRun, out));
    assert.equal(fs.existsSync(out), false, 'failed validation cannot leave a successful result');
  }
});

test('comparison refuses reused output without overwriting or presenting prior evidence as new', async t => {
  const fixture = syntheticRepo(t);
  const preparation = await prepareProof(fixture);
  const baseRun = path.join(fixture.root, 'base-run');
  const headRun = path.join(fixture.root, 'head-run');
  capture(preparation, 'base', baseRun);
  capture(preparation, 'head', headRun);
  const out = path.join(fixture.root, 'comparison');
  await compareProof(preparation, baseRun, headRun, out);
  const original = fs.readFileSync(path.join(out, 'comparison.json'), 'utf8');
  fs.appendFileSync(path.join(baseRun, 'screen.json'), ' ');
  await assert.rejects(
    () => compareProof(preparation, baseRun, headRun, out),
    /output must be a new directory/
  );
  assert.equal(fs.readFileSync(path.join(out, 'comparison.json'), 'utf8'), original);
  const failedOut = path.join(fixture.root, 'failed-comparison');
  await assert.rejects(
    () => compareProof(preparation, baseRun, headRun, failedOut),
    /Changed base capture artifact/
  );
  assert.equal(fs.existsSync(failedOut), false);
});

test('comparison publishes its result atomically, never a successful-looking partial write', async t => {
  const fixture = syntheticRepo(t);
  const preparation = await prepareProof(fixture);
  const baseRun = path.join(fixture.root, 'base-run');
  const headRun = path.join(fixture.root, 'head-run');
  capture(preparation, 'base', baseRun);
  capture(preparation, 'head', headRun);
  const originalWrite = fs.promises.writeFile;
  const failure = t.mock.method(
    fs.promises,
    'writeFile',
    async (...args: Parameters<typeof fs.promises.writeFile>) => {
      if (String(args[0]).endsWith('.comparison.json.tmp'))
        throw new Error('Injected comparison write failure');
      return originalWrite(...args);
    }
  );
  const out = path.join(fixture.root, 'comparison');
  await assert.rejects(
    () => compareProof(preparation, baseRun, headRun, out),
    /Injected comparison write failure/
  );
  failure.mock.restore();
  assert.equal(fs.existsSync(path.join(out, 'comparison.json')), false);
  assert.equal(fs.existsSync(out), false);
  await compareProof(preparation, baseRun, headRun, out);
});

test('tracked symlink fixture parents never write outside a real Git worktree', async t => {
  const fixture = syntheticRepo(t);
  const outside = path.join(fixture.root, 'outside-source');
  fs.mkdirSync(outside);
  const sentinel = path.join(outside, 'design-proof-card.tsx');
  fs.writeFileSync(sentinel, 'outside sentinel must not change');
  fs.symlinkSync(outside, path.join(fixture.repo, 'apps/mobile/src/app/(auth)'));
  fixture.git('add', '.');
  fixture.git('commit', '-m', 'synthetic tracked auth directory symlink');
  const registered = fixture.git('worktree', 'list', '--porcelain');
  await assert.rejects(
    () => prepareProof({ ...fixture, head: fixture.git('rev-parse', 'HEAD') }),
    /ancestor is not a contained real directory/
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside sentinel must not change');
  assert.equal(fs.existsSync(fixture.out), false);
  assert.equal(fixture.git('worktree', 'list', '--porcelain'), registered);
});

test('prepared source validation rejects symlink ancestors even when the external leaf matches', async t => {
  const fixture = syntheticRepo(t);
  const preparation = await prepareProof(fixture);
  const base = preparation.base.directory;
  const auth = path.join(base, 'apps/mobile/src/app/(auth)');
  const outside = path.join(fixture.root, 'external-matching-fixture');
  fs.mkdirSync(outside);
  const text = fs.readFileSync(path.join(auth, 'design-proof-card.tsx'), 'utf8');
  fs.writeFileSync(path.join(outside, 'design-proof-card.tsx'), text);
  fs.renameSync(auth, `${auth}-original`);
  fs.symlinkSync(outside, auth);
  assert.throws(
    () => validatePreparedSource(preparation, 'base', base),
    /ancestor is not a contained real directory/
  );
  assert.equal(fs.readFileSync(path.join(outside, 'design-proof-card.tsx'), 'utf8'), text);
});

test('runtime verification accepts one usable debugger plus an empty debugger URL', async t => {
  const fixture = syntheticRepo(t);
  const preparation = await prepareProof(fixture);
  let opened = '';
  let closed = false;
  await verifyRuntimeSource(preparation, 'base', 'http://127.0.0.1:8081', ['synthetic'], {
    listPages: async () => [
      { id: 'empty', deviceName: 'synthetic', webSocketDebuggerUrl: '' },
      {
        id: 'usable',
        deviceName: 'Synthetic Phone',
        webSocketDebuggerUrl: 'ws://synthetic.invalid/debugger',
      },
    ],
    openSession: async url => {
      opened = url;
      return {
        request: async () => ({}),
        isOpen: () => true,
        close: () => {
          closed = true;
        },
      };
    },
    evaluate: async () => sourceMarker(preparation, 'base'),
  });
  assert.equal(opened, 'ws://synthetic.invalid/debugger');
  assert.equal(closed, true);
});

test('runtime proof refuses unrelated, unbound and multiply matching debugger targets', async t => {
  const fixture = syntheticRepo(t);
  const preparation = await prepareProof(fixture);
  const cases = [
    [
      {
        id: 'other',
        deviceName: 'unrelated phone',
        webSocketDebuggerUrl: 'ws://synthetic.invalid/other',
      },
    ],
    [{ id: 'unknown', webSocketDebuggerUrl: 'ws://synthetic.invalid/unknown' }],
    [
      {
        id: 'owned-1',
        deviceName: 'synthetic phone one',
        webSocketDebuggerUrl: 'ws://synthetic.invalid/one',
      },
      {
        id: 'owned-999',
        deviceName: 'synthetic phone two',
        webSocketDebuggerUrl: 'ws://synthetic.invalid/two',
      },
    ],
    [
      {
        id: 'menu-1',
        title: 'ExpoDevMenu',
        deviceName: 'synthetic',
        webSocketDebuggerUrl: 'ws://synthetic.invalid/menu',
      },
      {
        id: 'app-999',
        title: 'Kilo',
        deviceName: 'synthetic',
        webSocketDebuggerUrl: 'ws://synthetic.invalid/app',
      },
    ],
  ];
  for (const pages of cases) {
    let opened = false;
    await assert.rejects(
      () =>
        verifyRuntimeSource(preparation, 'base', 'http://127.0.0.1:8081', ['synthetic'], {
          listPages: async () => pages,
          openSession: async () => {
            opened = true;
            throw new Error('Ambiguous runtime must not be connected');
          },
          evaluate: async () => sourceMarker(preparation, 'base'),
        }),
      /positively device-matched/
    );
    assert.equal(opened, false);
  }
  let closed = false;
  await assert.rejects(
    () =>
      verifyRuntimeSource(preparation, 'base', 'http://127.0.0.1:8081', ['synthetic'], {
        listPages: async () => [
          {
            id: 'owned',
            deviceName: 'synthetic',
            webSocketDebuggerUrl: 'ws://synthetic.invalid/owned',
          },
        ],
        openSession: async () => ({
          request: async () => ({}),
          isOpen: () => true,
          close: () => {
            closed = true;
          },
        }),
        evaluate: async () => 'stale-preparation-marker',
      }),
    /Runtime is stale/
  );
  assert.equal(closed, true);
});

// These condition waits observe real child-process/filesystem state; fake time
// cannot advance the separately executing CLI, Git hooks or kernel signals.
async function waitForState(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(20);
  }
}

function startProofCli(t: TestContext, repo: string, args: string[], imports: string[] = []) {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const imported = imports.flatMap(file => ['--import', file]);
  const child = spawn(
    process.execPath,
    [...imported, '--import', import.meta.resolve('tsx'), cli, ...args],
    {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '';
  child.stdout?.on('data', chunk => {
    output += String(chunk);
  });
  child.stderr?.on('data', chunk => {
    output += String(chunk);
  });
  const completion = Promise.withResolvers<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  const watchdog = setTimeout(() => {
    child.kill('SIGKILL');
    completion.reject(new Error(`Proof CLI failed to finish: ${output}`));
  }, 25_000);
  child.once('error', error => {
    clearTimeout(watchdog);
    completion.reject(error);
  });
  child.once('close', (code, signal) => {
    clearTimeout(watchdog);
    completion.resolve({ code, signal });
  });
  t.after(() => {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  return { child, completed: completion.promise, output: () => output };
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(
    `actual prepare CLI ${signal} kills its real checkout hook group and rolls back`,
    { timeout: 40_000 },
    async t => {
      const fixture = syntheticRepo(t);
      const hook = path.join(fixture.repo, '.git/hooks/post-checkout');
      fixture.git('config', 'core.hooksPath', path.dirname(hook));
      const started = path.join(fixture.root, 'hook-started');
      const sleeper = path.join(fixture.root, 'hook-sleeper');
      const group = path.join(fixture.root, 'hook-process-group');
      const sleeperReady = path.join(fixture.root, 'hook-sleeper-ready');
      fs.writeFileSync(
        hook,
        `#!/bin/sh\nsh -c 'trap "" TERM; printf ready > "${sleeperReady}"; exec sleep 60' >/dev/null 2>&1 &\necho $! > '${sleeper}'\nps -o pgid= -p $$ > '${group}'\nprintf ready > '${started}'\nwait\n`
      );
      fs.chmodSync(hook, 0o755);
      const registered = fixture.git('worktree', 'list', '--porcelain');
      t.after(() => {
        if (!fs.existsSync(group)) return;
        const pgid = Number(fs.readFileSync(group, 'utf8').trim());
        if (!Number.isSafeInteger(pgid) || pgid <= 1) return;
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      });
      const invocation = startProofCli(t, fixture.repo, [
        'prepare',
        '--base',
        fixture.base,
        '--head',
        fixture.head,
        '--targets',
        fixture.targets,
        '--out',
        fixture.out,
      ]);
      await waitForState(
        () => fs.existsSync(started) && fs.existsSync(sleeperReady),
        `real Git checkout hook (${invocation.output()})`
      );
      const sleeperPid = Number(fs.readFileSync(sleeper, 'utf8').trim());
      invocation.child.kill(signal);
      invocation.child.kill(signal);
      const exited = await invocation.completed;
      assert.equal(exited.code, signal === 'SIGINT' ? 130 : 143, invocation.output());
      assert.equal(exited.signal, null);
      assert.equal(fs.existsSync(fixture.out), false);
      assert.equal(fixture.git('worktree', 'list', '--porcelain'), registered);
      await waitForState(() => {
        try {
          process.kill(sleeperPid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
          throw error;
        }
      }, 'owned checkout hook descendant termination');
      fs.unlinkSync(hook);
      const retried = await prepareProof(fixture);
      validatePreparedSource(retried, 'head', retried.head.directory);
    }
  );

  for (const command of ['prepare', 'compare'] as const) {
    test(
      `actual ${command} CLI ${signal} during receipt publication rolls back and permits retry`,
      { timeout: 40_000 },
      async t => {
        const fixture = syntheticRepo(t);
        const phase = path.join(fixture.root, 'receipt-written');
        const preload = path.join(fixture.root, 'receipt-latch.mjs');
        const suffix = command === 'prepare' ? 'preparation.json' : '.comparison.json.tmp';
        // The real receipt is written first. A cancellable latch then holds this
        // actual child CLI in its publication phase until the OS signal arrives.
        fs.writeFileSync(
          preload,
          `import fs from 'node:fs';\nconst write = fs.promises.writeFile;\nfs.promises.writeFile = async (...args) => {\n  await write(...args);\n  if (!String(args[0]).endsWith(${JSON.stringify(suffix)})) return;\n  fs.writeFileSync(${JSON.stringify(phase)}, 'receipt really written');\n  const signal = args[2]?.signal;\n  if (!signal) throw new Error('Receipt publication must be abort-aware');\n  signal.throwIfAborted();\n  const pending = Promise.withResolvers();\n  const timeout = setTimeout(() => pending.reject(new Error('receipt test latch timed out')), 20000);\n  signal.addEventListener('abort', () => { clearTimeout(timeout); pending.reject(signal.reason); }, { once: true });\n  return pending.promise;\n};\n`
        );
        let out = fixture.out;
        let args = [
          'prepare',
          '--base',
          fixture.base,
          '--head',
          fixture.head,
          '--targets',
          fixture.targets,
          '--out',
          out,
        ];
        let preparation: Preparation | undefined;
        let baseRun = '';
        let headRun = '';
        if (command === 'compare') {
          preparation = await prepareProof(fixture);
          baseRun = path.join(fixture.root, 'base-run');
          headRun = path.join(fixture.root, 'head-run');
          capture(preparation, 'base', baseRun);
          capture(preparation, 'head', headRun);
          out = path.join(fixture.root, 'comparison');
          args = [
            'compare',
            '--preparation',
            path.join(fixture.out, 'preparation.json'),
            '--base-run',
            baseRun,
            '--head-run',
            headRun,
            '--out',
            out,
          ];
        }
        const registered = fixture.git('worktree', 'list', '--porcelain');
        const invocation = startProofCli(t, fixture.repo, args, [preload]);
        await waitForState(
          () => fs.existsSync(phase),
          `actual receipt publication (${invocation.output()})`
        );
        assert.equal(fs.existsSync(path.join(out, suffix)), true);
        invocation.child.kill(signal);
        invocation.child.kill(signal);
        const exited = await invocation.completed;
        assert.equal(exited.code, signal === 'SIGINT' ? 130 : 143, invocation.output());
        assert.equal(fs.existsSync(out), false);
        assert.equal(fixture.git('worktree', 'list', '--porcelain'), registered);
        if (command === 'prepare') {
          const retried = await prepareProof(fixture);
          validatePreparedSource(retried, 'head', retried.head.directory);
        } else if (preparation !== undefined) {
          const retried = await compareProof(preparation, baseRun, headRun, out);
          assert.equal(retried.status, 'comparable');
        }
      }
    );
  }
}
