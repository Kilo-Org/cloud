/* eslint-disable id-length, import/no-nodejs-modules, max-lines, max-params, no-continue, unicorn/no-immediate-mutation, jest/max-expects, jest/no-conditional-in-test, jest/valid-expect */
/**
 * Design-token drift guard for the extension side panel.
 *
 * Scans sidepanel sources + public/icon/icon.svg and fails on default Tailwind
 * palette families, raw hex/rgb, arbitrary text-[Npx] / tracking-[…], and
 * opacity modifiers on ring-brand-primary-ring. Also asserts DESIGN_TOKENS
 * stays in sync with style.css @theme hexes.
 *
 * Allow-list (every rule): style.css, design-tokens.ts, this file, E2E
 * assertion files under tests/e2e/. icon.svg is covered only by its dedicated
 * hex assertion below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sidepanelDir = resolve(import.meta.dirname);
const iconSvgPath = resolve(sidepanelDir, '../../public/icon/icon.svg');
const styleCssPath = join(sidepanelDir, 'style.css');
const designTokensPath = join(sidepanelDir, 'design-tokens.ts');
const thisTestFile = 'design-token-drift.test.ts';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.html', '.js', '.jsx']);

/** Files skipped by every ban rule (token definitions, this guard, E2E asserts). */
const isAllowListedPath = (absolutePath: string): boolean => {
  const name = basename(absolutePath);

  if (name === 'style.css' || name === 'design-tokens.ts' || name === thisTestFile) {
    return true;
  }

  // E2E assertion files pin token RGBs (outside the sidepanel walk, but keep explicit).
  if (/[/\\]tests[/\\]e2e[/\\]/u.test(absolutePath)) {
    return true;
  }

  // Icon.svg has its own dedicated hex assertion — skip generic bans.
  if (name === 'icon.svg') {
    return true;
  }

  return false;
};

const walkFiles = (dir: string): string[] => {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);

    if (stat.isDirectory()) {
      files.push(...walkFiles(full));
    } else if (SOURCE_EXTENSIONS.has(extname(full))) {
      files.push(full);
    }
  }

  return files;
};

// Default Tailwind palette steps, excluding status-/diff-/syntax- token prefixes.
const DEFAULT_PALETTE_RE =
  /(?<!(?:status|diff|syntax)-)(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-(?:50|[1-9]00|950)\b/gu;

const RAW_HEX_RE = /#(?:[0-9a-fA-F]{3,8})\b/gu;
const RGB_RE = /\brgba?\(/gu;
const TEXT_PX_RE = /\btext-\[\d+px\]/gu;
const TRACKING_ARBITRARY_RE = /\btracking-\[[^\]]+\]/gu;
const RING_BRAND_OPACITY_RE = /\bring-brand-primary-ring\/\d+\b/gu;

/** OTP mono presentation in auth-views.tsx — recorded exception (not an eyebrow). */
const ALLOWED_TRACKING = 'tracking-[0.18em]';
const ALLOWED_TRACKING_FILE = 'auth-views.tsx';

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly match: string;
  readonly rule: string;
}

const lineNumberAt = (source: string, index: number): number =>
  source.slice(0, index).split('\n').length;

const collectMatches = (
  source: string,
  relativePath: string,
  pattern: RegExp,
  rule: string,
  shouldIgnore: (matchText: string) => boolean = () => false
): Finding[] => {
  const findings: Finding[] = [];
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);

  for (const match of source.matchAll(re)) {
    const [matchText = ''] = match;

    if (!shouldIgnore(matchText)) {
      findings.push({
        file: relativePath,
        line: lineNumberAt(source, match.index),
        match: matchText,
        rule,
      });
    }
  }

  return findings;
};

interface BanRule {
  pattern: RegExp;
  rule: string;
  shouldIgnore?: (matchText: string, relativePath: string) => boolean;
}

const BAN_RULES: readonly BanRule[] = [
  { pattern: DEFAULT_PALETTE_RE, rule: 'default-tailwind-palette' },
  { pattern: RAW_HEX_RE, rule: 'raw-hex' },
  { pattern: RGB_RE, rule: 'raw-rgb' },
  { pattern: TEXT_PX_RE, rule: 'arbitrary-text-px' },
  {
    pattern: TRACKING_ARBITRARY_RE,
    rule: 'arbitrary-tracking',
    // Recorded exception: OTP code display uses tracking-[0.18em] in auth-views.tsx.
    shouldIgnore: (matchText, relativePath) =>
      matchText === ALLOWED_TRACKING && basename(relativePath) === ALLOWED_TRACKING_FILE,
  },
  { pattern: RING_BRAND_OPACITY_RE, rule: 'ring-brand-primary-ring-opacity' },
];

const scanSourceForBans = (absolutePath: string, root: string): Finding[] => {
  if (isAllowListedPath(absolutePath)) {
    return [];
  }

  const relativePath = relative(root, absolutePath);
  const source = readFileSync(absolutePath, 'utf8');

  return BAN_RULES.flatMap(({ pattern, rule, shouldIgnore }) =>
    collectMatches(
      source,
      relativePath,
      pattern,
      rule,
      matchText => shouldIgnore?.(matchText, relativePath) === true
    )
  );
};

/** Scan an arbitrary source string (self-check fixtures live outside the tree). */
const scanSourceTextForBans = (source: string, label = 'fixture'): Finding[] =>
  BAN_RULES.flatMap(({ pattern, rule }) => collectMatches(source, label, pattern, rule));

const formatFindings = (findings: Finding[]): string =>
  findings
    .map(finding => `${finding.file}:${finding.line} [${finding.rule}] ${finding.match}`)
    .join('\n');

/** Join string parts without writing complete banned class literals in source. */
const concatParts = (parts: string[]): string => parts.join('');

/** StatusGreen500 → status-green-500; surfaceOverlay → surface-overlay. */
const camelToKebab = (value: string): string =>
  value
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replaceAll(/([A-Za-z])(\d)/gu, '$1-$2')
    .toLowerCase();

const normalizeHex = (hex: string): string => {
  const trimmed = hex.trim().replace(/^#/u, '').toLowerCase();

  if (trimmed.length === 3 || trimmed.length === 4) {
    return Array.from(trimmed, ch => `${ch}${ch}`).join('');
  }

  return trimmed;
};

const parseDesignTokens = (source: string): Record<string, string> => {
  const tokens: Record<string, string> = {};
  const objectMatch = source.match(/export const DESIGN_TOKENS\s*=\s*\{([\s\S]*?)\}\s*as const/u);
  const body = objectMatch?.[1];

  if (body === undefined) {
    throw new Error('Could not parse DESIGN_TOKENS object from design-tokens.ts');
  }

  const entryRe = /([A-Za-z][A-Za-z0-9]*)\s*:\s*['"](#[0-9a-fA-F]{3,8})['"]/gu;

  for (const entry of body.matchAll(entryRe)) {
    const [, key, hex] = entry;

    if (key !== undefined && hex !== undefined) {
      tokens[key] = hex;
    }
  }

  return tokens;
};

const parseThemeHexes = (source: string): Record<string, string> => {
  const tokens: Record<string, string> = {};
  const varRe = /--color-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/gu;

  for (const match of source.matchAll(varRe)) {
    const [, kebab, hex] = match;

    if (kebab !== undefined && hex !== undefined) {
      tokens[kebab] = hex;
    }
  }

  return tokens;
};

const collectIconHexViolations = (source: string): string[] => {
  const violations: string[] = [];

  if (!/#F7F586/iu.test(source)) {
    violations.push('icon.svg must contain brand #F7F586');
  }

  if (/#EDFF00/iu.test(source)) {
    violations.push('icon.svg must not contain legacy #EDFF00');
  }

  const hexes = source.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? [];
  const allowed = new Set([normalizeHex('#F7F586'), normalizeHex('#000000')]);

  for (const hex of hexes) {
    const normalized = normalizeHex(hex);

    if (!allowed.has(normalized)) {
      violations.push(`icon.svg hex #${normalized} is not in {#F7F586, #000000}`);
    }
  }

  return violations;
};

const collectTokenSyncMismatches = (
  designTokens: Record<string, string>,
  themeHexes: Record<string, string>
): string[] =>
  Object.entries(designTokens).flatMap(([key, hex]) => {
    const kebab = camelToKebab(key);
    const themeHex = themeHexes[kebab];

    if (themeHex === undefined) {
      return [`DESIGN_TOKENS.${key} → --color-${kebab} missing from style.css @theme`];
    }

    if (normalizeHex(hex) !== normalizeHex(themeHex)) {
      return [`DESIGN_TOKENS.${key}=${hex} ≠ --color-${kebab}=${themeHex}`];
    }

    return [];
  });

describe('design-token drift guard', () => {
  it('self-check: scanner catches planted violations on fixture strings', () => {
    // Build planted class fragments at runtime so Tailwind content scan cannot
    // Emit banned utilities from this test file into the sidepanel CSS bundle.
    const planted = [
      concatParts([
        'className="bg-',
        'zinc',
        '-900 text-',
        'red',
        '-400 border-',
        'amber',
        '-500/30"',
      ]),
      concatParts(['const brand = "#', 'EDFF00', '";']),
      concatParts(['background: rgb(', '9, 9, 11', ');']),
      concatParts(['text-[', '11', 'px] tracking-[', '0.14', 'em]']),
      concatParts(['focus-visible:ring-brand-primary-ring/', '40']),
    ].join('\n');

    const findings = scanSourceTextForBans(planted, 'planted-fixture');
    const rules = new Set(findings.map(finding => finding.rule));
    const required = [
      'default-tailwind-palette',
      'raw-hex',
      'raw-rgb',
      'arbitrary-text-px',
      'arbitrary-tracking',
      'ring-brand-primary-ring-opacity',
    ];
    const missing = required.filter(rule => !rules.has(rule));

    expect(missing).toStrictEqual([]);
    expect(formatFindings(findings).length).toBeGreaterThan(0);

    // Token-prefixed classes must stay legal (already present in product sources).
    const legal = [
      'bg-status-red-500 text-diff-delete-text text-syntax-string',
      'bg-surface-raised text-foreground border-border',
      'ring-brand-primary-ring',
    ].join('\n');

    expect(scanSourceTextForBans(legal, 'legal-fixture')).toStrictEqual([]);
  });

  it('scans sidepanel sources for banned color/typography patterns', () => {
    const files = walkFiles(sidepanelDir);
    const findings = files.flatMap(file => scanSourceForBans(file, sidepanelDir));

    if (findings.length > 0) {
      throw new Error(`Banned design patterns:\n${formatFindings(findings)}`);
    }

    expect(findings).toStrictEqual([]);
  });

  it('asserts icon.svg brand hex contract', () => {
    const source = readFileSync(iconSvgPath, 'utf8');
    const violations = collectIconHexViolations(source);

    expect(violations).toStrictEqual([]);
  });

  it('keeps DESIGN_TOKENS in sync with style.css @theme hexes', () => {
    const designSource = readFileSync(designTokensPath, 'utf8');
    const styleSource = readFileSync(styleCssPath, 'utf8');
    const designTokens = parseDesignTokens(designSource);
    const themeHexes = parseThemeHexes(styleSource);

    expect(Object.keys(designTokens).length).toBeGreaterThan(0);

    const mismatches = collectTokenSyncMismatches(designTokens, themeHexes);

    expect(mismatches).toStrictEqual([]);
  });
});
