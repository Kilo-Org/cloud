import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CellRun } from './capture';
import type { Finding } from './findings';
import { matrixCells } from './matrix';
import {
  annotateArgs,
  collapseFindings,
  montageArgs,
  renderReport,
  resolveFont,
  screenBoxes,
  writeArtifacts,
} from './report';

const finding = (overrides: Partial<Finding>): Finding => ({
  rule: 'clipped',
  severity: 'error',
  cell: 'base',
  target: 'sessions',
  element: {
    index: 4,
    path: 'StoredSessionRow > View > Paragraph[1]',
    tag: 'Paragraph',
    rect: [10, 20, 100, 18],
  },
  measured: 3.5,
  expected: '≤ 1 dp',
  unit: 'dp',
  message: 'Text extends past its clipping container.',
  ...overrides,
});

const findings = [
  finding({}),
  finding({
    rule: 'touch-target',
    severity: 'warning',
    cell: 'dark',
    measured: 24,
    expected: '≥ 28 dp',
  }),
];

test('renderReport lists the summary table and one line per finding', () => {
  const [base, dark] = matrixCells('android', 'standard');
  assert.ok(base && dark);
  const cells: CellRun[] = [
    {
      id: 'base',
      config: base,
      screens: [
        {
          target: 'sessions',
          link: 'kiloapp://sessions',
          screenshot: 'cells/base/sessions.png',
          annotated: 'cells/base/sessions.annotated.png',
          dump: 'cells/base/sessions.json',
          env: { route: '/login', pixelRatio: 2 } as CellRun['screens'][number]['env'],
        },
      ],
    },
    { id: 'dark', config: dark, screens: [] },
  ];
  const report = renderReport(
    {
      platform: 'android',
      device: 'emulator-5554',
      matrix: 'standard',
      startedAt: 'S',
      finishedAt: 'F',
    },
    cells,
    collapseFindings(findings)
  );
  assert.match(report, /\| base \| 1 \| 1 \| 0 \|/);
  assert.ok(report.includes('| base | sessions | `/login` | 1 | 0 |'));
  assert.ok(report.includes('App: com.kilocode.kiloapp (needs a dev build connected to Metro'));
  assert.match(report, /\| dark \| 0 \| 0 \| 1 \|/);
  assert.ok(
    report.includes(
      '1. **error** `clipped` · base · sessions · `StoredSessionRow > View > Paragraph[1]` · measured 3.5 dp vs expected ≤ 1 dp — Text extends past its clipping container.'
    )
  );
  assert.ok(report.includes('2. **warning** `touch-target` · dark'));
  assert.match(
    renderReport(
      { platform: 'ios', device: 'u', matrix: 'base', startedAt: 'S', finishedAt: 'F' },
      [],
      []
    ),
    /No findings\./
  );
});

test('screenBoxes scales dp to px and numbers findings globally', () => {
  const groups = collapseFindings(findings);
  assert.deepEqual(screenBoxes(groups, 'dark', 'sessions', 2), [
    { rect: [20, 40, 200, 36], color: '#ffb000', label: '2' },
  ]);
  assert.deepEqual(screenBoxes(groups, 'rtl', 'sessions', 2), []);
});

test('collapseFindings merges list-row repeats and keeps every box', () => {
  const row = (index: number, measured: number): Finding =>
    finding({
      rule: 'touch-target',
      severity: 'warning',
      measured,
      element: {
        index,
        path: `SessionRow[${index}] > Pressable[1]`,
        tag: 'View',
        rect: [0, index * 50, 20, 20],
      },
    });
  const rows = Array.from({ length: 12 }, (_, index) => row(index, 24.04));
  const groups = collapseFindings([...rows, row(99, 24.2), finding({ target: 'other' })]);
  assert.equal(groups.length, 3);
  const [merged] = groups;
  assert.equal(merged?.finding.count, 12);
  assert.equal(merged?.finding.related?.length, 10);
  assert.equal(merged?.finding.element.index, 0);
  assert.equal(
    screenBoxes(groups, 'base', 'sessions', 1).filter(box => box.label === '1').length,
    12
  );
  const report = renderReport(
    { platform: 'android', device: 'd', matrix: 'base', startedAt: 'S', finishedAt: 'F' },
    [],
    groups
  );
  assert.ok(report.includes('1. **warning** `touch-target` ×12 · base · sessions'));
  assert.ok(report.includes('2. **warning** `touch-target` · base'));
});

test('magick annotate and montage arguments with a font', () => {
  const font = '/fonts/DejaVuSans.ttf';
  const box = { rect: [20.4, 40.6, 200, 36] as const, color: '#ff2020', label: '1' };
  assert.deepEqual(annotateArgs('in.png', 'out.png', [box], font), [
    'in.png',
    '-strokewidth',
    '4',
    '-font',
    font,
    '-pointsize',
    '32',
    '-fill',
    'none',
    '-stroke',
    '#ff2020',
    '-draw',
    'rectangle 20,41 220,77',
    '-fill',
    '#ff2020',
    '-stroke',
    'none',
    '-annotate',
    '+24+73',
    '1',
    'out.png',
  ]);
  assert.deepEqual(montageArgs([{ label: 'base · 100%', file: 'a.png' }], 'sheet.png', font), [
    '-font',
    font,
    '-pointsize',
    '20',
    '-label',
    'base · 100%%',
    'a.png',
    '-tile',
    '4x',
    '-geometry',
    '360x+12+12',
    '-background',
    '#ffffff',
    'sheet.png',
  ]);
});

test('without a font, boxes and montage carry no text', () => {
  const box = { rect: [0, 0, 10, 10] as const, color: '#ffb000', label: '2' };
  const annotate = annotateArgs('in.png', 'out.png', [box], undefined);
  assert.ok(!annotate.includes('-annotate') && !annotate.includes('-font'));
  assert.ok(annotate.includes('rectangle 0,0 10,10'));
  assert.deepEqual(montageArgs([{ label: 'x', file: 'a.png' }], 's.png', undefined).slice(0, 2), [
    'a.png',
    '-tile',
  ]);
  assert.equal(
    resolveFont(() => false),
    undefined
  );
  assert.equal(
    resolveFont(file => file.startsWith('/usr/share/fonts/dejavu/')),
    '/usr/share/fonts/dejavu/DejaVuSans.ttf'
  );
  assert.equal(
    resolveFont(file => file.endsWith('.ttc') || file.endsWith('.ttf')),
    '/System/Library/Fonts/Supplemental/Arial.ttf'
  );
});

test('writeArtifacts writes one sheet per target in matrix order and lists it', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'design-gate-report-'));
  const commands: string[][] = [];
  const exec = (command: string, args: readonly string[]) => {
    commands.push([command, ...args]);
    return Buffer.from('');
  };
  const env = { route: '/', pixelRatio: 1, safeAreaKnown: false } as CellRun['screens'][number]['env'];
  const screen = (cell: string, target: string) => ({
    target,
    link: `kiloapp://${target}`,
    screenshot: `cells/${cell}/${target}.png`,
    annotated: `cells/${cell}/${target}.annotated.png`,
    dump: `cells/${cell}/${target}.json`,
    env,
  });
  const cells: CellRun[] = matrixCells('android', 'standard')
    .slice(0, 2)
    .map(config => ({
      id: config.id,
      config,
      screens: [screen(config.id, 'home'), screen(config.id, 'chat')],
    }));
  writeArtifacts({
    exec,
    out,
    meta: { platform: 'android', device: 'd', matrix: 'standard', startedAt: 'S', finishedAt: 'F' },
    outcome: { cells, findings: [] },
  });
  const homeSheet = commands.find(command => command.at(-1) === path.join(out, 'sheets/home.png'));
  assert.ok(homeSheet);
  const files = homeSheet.filter(arg => arg.endsWith('.annotated.png'));
  assert.deepEqual(files, [
    path.join(out, 'cells/base/home.annotated.png'),
    path.join(out, 'cells/dark/home.annotated.png'),
  ]);
  assert.ok(homeSheet.includes('2x1') && homeSheet.includes('540x+12+12'));
  const findings = JSON.parse(fs.readFileSync(path.join(out, 'findings.json'), 'utf8')) as {
    run: { sheets: unknown; skippedRules: { cell: string; target: string; rule: string; reason: string }[] };
  };
  assert.deepEqual(findings.run.sheets, [
    { target: 'home', file: 'sheets/home.png' },
    { target: 'chat', file: 'sheets/chat.png' },
  ]);
  assert.equal(findings.run.skippedRules.length, 4);
  assert.ok(findings.run.skippedRules.every(entry => entry.rule === 'safe-area'));
  assert.match(
    fs.readFileSync(path.join(out, 'report.md'), 'utf8'),
    /base · home · safe-area: snapshot has no system-bar inset evidence/
  );
});
