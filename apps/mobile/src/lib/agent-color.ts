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
