/* eslint-disable max-lines -- one contrast guard per shipped surface shares this file's colour-math helpers. */
import { describe, expect, it, vi } from 'vitest';

import { ROW_PALETTE } from '@/lib/agent-color';
import { darkColors, lightColors } from '@/lib/hooks/use-theme-colors';
import {
  DEFAULT_TOKEN_COLOR,
  MUTED_COLOR,
  TOKEN_DARK_LIGHT,
} from '@/lib/pr-review/diff/syntax-colors';

vi.mock('react-native', () => ({ useColorScheme: () => 'light' }));
vi.mock('expo-router', () => ({ DarkTheme: {}, DefaultTheme: {} }));

// The color maps come from `src/lib/hooks/theme-colors.generated.ts`, which is
// generated from `src/global.css` and checked by `scripts/assert-theme-colors.mjs`.
// The contrast assertions below fail if a shipped pair regresses below 4.5:1.

const MIN_TEXT_RATIO = 4.5;
const MIN_NON_TEXT_RATIO = 3;

type Rgb = readonly [number, number, number];

function expandHex(hex: string): Rgb {
  const value = hex.startsWith('#') ? hex.slice(1) : hex;
  if (value.length !== 6) {
    throw new Error(`expected 6-digit hex, got ${hex}`);
  }
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ] as const;
}

// WCAG 2.x relative luminance. The 0.039_28 / 12.92 thresholds and the
// gamma offset 0.055 come straight from the WCAG 2.x spec and must not
// be tuned to "improve" the ratio.
function lineariseChannel(c: number): number {
  const s = c / 255;
  if (s <= 0.039_28) {
    return s / 12.92;
  }
  return ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb;
  return 0.2126 * lineariseChannel(r) + 0.7152 * lineariseChannel(g) + 0.0722 * lineariseChannel(b);
}

function contrastRatio(foreground: string, background: string): number {
  const fgL = relativeLuminance(expandHex(foreground));
  const bgL = relativeLuminance(expandHex(background));
  const lighter = Math.max(fgL, bgL);
  const darker = Math.min(fgL, bgL);
  return (lighter + 0.05) / (darker + 0.05);
}

// Blend an 8-digit hex (RRGGBBAA) over an opaque background. NativeWind v5
// cannot decompose theme colors, so `global.css` ships pre-baked alpha tiles
// like `--good-tile-bg: <hex>1a`; the diff text actually renders on the
// resulting tinted surface, so assertions must use this composite, not the
// raw token.
function compositeHex(tile: string, background: string): string {
  const alpha = Number.parseInt(tile.slice(7, 9), 16) / 255;
  const [r, g, b] = expandHex(tile.slice(0, 7));
  const [bgR, bgG, bgB] = expandHex(background);
  const channels = [
    Math.round(r * alpha + bgR * (1 - alpha)),
    Math.round(g * alpha + bgG * (1 - alpha)),
    Math.round(b * alpha + bgB * (1 - alpha)),
  ];
  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

// An alpha token (`rgba(…)`) flattened onto the surface it paints on, so a
// stroke such as `--ring-track` can be measured against the page it sits on.
function compositeToken(token: string, background: string): string {
  if (token.startsWith('#')) {
    return token;
  }
  const match = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(token);
  if (!match) {
    throw new Error(`expected #rrggbb or rgba(), got ${token}`);
  }
  const alpha = Number(match[4]);
  const [bgR, bgG, bgB] = expandHex(background);
  const channels = [
    Math.round(Number(match[1]) * alpha + bgR * (1 - alpha)),
    Math.round(Number(match[2]) * alpha + bgG * (1 - alpha)),
    Math.round(Number(match[3]) * alpha + bgB * (1 - alpha)),
  ];
  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

describe('muted-foreground token contrast (WCAG AA text)', () => {
  // `secondary` is included because it is the surface of the switch rows in
  // preferences-screen and notifications-screen, where a muted title is the
  // disabled cue.
  it('light theme: >= 4.5:1 against background, card, and secondary', () => {
    const surfaces = {
      background: lightColors.background,
      card: lightColors.card,
      secondary: lightColors.secondary,
    } as const;
    for (const [name, surface] of Object.entries(surfaces)) {
      const ratio = contrastRatio(lightColors.mutedForeground, surface);
      expect(ratio, `muted-foreground vs ${name} (light)`).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
    }
  });

  it('dark theme: >= 4.5:1 against background, card, and secondary', () => {
    const surfaces = {
      background: darkColors.background,
      card: darkColors.card,
      secondary: darkColors.secondary,
    } as const;
    for (const [name, surface] of Object.entries(surfaces)) {
      const ratio = contrastRatio(darkColors.mutedForeground, surface);
      expect(ratio, `muted-foreground vs ${name} (dark)`).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
    }
  });
});

describe('auto-merge banner copy contrast (WCAG AA text)', () => {
  // The banner's description paints `text-ink2` on `bg-accent-soft-tint`, the
  // accent at 16% over the page. The muted foreground reads as a quiet second
  // line here but measures under 4.5:1 on this surface, so the pair is guarded
  // on the composite the text actually renders on.
  const themes = [
    ['light', lightColors],
    ['dark', darkColors],
  ] as const;

  it('every theme: ink2 on the accent tint clears 4.5:1', () => {
    for (const [themeName, colors] of themes) {
      const tint = compositeHex(colors.accentSoftTint, colors.background);
      expect(
        contrastRatio(colors.ink2, tint),
        `ink2 vs accent tint (${themeName})`
      ).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
    }
  });
});

describe('status token contrast on light surfaces (WCAG AA text)', () => {
  // Status tokens are read as text on the app background (screens) and on
  // `secondary` (status chips/cards). `global.css` keeps `--good` /
  // `--warn` / `--destructive` / `--info` in lockstep with these TS values.
  const statusTokens = {
    good: lightColors.good,
    warn: lightColors.warn,
    destructive: lightColors.destructive,
    info: lightColors.info,
  } as const;
  const surfaces = {
    background: lightColors.background,
    secondary: lightColors.secondary,
  } as const;

  it('light theme: >= 4.5:1 for every status token on background and secondary', () => {
    for (const [token, color] of Object.entries(statusTokens)) {
      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        const ratio = contrastRatio(color, surface);
        expect(ratio, `${token} vs ${surfaceName} (light)`).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
      }
    }
  });
});

describe('light diff token contrast on tinted surfaces (WCAG AA text)', () => {
  // The diff renderer paints token colors as inline text style on top of the
  // tinted tiles in `global.css` (`--good-tile-bg` / `--danger-tile-bg` = the
  // status hue at 10% alpha over the theme background), so every light token
  // must clear 4.5:1 on the composite surfaces, not just on plain background.
  const surfaces = {
    plain: lightColors.background,
    goodTile: compositeHex(`${lightColors.good}1a`, lightColors.background),
    dangerTile: compositeHex(`${lightColors.destructive}1a`, lightColors.background),
  } as const;

  const lightTokens: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(TOKEN_DARK_LIGHT).map(([name, pair]) => [name, pair.light])
    ),
    default: DEFAULT_TOKEN_COLOR.light,
    muted: MUTED_COLOR.light,
  };

  it('every light token clears 4.5:1 on plain, good-tile, and danger-tile', () => {
    for (const [token, color] of Object.entries(lightTokens)) {
      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        const ratio = contrastRatio(color, surface);
        expect(ratio, `${token} (${color}) vs ${surfaceName} (light)`).toBeGreaterThanOrEqual(
          MIN_TEXT_RATIO
        );
      }
    }
  });
});

// Tailwind v4's `neutral-200` / `neutral-800` (oklch(92.2% 0 0) /
// oklch(26.9% 0 0)) as sRGB. They are the badge surface the model chip's
// thinking-effort label paints on (`bg-neutral-200 dark:bg-neutral-800`).
const NEUTRAL_200 = '#e5e5e5';
const NEUTRAL_800 = '#262626';

describe('disabled toolbar badge label contrast (WCAG AA text)', () => {
  // While the toolbar is shown disabled, every label must clear 4.5:1; the
  // dim-only-chevron/icon rule does not cover the thinking-effort badge's
  // text. `text-muted-foreground` on these surfaces measures ~4.26:1 light
  // and ~4.18:1 dark, so the label uses `text-foreground` instead.
  it('light theme: foreground vs the neutral-200 badge >= 4.5:1', () => {
    expect(contrastRatio(lightColors.foreground, NEUTRAL_200)).toBeGreaterThanOrEqual(
      MIN_TEXT_RATIO
    );
  });

  it('dark theme: foreground vs the neutral-800 badge >= 4.5:1', () => {
    expect(contrastRatio(darkColors.foreground, NEUTRAL_800)).toBeGreaterThanOrEqual(
      MIN_TEXT_RATIO
    );
  });
});

describe('disabled primary fill contrast (WCAG AA text)', () => {
  // A disabled default-variant Button paints primaryForeground on
  // `--primary-disabled` in light, where the pair clears 4.5:1. Dark instead
  // paints the inactive control surface, because `--primary-disabled` there is
  // a light neutral that outshines the near-black page; its label takes
  // `--ink2` and that pair must clear 4.5:1 too.
  it('light theme: primaryForeground vs primaryDisabled >= 4.5:1', () => {
    const ratio = contrastRatio(lightColors.primaryForeground, lightColors.primaryDisabled);
    expect(ratio).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
  });

  it('dark theme: ink2 vs controlIdle >= 4.5:1', () => {
    const ratio = contrastRatio(darkColors.ink2, darkColors.controlIdle);
    expect(ratio).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
  });

  it('dark theme: the disabled fill stays distinguishable from the enabled brand fill', () => {
    // The disabled fill is the inactive control surface: it must read as a
    // superseded control next to the enabled brand fill, not as a second brand
    // colour, or a disabled Start would look tappable and an enabled one would
    // lose its emphasis.
    const separation = contrastRatio(darkColors.primary, darkColors.controlIdle);
    expect(separation).toBeGreaterThanOrEqual(1.5);
  });
});

describe('selected tab pill contrast (WCAG AA text)', () => {
  // An in-page tab paints `--selection-foreground` on `--selection`. The fill is
  // the light theme's olive at the value the dark page needs: the dark accent
  // (#ffdd00) as a full pill glares on the dark page, and the unlifted light
  // value recedes into it, so dark mode lifts the same hue and must not fall
  // back to the accent.
  it('light theme: selectionForeground vs selection >= 4.5:1', () => {
    const ratio = contrastRatio(lightColors.selectionForeground, lightColors.selection);
    expect(ratio).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
  });

  it('dark theme: selectionForeground vs selection >= 4.5:1', () => {
    const ratio = contrastRatio(darkColors.selectionForeground, darkColors.selection);
    expect(ratio).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
  });

  it('dark theme: the selected fill is not the dark accent', () => {
    expect(darkColors.selection).not.toBe(darkColors.primary);
  });

  // The fill is the selected state's own indicator, so WCAG 1.4.11 asks for 3:1
  // against the page it sits on and against `secondary`, the unselected fill of
  // the pill and the row surface under the tab. A value that clears the label
  // but recedes into the dark page leaves the selection unreadable.
  it('dark theme: the selected fill stands >= 3:1 off the page and off secondary', () => {
    expect(contrastRatio(darkColors.selection, darkColors.background)).toBeGreaterThanOrEqual(
      MIN_NON_TEXT_RATIO
    );
    expect(contrastRatio(darkColors.selection, darkColors.secondary)).toBeGreaterThanOrEqual(
      MIN_NON_TEXT_RATIO
    );
  });
});

describe('warn foreground token contrast (WCAG AA text)', () => {
  it('light theme: warnForeground vs warn >= 4.5:1', () => {
    // Precomputed ≈ 5.30:1 for #FFFFFF on #956011.
    const ratio = contrastRatio(lightColors.warnForeground, lightColors.warn);
    expect(ratio).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
  });

  it('dark theme: warnForeground vs warn >= 4.5:1', () => {
    // Precomputed ≈ 9.29:1 for #1A1A10 on #F2B05F.
    const ratio = contrastRatio(darkColors.warnForeground, darkColors.warn);
    expect(ratio).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
  });
});

describe('row palette contrast (WCAG 1.4.11 non-text)', () => {
  // A 16px stroked glyph on a 30x30 tile is a non-text graphic, so WCAG 1.4.11
  // asks for 3:1: measured against the row surface (`secondary`) and against the
  // pre-tinted tile the glyph paints on (the hue at 10% alpha over `secondary`).
  const themes = [
    ['light', lightColors],
    ['dark', darkColors],
  ] as const;

  it('every curated step clears 3:1 on secondary and on its tinted tile', () => {
    for (const [themeName, colors] of themes) {
      for (const [step, tint] of Object.entries(ROW_PALETTE)) {
        const hue = colors[tint.hueThemeKey];
        const tile = compositeHex(`${hue}1a`, colors.secondary);
        expect(
          contrastRatio(hue, colors.secondary),
          `${step} vs secondary (${themeName})`
        ).toBeGreaterThanOrEqual(MIN_NON_TEXT_RATIO);
        expect(contrastRatio(hue, tile), `${step} vs tile (${themeName})`).toBeGreaterThanOrEqual(
          MIN_NON_TEXT_RATIO
        );
      }
    }
  });
});

describe('idle composer control and ring track contrast (non-text)', () => {
  // Two dark-mode surfaces the light theme already carries: the composer's send
  // circle while there is nothing to send, and the track under the context-usage
  // ring's arc. Both painted the light theme's neutral and hairline tint, which
  // sit within 1.2:1 of the near-black page and left the disc and the ring
  // invisible. The floors below are perception floors, not a WCAG bar: the fill
  // and the track must read as objects on the page, and the ring track must stay
  // under the neutral arc so a part-filled arc still reads as a fraction.
  const MIN_VISIBLE_SURFACE_RATIO = 1.6;
  const themes = [
    ['light', lightColors],
    ['dark', darkColors],
  ] as const;

  it('dark theme: the idle send fill clears a visible step above the page', () => {
    expect(contrastRatio(darkColors.controlIdle, darkColors.background)).toBeGreaterThanOrEqual(
      MIN_VISIBLE_SURFACE_RATIO
    );
  });

  it('every theme: the idle send arrow clears 3:1 on its own fill', () => {
    for (const [themeName, colors] of themes) {
      expect(
        contrastRatio(colors.mutedForeground, colors.controlIdle),
        `muted-foreground vs control-idle (${themeName})`
      ).toBeGreaterThanOrEqual(MIN_NON_TEXT_RATIO);
    }
  });

  it('dark theme: the ring track reads on its pill and stays under the neutral arc', () => {
    // The header pill's own surface is `secondary`, so the track is measured
    // over that, not over the page.
    const track = compositeToken(darkColors.ringTrack, darkColors.secondary);
    const trackRatio = contrastRatio(track, darkColors.secondary);
    expect(trackRatio).toBeGreaterThanOrEqual(MIN_VISIBLE_SURFACE_RATIO);
    expect(trackRatio).toBeLessThan(
      contrastRatio(darkColors.mutedForeground, darkColors.secondary)
    );
  });
});

describe('disabled switch pair contrast (non-text)', () => {
  // The shared switch paints this pair for a disabled control on Android, in
  // place of the brand on-track: `primary-disabled` under a grip that sits
  // below it in strength for the on position, `muted-soft` with the mid neutral
  // grip for the off one. iOS keeps the brand pair and fades it itself. The
  // switch sits on a `secondary` row, so its tracks are measured over that. The
  // floors are perception floors: the pair has to read as a control and the two
  // positions have to stay apart. Light has no third neutral for the off track
  // — `control-idle` equals `secondary` there — so the disabled off track is
  // the same neutral as the enabled off track, and only its grip dims.
  const MIN_VISIBLE_SURFACE_RATIO = 1.6;
  // [theme, palette, the grip the switch paints on the on track]. The on grip
  // is the one colour a disabled pair cannot share with its enabled one: the
  // scheme's on ink is what marks a control that still works.
  const themes = [
    ['light', lightColors, lightColors.primaryForeground],
    ['dark', darkColors, darkColors.mutedSoft],
  ] as const;

  it('every theme: the disabled off track reads on the row surface', () => {
    for (const [themeName, colors] of themes) {
      expect(
        contrastRatio(colors.mutedSoft, colors.secondary),
        `muted-soft vs secondary (${themeName})`
      ).toBeGreaterThanOrEqual(MIN_VISIBLE_SURFACE_RATIO);
    }
  });

  it('every theme: the disabled on track stays apart from the disabled off track', () => {
    for (const [themeName, colors] of themes) {
      expect(
        contrastRatio(colors.primaryDisabled, colors.mutedSoft),
        `primary-disabled vs muted-soft (${themeName})`
      ).toBeGreaterThanOrEqual(MIN_VISIBLE_SURFACE_RATIO);
    }
  });

  it('every theme: the disabled off grip reads on its own track', () => {
    for (const [themeName, colors] of themes) {
      expect(
        contrastRatio(colors.mutedForeground, colors.mutedSoft),
        `muted-foreground vs muted-soft (${themeName})`
      ).toBeGreaterThanOrEqual(MIN_VISIBLE_SURFACE_RATIO);
    }
  });

  it('every theme: the disabled on grip reads on its own track', () => {
    for (const [themeName, colors, onGrip] of themes) {
      expect(
        contrastRatio(onGrip, colors.primaryDisabled),
        `on grip vs primary-disabled (${themeName})`
      ).toBeGreaterThanOrEqual(MIN_VISIBLE_SURFACE_RATIO);
    }
  });

  // Regression: the disabled on grip once fell back to `primaryForeground` in
  // both schemes, which dark defines as the near-black card colour. Android's
  // thumb is wider than the track, so its outer arc lands on the row itself —
  // 1.1:1 there, and the dark scheme draws no shadow to outline it, so what
  // remained of the pill read as a blank grey bar. The dark grip is the mid
  // neutral instead: darker than its fill, and still a visible step off the
  // near-black row its arc sits on.
  it('dark theme: the disabled on grip reads on the row its arc overhangs', () => {
    expect(
      contrastRatio(darkColors.mutedSoft, darkColors.secondary),
      'muted-soft vs secondary (dark)'
    ).toBeGreaterThanOrEqual(MIN_VISIBLE_SURFACE_RATIO);
  });
});

// The `secondary` button variant paints `--secondary-fill`. It used to paint
// `--secondary`, which is also the dark card an `outline` control paints, so in
// the dark scheme a filled action and the outlined control beside it (the
// discard-draft sheet's Save as to-do and Keep editing) rendered one colour.
describe('filled neutral action contrast (non-text)', () => {
  const MIN_VISIBLE_SURFACE_RATIO = 1.6;

  it('dark theme: the filled action reads on the card and apart from the outlined fill', () => {
    for (const surface of [darkColors.card, darkColors.secondary]) {
      expect(contrastRatio(darkColors.secondaryFill, surface)).toBeGreaterThanOrEqual(
        MIN_VISIBLE_SURFACE_RATIO
      );
    }
  });

  it('light theme: the filled action keeps the surface it has always painted', () => {
    expect(lightColors.secondaryFill).toBe(lightColors.secondary);
  });

  it('every theme: the filled action label clears 4.5:1 on its own fill', () => {
    for (const colors of [lightColors, darkColors]) {
      expect(
        contrastRatio(colors.secondaryForeground, colors.secondaryFill)
      ).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
    }
  });
});
