const KILO_AI_BASE = (process.env.KILO_AI_BASE_URL ?? 'https://kilo.ai').replace(/\/$/, '');

export const INSTALL_SOURCES = {
  byte: {
    label: 'ClawByte',
    urlTemplate: `${KILO_AI_BASE}/kiloclaw/bytes/{slug}/data.json`,
  },
} as const;

export type InstallSource = keyof typeof INSTALL_SOURCES;

// Tuple of registered source keys for `z.enum(...)` input validation on the
// `installFromSource` tRPC mutation. Derived from the registry so adding a
// new source is a one-line change here, not two. The cast is sound at
// runtime — INSTALL_SOURCES always has at least one entry.
export const INSTALL_SOURCE_KEYS = Object.keys(INSTALL_SOURCES) as [
  InstallSource,
  ...InstallSource[],
];

export function isInstallSource(value: string): value is InstallSource {
  // Own-property check (not `value in`) so inherited names like `toString`
  // or `hasOwnProperty` can't pass the guard and then crash the lookup.
  return Object.hasOwn(INSTALL_SOURCES, value);
}
