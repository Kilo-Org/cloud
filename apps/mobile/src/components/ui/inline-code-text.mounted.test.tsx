/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); its React 19 deprecation notice points to the DOM-based Testing Library, which cannot render this app's non-DOM tree, and @testing-library/react-native cannot be transformed by the current vitest pipeline (react-native ships Flow). See src/test/render-with-providers.tsx. */
import { type default as TestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InlineCodeText, type InlineCodeTextProps } from './inline-code-text';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';
import { renderWithProviders } from '@/test/render-with-providers';

vi.mock('react-native', () => ({
  Text: 'NativeText',
  I18nManager: { isRTL: false },
}));
// The real ui Text pulls the RN/reusables source the vitest pipeline cannot
// parse; the mocks keep the component's own splitting and run nesting real
// while staying distinguishable: 'NativeText' is a bare react-native Text and
// 'StyledText' is the cva-styled wrapper.
vi.mock('@/components/ui/text', () => ({ Text: 'StyledText' }));

const mounted: Awaited<ReturnType<typeof renderWithProviders>>[] = [];

afterEach(() => {
  for (const result of mounted.splice(0)) {
    result.unmount();
  }
});

type MountProps = Omit<InlineCodeTextProps, 'children'>;

async function mountText(children: string, props: MountProps = {}) {
  const result = await renderWithProviders(<InlineCodeText {...props}>{children}</InlineCodeText>);
  mounted.push(result);
  return result.renderer.root;
}

// Host instances (string type, the mocked Text) carry the rendered runs;
// function-component instances carry the raw element props instead, so they
// are skipped.
function hostTextInstances(node: TestRenderer.ReactTestInstance) {
  return node.findAll(instance => typeof instance.type === 'string');
}

function stringsOf(instance: TestRenderer.ReactTestInstance): string[] {
  const collected: string[] = [];
  const collect = (children: unknown): void => {
    if (typeof children === 'string') {
      collected.push(children);
      return;
    }
    if (Array.isArray(children)) {
      for (const child of children) {
        collect(child);
      }
    }
  };
  collect(instance.props.children);
  return collected;
}

function codeRunsOf(node: TestRenderer.ReactTestInstance) {
  return hostTextInstances(node).filter(instance =>
    String(instance.props.className).includes('text-primary')
  );
}

// The cva-styled wrapper carries the caller's variant and classes; the nested
// code runs must be bare react-native Text so the styled Text's base classes
// (`text-foreground text-base font-medium`) cannot override the wrapper's
// size and color on them.
function styledWrappersOf(node: TestRenderer.ReactTestInstance) {
  return hostTextInstances(node).filter(instance => String(instance.type) === 'StyledText');
}

function nthInstance(
  instances: TestRenderer.ReactTestInstance[],
  index: number,
  label: string
): TestRenderer.ReactTestInstance {
  const instance = instances.at(index);
  if (!instance) {
    throw new Error(`expected a rendered instance: ${label}`);
  }
  return instance;
}

/**
 * Largest per-channel RGB distance between two theme hex values. The theme
 * here is the app's own generated token table (scripts/generate-theme-colors
 * .mjs, kept in lockstep with src/global.css by `pnpm test`'s assert step), so
 * the measurement follows the real shipped colors. A nested Text on device
 * renders only its text properties — its mark is the run's text color, so
 * this measures that color against the page and against the surrounding copy,
 * in numbers, instead of trusting a class name.
 */
function channelsOfHex(value: string): number[] {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  const digits = match?.[1];
  if (!digits) {
    throw new Error(`expected a #rrggbb theme value, got ${value}`);
  }
  return [0, 2, 4].map(offset => Number.parseInt(digits.slice(offset, offset + 2), 16));
}

function maxChannelDistance(hexA: string, hexB: string): number {
  const channelsA = channelsOfHex(hexA);
  const channelsB = channelsOfHex(hexB);
  return Math.max(
    ...[0, 1, 2].map(index => Math.abs((channelsA[index] ?? 0) - (channelsB[index] ?? 0)))
  );
}

/** `text-primary` → the theme table's `primary` value, in both schemes. */
function themeValuesForColorClass(colorClass: string): { light: string; dark: string } {
  const token = colorClass.replace(/^(?:bg|text)-/, '');
  const light = (lightColors as Record<string, string>)[token];
  const dark = (darkColors as Record<string, string>)[token];
  if (!light || !dark) {
    throw new Error(`the run's color class has no theme token: ${colorClass}`);
  }
  return { light, dark };
}

describe('InlineCodeText (mounted)', () => {
  it('renders copy without code spans as one plain text with the given classes', async () => {
    const root = await mountText('Nothing to style here.', {
      variant: 'muted',
      className: 'text-center',
    });

    const hosts = hostTextInstances(root);
    expect(hosts).toHaveLength(1);
    const host = nthInstance(hosts, 0, 'plain text');
    expect(host.type).toBe('StyledText');
    expect(stringsOf(host)).toEqual(['Nothing to style here.']);
    expect(String(host.props.className)).toContain('text-center');
    expect(String(host.props.className)).not.toContain('bg-muted');
  });

  it('styles backtick-delimited spans as inline code and renders no backticks', async () => {
    const root = await mountText('Run `kilo remote` on your computer.', {
      className: 'text-base text-foreground',
    });

    // Every rendered string run is backtick-free.
    for (const instance of hostTextInstances(root)) {
      for (const text of stringsOf(instance)) {
        expect(text).not.toContain('`');
      }
    }

    // The code span is its own run carrying the shared inline-code styling,
    // nested inside the wrapping text (which keeps the caller's classes).
    // Spaces inside a span render as non-breaking so the run cannot wrap
    // mid-command and split the chip into two fragments (SPOT-DEFECT from
    // e1); in the inherited body font NBSP keeps the real space's advance.
    const codeRuns = codeRunsOf(root);
    expect(codeRuns).toHaveLength(1);
    expect(stringsOf(nthInstance(codeRuns, 0, 'code run'))).toEqual(['kilo\u00A0remote']);
    // The chip is a bare react-native Text, not the styled one: the styled
    // Text's cva base would override the wrapper's size and color.
    for (const codeRun of codeRuns) {
      expect(codeRun.type).toBe('NativeText');
    }

    const wrappers = styledWrappersOf(root);
    expect(wrappers).toHaveLength(1);
    expect(String(nthInstance(wrappers, 0, 'wrapper').props.className)).toContain(
      'text-foreground'
    );
  });

  it('keeps the wrapping variant so muted copy keeps its color', async () => {
    const root = await mountText('Run `kilo remote` in a project.', { variant: 'muted' });

    const wrappers = styledWrappersOf(root);
    expect(wrappers).toHaveLength(1);
    expect(String(nthInstance(wrappers, 0, 'wrapper').props.variant)).toBe('muted');
  });

  it('styles every span when the copy carries more than one', async () => {
    const root = await mountText('Run `kilo remote` or `/remote` in a running CLI session.');

    const codeRuns = codeRunsOf(root);
    expect(codeRuns).toHaveLength(2);
    expect(stringsOf(nthInstance(codeRuns, 0, 'first code run'))).toEqual(['kilo\u00A0remote']);
    expect(stringsOf(nthInstance(codeRuns, 1, 'second code run'))).toEqual(['/remote']);
    for (const codeRun of codeRuns) {
      expect(codeRun.type).toBe('NativeText');
    }
    for (const instance of hostTextInstances(root)) {
      for (const text of stringsOf(instance)) {
        expect(text).not.toContain('`');
      }
    }
  });

  it('keeps multi-word commands tight: the run inherits the body font, never a mono swap', async () => {
    // SPOT-DEFECT (e7-welcome, e8-tour-open, e18-tour-open): the chip around
    // "kilo remote" added extra word spacing so the command read as
    // "kilo  remote". The spacing came from the mono font swap — JetBrains
    // Mono draws every glyph, spaces included, at a fixed 0.6em advance,
    // more than double the surrounding proportional text's word space. The
    // non-breaking-space transform cannot fix it (NBSP carries the same
    // 0.6em advance in the shipped font), so the run must not change the
    // font at all: it marks the span with color and weight only, and the
    // word gap renders at exactly the body text's width.
    const root = await mountText(
      '...connect your computer with `kilo remote` to run sessions on it.',
      {
        className: 'text-base text-foreground',
      }
    );

    const codeRuns = codeRunsOf(root);
    const chip = nthInstance(codeRuns, 0, 'code run');

    // No font-family swap on the run: mono is what widened the gap.
    expect(String(chip.props.className)).not.toMatch(/font-mono/);
    // The run carries the color+weight mark, no size class, and the
    // caller's classes stay on the wrapper.
    expect(String(chip.props.className)).toContain('text-primary');
    expect(String(chip.props.className)).not.toContain('text-base');

    // The rendered command is one run whose word separator is a single
    // non-breaking space — no double space, no breakable gap that would
    // split the run across lines.
    const [rendered] = stringsOf(chip);
    expect(rendered).toBe('kilo\u00A0remote');
    expect(rendered).not.toMatch(/ {2}/);
  });

  it('marks the run with text properties, never a background wash (e1)', async () => {
    // SPOT-DEFECT (e1-welcome, 2026-09-09, third report): the `kilo remote`
    // run in the tour's welcome paragraph read as a leftover text selection.
    // The two earlier repairs only swapped the background token (`bg-muted`,
    // then `bg-muted-soft`) — but the mechanism, not the color, is the
    // defect: a nested Text has no chip on device. `rounded`/`px` never
    // apply to nested runs, Android paints a nested run's background with
    // BackgroundColorSpan (react-native TextLayoutManager.kt:455) — the
    // full-line-height, square-cornered span text selection itself uses —
    // and iOS ignores nested-run backgrounds entirely
    // (RCTTextShadowView.mm:47). Any background behind a nested run is
    // therefore a selection wash on Android and invisible on iOS. This test
    // pins the defect's end state:
    //   1. the run carries no background class at all — the wash cannot
    //      come back by swapping tokens, because there is no token to swap;
    //   2. the mark is text color + weight, which nested Text genuinely
    //      renders on both platforms, and the shipped theme puts that
    //      color visibly apart from both the page and the surrounding
    //      copy in both schemes;
    //   3. the e7/e8/e18 word-gap fix stands: no font-family or size class.
    const root = await mountText(
      'Two things to try: run your first cloud agent session, then connect your computer with `kilo remote` to run sessions on it.',
      { className: 'text-base text-foreground' }
    );

    const codeRuns = codeRunsOf(root);
    expect(codeRuns).toHaveLength(1);
    const chip = nthInstance(codeRuns, 0, 'code run');
    const classes = String(chip.props.className).split(/\s+/);

    // 1. The selection mechanism is structurally absent: no background, and
    //    none of the chip properties a nested run cannot render anyway.
    expect(classes.filter(cls => /^(?:bg-|rounded|px-)/.test(cls))).toEqual([]);

    // 2. The mark: color + weight, both nested-Text-renderable on device.
    expect(classes).toContain('text-primary');
    expect(classes).toContain('font-semibold');
    const markClass = classes.find(cls => cls.startsWith('text-'));
    if (!markClass) {
      throw new Error('the run carries no color class: nothing marks it');
    }
    const markValues = themeValuesForColorClass(markClass);
    // Against the page: the run is clearly deliberate, not a wash.
    expect(maxChannelDistance(markValues.light, lightColors.background)).toBeGreaterThanOrEqual(40);
    expect(maxChannelDistance(markValues.dark, darkColors.background)).toBeGreaterThanOrEqual(40);
    // Against the surrounding copy: the run differs from the inherited
    // foreground, so it reads as a marked token rather than identical text
    // sitting on a rectangle — the exact defect shape.
    expect(maxChannelDistance(markValues.light, lightColors.foreground)).toBeGreaterThanOrEqual(40);
    expect(maxChannelDistance(markValues.dark, darkColors.foreground)).toBeGreaterThanOrEqual(40);

    // 3. No font-family or size swap (the e7/e8/e18 word-gap fix and the
    //    line-metrics invariant stand).
    expect(classes.filter(cls => /font-mono|^text-\[?\d/.test(cls))).toEqual([]);
  });

  it('falls back to plain text for an unbalanced backtick', async () => {
    const root = await mountText('a ` stray backtick');

    const hosts = hostTextInstances(root);
    expect(hosts).toHaveLength(1);
    expect(stringsOf(nthInstance(hosts, 0, 'plain text'))).toEqual(['a ` stray backtick']);
    expect(codeRunsOf(root)).toHaveLength(0);
  });
});
