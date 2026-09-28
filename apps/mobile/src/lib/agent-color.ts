import { type ThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * Tint — a `{hue, tile-bg, tile-border}` triple used for colored icon
 * tiles, row strips, and eyebrow labels. Agents hash a stable name into
 * the curated ramp; semantic tones (good / warn / danger) use `toneColor`.
 *
 * Class names are declared as string literals (never template-constructed)
 * so NativeWind's static scanner picks them up and compiles the styles.
 */
export type Tint = {
  /** Tailwind class e.g. 'bg-agent-yuki' / 'bg-good'. */
  hueClass: string;
  /** Tailwind class e.g. 'text-agent-yuki' / 'text-good'. */
  hueTextClass: string;
  /** Tailwind class e.g. 'border-agent-yuki' / 'border-good'. */
  hueBorderClass: string;
  /** Tailwind class e.g. 'bg-agent-yuki-tile-bg' (10% alpha). */
  tileBgClass: string;
  /** Tailwind class e.g. 'border-agent-yuki-tile-border' (20% alpha). */
  tileBorderClass: string;
  /** Lookup key into useThemeColors() for Lucide/SVG color strings. */
  hueThemeKey: keyof ThemeColors;
};

// Curated ramp — hash of an agent name is modulo'd against this tuple so
// every agent (named or unnamed) renders an on-palette color.
const AGENT_RAMP = [
  {
    hueClass: 'bg-agent-cloud',
    hueTextClass: 'text-agent-cloud',
    hueBorderClass: 'border-agent-cloud',
    tileBgClass: 'bg-agent-cloud-tile-bg',
    tileBorderClass: 'border-agent-cloud-tile-border',
    hueThemeKey: 'agentCloud',
  },
  {
    hueClass: 'bg-agent-yuki',
    hueTextClass: 'text-agent-yuki',
    hueBorderClass: 'border-agent-yuki',
    tileBgClass: 'bg-agent-yuki-tile-bg',
    tileBorderClass: 'border-agent-yuki-tile-border',
    hueThemeKey: 'agentYuki',
  },
  {
    hueClass: 'bg-agent-kilocode',
    hueTextClass: 'text-agent-kilocode',
    hueBorderClass: 'border-agent-kilocode',
    tileBgClass: 'bg-agent-kilocode-tile-bg',
    tileBorderClass: 'border-agent-kilocode-tile-border',
    hueThemeKey: 'agentKilocode',
  },
  {
    hueClass: 'bg-agent-coral',
    hueTextClass: 'text-agent-coral',
    hueBorderClass: 'border-agent-coral',
    tileBgClass: 'bg-agent-coral-tile-bg',
    tileBorderClass: 'border-agent-coral-tile-border',
    hueThemeKey: 'agentCoral',
  },
  {
    hueClass: 'bg-agent-sky',
    hueTextClass: 'text-agent-sky',
    hueBorderClass: 'border-agent-sky',
    tileBgClass: 'bg-agent-sky-tile-bg',
    tileBorderClass: 'border-agent-sky-tile-border',
    hueThemeKey: 'agentSky',
  },
  {
    hueClass: 'bg-agent-workclaw',
    hueTextClass: 'text-agent-workclaw',
    hueBorderClass: 'border-agent-workclaw',
    tileBgClass: 'bg-agent-workclaw-tile-bg',
    tileBorderClass: 'border-agent-workclaw-tile-border',
    hueThemeKey: 'agentWorkclaw',
  },
] as const satisfies readonly Tint[];

export type ToneKey = 'good' | 'warn' | 'danger';

const TONES = {
  good: {
    hueClass: 'bg-good',
    hueTextClass: 'text-good',
    hueBorderClass: 'border-good',
    tileBgClass: 'bg-good-tile-bg',
    tileBorderClass: 'border-good-tile-border',
    hueThemeKey: 'good',
  },
  warn: {
    hueClass: 'bg-warn',
    hueTextClass: 'text-warn',
    hueBorderClass: 'border-warn',
    tileBgClass: 'bg-warn-tile-bg',
    tileBorderClass: 'border-warn-tile-border',
    hueThemeKey: 'warn',
  },
  danger: {
    hueClass: 'bg-destructive',
    hueTextClass: 'text-destructive',
    hueBorderClass: 'border-destructive',
    tileBgClass: 'bg-danger-tile-bg',
    tileBorderClass: 'border-danger-tile-border',
    hueThemeKey: 'destructive',
  },
} as const satisfies Record<ToneKey, Tint>;

/** Semantic tone — good / warn / danger. */
export function toneColor(key: ToneKey): Tint {
  return TONES[key];
}

/** Deterministic agent hue from the agent name. */
export function agentColor(name: string): Tint {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    const cp = name.codePointAt(i) ?? 0;
    hash = Math.trunc(hash * 31 + cp) % 2_147_483_647;
  }
  const index = Math.abs(hash) % AGENT_RAMP.length;
  // Tuple type guarantees element at every index in [0, length), so
  // flow-sensitive indexing resolves without `!`.
  return AGENT_RAMP[index] ?? AGENT_RAMP[0];
}

/**
 * Curated row-hue palette — the logo yellow's own family.
 *
 * A menu row identifies a *destination*, so its colour is chosen once, here,
 * and passed explicitly. It is never derived from a label, title, translation
 * or hash of a string: the same row renders the same hue in every language.
 *
 * The rule: six steps walk the logo yellow's own warm band (50deg -> 105deg,
 * an 11deg step) at one fixed chroma/value per theme, straddling the brand hue
 * (`--primary` olive `#4f5a10`, h~71, and the yellow `#e8f27a`). The status
 * hues sit outside the band (danger 8deg, warn 37deg, good 150deg, info
 * 220deg), so no curated step can be mistaken for a status colour.
 *
 * Destination table (profile sections, reading order):
 *
 * | Section         | Destinations                        | Step  |
 * | --------------- | ----------------------------------- | ----- |
 * | Agents          | Code Reviewer, Security Agent       | honey |
 * | Reviews         | PR Review                           | gold  |
 * | Organization    | Manage/View organization            | lime  |
 * | App             | Preferences, Tutorial               | sage  |
 * | Linked accounts | provider rows                       | moss  |
 * | Actions         | Feedback, Privacy choices, Sign out | fern  |
 * | reserved        | Delete account                      | `danger` tone, never a family step |
 *
 * Growth rule: a new row takes its section's step; a new section takes the next
 * step in reading order; when the walk passes `fern`, extend the family one
 * 11deg step toward the cool end and register the token the same way. A
 * destination never takes a hue from a label, title, translation or hash, and
 * never a status hue.
 */
export type RowHue = 'honey' | 'gold' | 'lime' | 'sage' | 'moss' | 'fern';

export const ROW_PALETTE = {
  honey: {
    hueClass: 'bg-row-honey',
    hueTextClass: 'text-row-honey',
    hueBorderClass: 'border-row-honey',
    tileBgClass: 'bg-row-honey-tile-bg',
    tileBorderClass: 'border-row-honey-tile-border',
    hueThemeKey: 'rowHoney',
  },
  gold: {
    hueClass: 'bg-row-gold',
    hueTextClass: 'text-row-gold',
    hueBorderClass: 'border-row-gold',
    tileBgClass: 'bg-row-gold-tile-bg',
    tileBorderClass: 'border-row-gold-tile-border',
    hueThemeKey: 'rowGold',
  },
  lime: {
    hueClass: 'bg-row-lime',
    hueTextClass: 'text-row-lime',
    hueBorderClass: 'border-row-lime',
    tileBgClass: 'bg-row-lime-tile-bg',
    tileBorderClass: 'border-row-lime-tile-border',
    hueThemeKey: 'rowLime',
  },
  sage: {
    hueClass: 'bg-row-sage',
    hueTextClass: 'text-row-sage',
    hueBorderClass: 'border-row-sage',
    tileBgClass: 'bg-row-sage-tile-bg',
    tileBorderClass: 'border-row-sage-tile-border',
    hueThemeKey: 'rowSage',
  },
  moss: {
    hueClass: 'bg-row-moss',
    hueTextClass: 'text-row-moss',
    hueBorderClass: 'border-row-moss',
    tileBgClass: 'bg-row-moss-tile-bg',
    tileBorderClass: 'border-row-moss-tile-border',
    hueThemeKey: 'rowMoss',
  },
  fern: {
    hueClass: 'bg-row-fern',
    hueTextClass: 'text-row-fern',
    hueBorderClass: 'border-row-fern',
    tileBgClass: 'bg-row-fern-tile-bg',
    tileBorderClass: 'border-row-fern-tile-border',
    hueThemeKey: 'rowFern',
  },
} as const satisfies Record<RowHue, Tint>;

/** Curated destination hue for a profile row. */
export function rowTint(hue: RowHue): Tint {
  return ROW_PALETTE[hue];
}
