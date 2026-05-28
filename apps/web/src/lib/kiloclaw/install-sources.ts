const KILO_AI_BASE = (process.env.KILO_AI_BASE_URL ?? 'https://kilo.ai').replace(/\/$/, '');

export const INSTALL_SOURCES = {
  byte: {
    label: 'ClawByte',
    urlTemplate: `${KILO_AI_BASE}/kiloclaw/bytes/{slug}/data.json`,
  },
} as const;

export type InstallSource = keyof typeof INSTALL_SOURCES;

export const INSTALL_SOURCE_KEYS = Object.keys(INSTALL_SOURCES) as InstallSource[];

export function isInstallSource(value: string): value is InstallSource {
  return value in INSTALL_SOURCES;
}
