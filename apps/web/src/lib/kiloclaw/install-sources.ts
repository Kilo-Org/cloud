const KILO_AI_BASE = (process.env.KILO_AI_BASE_URL ?? 'https://kilo.ai').replace(/\/$/, '');

export const INSTALL_SOURCES = {
  byte: {
    label: 'ClawByte',
    urlTemplate: `${KILO_AI_BASE}/kiloclaw/bytes/{slug}/data.json`,
  },
} as const;

export type InstallSource = keyof typeof INSTALL_SOURCES;

export function isInstallSource(value: string): value is InstallSource {
  // Own-property check (not `value in`) so inherited names like `toString`
  // or `hasOwnProperty` can't pass the guard and then crash the lookup.
  return Object.hasOwn(INSTALL_SOURCES, value);
}
