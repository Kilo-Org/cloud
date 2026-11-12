/* eslint-disable eslint-plugin-import/no-nodejs-modules -- the native check compiles and runs the extension's Swift sources, which no browser runtime can do */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildHomeWidgetData, buildHomeWidgetPresentation } from '@kilocode/app-shared/home-widget';

import { i18n } from '@/i18n';
import { formatGlanceableCount } from '@/lib/glanceable/count-format';
import { getHomeWidgetCopy } from '@/lib/glanceable/home-widget-copy';
import { glanceableSpokenText } from '@/lib/glanceable/presentation';

/**
 * The widget extension writes its own spoken label from the copy the app sends,
 * while the app writes the same sentence through `glanceableSpokenText`. These
 * cases build one answer per language from the real catalogs and the app's own
 * count formatter, and the darwin check compiles the extension's Foundation-only
 * rule against them: two implementations, one sentence.
 */

const NOW = Date.parse('2026-11-12T09:00:00.000Z');
const EXPIRES = new Date(NOW + 60 * 60 * 1000).toISOString();

/** The Home presentation both entry cases draw, from the shared policy. */
const HOME_DATA = buildHomeWidgetData({
  sessions: [
    { status: 'question', title: 'Review the release', statusUpdatedAt: '2026-11-12T08:00:00Z' },
    { status: 'busy', title: 'Run the tests', statusUpdatedAt: '2026-11-12T08:30:00Z' },
  ],
  userId: 'fixture-user',
  organizationId: null,
  now: NOW,
});
const PRESENTATION = buildHomeWidgetPresentation(HOME_DATA, NOW);
// The store's own count rows: the primary count first, then the rest in rank order.
const ENTRY_ROWS = [
  ...(PRESENTATION.primaryKind === null
    ? []
    : [{ kind: PRESENTATION.primaryKind, count: PRESENTATION.primaryCount }]),
  ...PRESENTATION.secondaryCounts,
];

const SOURCES = [
  {
    name: 'content with a four-figure count',
    statusKey: null,
    counts: [
      { key: 'glanceable.needsInput', count: 2 },
      { key: 'common.working', count: 1234 },
      // A zero row holds the layout still but must not be spoken.
      { key: 'common.idle', count: 0 },
    ],
  },
  { name: 'expired', statusKey: 'glanceable.expired', counts: [] },
  { name: 'signed out', statusKey: 'glanceable.signedOut', counts: [] },
] as const;

const LANGUAGES = ['en', 'fa', 'ja'] as const;

/**
 * Where each language's cases land. The native check reads exactly these files,
 * so the JS answer and the extension's answer are held to one fixture.
 */
const CASE_DIRECTORY = join(tmpdir(), 'home-widget-spoken-label');

async function casesFor(language: string) {
  const previous = i18n.language;
  await i18n.changeLanguage(language);
  try {
    const copy = getHomeWidgetCopy();
    const cases = {
      cases: SOURCES.map(source => {
        const statusLine = source.statusKey === null ? null : i18n.t(source.statusKey);
        const countLines = source.counts.map(({ key, count }) => ({
          label: i18n.t(key),
          count,
        }));
        return {
          name: source.name,
          copy,
          statusLine,
          countLines,
          expected: glanceableSpokenText(
            statusLine,
            countLines,
            key => i18n.t(key),
            formatGlanceableCount
          ),
        };
      }),
      terminal: [
        { name: 'signed-out copy', copy, expected: copy.signed_out },
        {
          name: 'copy with no signed-out string',
          copy: { privacy: copy.privacy },
          expected: copy.privacy,
        },
        { name: 'no status copy at all', copy: {}, expected: 'Sign in to see agents' },
      ],
      // The extension's own entry assembly, over the shared Home presentation:
      // once while the work is live and once at and past its expiry.
      entries: [
        { name: 'live', at: NOW, expires: Date.parse(EXPIRES) },
        { name: 'expired', at: Date.parse(EXPIRES), expires: Date.parse(EXPIRES) },
      ].map(({ name, at, expires }) => {
        const countLines = ENTRY_ROWS.map(row => ({
          kind: row.kind,
          count: row.count,
          label: copy[row.kind],
        }));
        const statusLine = PRESENTATION.status === 'content' ? null : copy[PRESENTATION.status];
        const cleared = at >= expires;
        return {
          name,
          copy,
          presentation: PRESENTATION,
          snapshot: HOME_DATA.snapshot,
          at,
          expires,
          expectedCountLines: (cleared ? [] : countLines).map(
            line => `${line.count} ${line.label}`
          ),
          expectedStatusLine: cleared ? copy.expired : statusLine,
          expectedLabel: glanceableSpokenText(
            cleared ? copy.expired : statusLine,
            cleared ? [] : countLines,
            key => i18n.t(key),
            formatGlanceableCount
          ),
        };
      }),
    };
    mkdirSync(CASE_DIRECTORY, { recursive: true });
    writeFileSync(join(CASE_DIRECTORY, `${language}.json`), JSON.stringify(cases, null, 2));
    return cases;
  } finally {
    await i18n.changeLanguage(previous);
  }
}

describe('shared spoken label', () => {
  it('writes every count with the app formatter and joins with the catalog separator', async () => {
    const english = await casesFor('en');
    expect(english.cases[0]?.expected).toBe('2 Needs input, 1,234 Working, Open agents');
    expect(english.cases[1]?.expected).toBe('Status expired, Open agents');
  });

  it('speaks the expired status and no counts once the entry is cleared', async () => {
    const persian = await casesFor('fa');
    const expired = persian.cases[1];
    expect(expired?.statusLine).toBe(expired?.copy.expired);
    expect(expired?.statusLine).not.toBe('glanceable.expired');
    expect(expired?.expected).toBe(
      `${expired?.copy.expired}${expired?.copy.listJoiner}${expired?.copy.openAgents}`
    );
    expect(expired?.expected).not.toMatch(/[0-9]/u);
  });

  it('writes each language with its own digits, grouping and list separator', async () => {
    const persian = await casesFor('fa');
    // Persian digits with its own thousands separator, and its own comma.
    expect(persian.cases[0]?.expected).toContain('۱٬۲۳۴');
    expect(persian.cases[0]?.expected).toContain('، ');
    expect(persian.cases[0]?.expected).not.toContain(', ');

    const japanese = await casesFor('ja');
    expect(japanese.cases[0]?.expected).toContain('、');
    expect(japanese.cases[0]?.expected).not.toContain(', ');
    expect(japanese.cases[0]?.expected).toContain('1,234');
  });

  it('never leaves the signed-out entry without a status', async () => {
    const english = await casesFor('en');
    for (const entry of english.terminal) {
      expect(entry.expected.length).toBeGreaterThan(0);
    }
  });
});

it.runIf(process.platform === 'darwin')(
  'answers every case with the extension’s own implementation',
  async () => {
    const binaryDirectory = mkdtempSync(join(tmpdir(), 'home-widget-spoken-label-bin-'));
    const binary = join(binaryDirectory, 'spoken-label-tests');
    try {
      // One compile, then every language's cases: the sources do not change.
      execFileSync('xcrun', [
        'swiftc',
        '-parse-as-library',
        fileURLToPath(new URL('../ios/HomeWidgetSpokenLabel.swift', import.meta.url)),
        fileURLToPath(new URL('../ios/HomeWidgetEntryProps.swift', import.meta.url)),
        fileURLToPath(new URL('HomeWidgetSpokenLabelTests.swift', import.meta.url)),
        '-o',
        binary,
      ]);
      const written = await Promise.all(LANGUAGES.map(language => casesFor(language)));
      for (const [index, language] of LANGUAGES.entries()) {
        expect(written[index]?.cases.length).toBeGreaterThan(0);
        const path = join(CASE_DIRECTORY, `${language}.json`);
        expect(execFileSync(binary, [path], { encoding: 'utf8' })).toContain('all checks passed');
      }
    } finally {
      rmSync(binaryDirectory, { recursive: true, force: true });
    }
  }
);
