/**
 * Writes Kilo CLI (opencode.json) config to disk on controller startup.
 *
 * Gated by KILOCLAW_KILO_CLI feature flag. On fresh installs, creates
 * the config. On every boot, patches base URL for local dev.
 *
 * The Kilo CLI's built-in "kilo" provider auto-activates when KILO_API_KEY
 * is set in the environment (via KiloAuthPlugin). The config file only needs
 * permission settings and optional model/baseUrl overrides — no provider
 * block needed.
 *
 * Uses /root/.config/kilo/ explicitly because OpenClaw changes HOME
 * to the workspace dir at runtime.
 */
import fs from 'node:fs';
import path from 'node:path';

export const KILO_CONFIG_DIR = '/root/.config/kilo';
export const CONFIG_FILE = 'opencode.json';

/** The Kilo CLI uses `kilo/` as the provider prefix, but KiloClaw uses `kilocode/`. */
export function toKiloModelId(kilocodeModelId: string): string {
  if (kilocodeModelId.startsWith('kilocode/')) {
    return 'kilo/' + kilocodeModelId.slice('kilocode/'.length);
  }
  return kilocodeModelId;
}

export type KiloCliConfigDeps = {
  mkdirSync: (dir: string, opts: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string, opts: { mode: number }) => void;
  readFileSync: (path: string, encoding: 'utf8') => string;
  existsSync: (path: string) => boolean;
};

const defaultDeps: KiloCliConfigDeps = {
  mkdirSync: (dir, opts) => fs.mkdirSync(dir, opts),
  writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
  existsSync: p => fs.existsSync(p),
};

export function writeKiloCliConfig(
  env: Record<string, string | undefined> = process.env,
  configDir = KILO_CONFIG_DIR,
  deps: KiloCliConfigDeps = defaultDeps
): boolean {
  // Gate on feature flag
  if (env.KILOCLAW_KILO_CLI !== 'true') return false;

  const configPath = path.join(configDir, CONFIG_FILE);
  if (!env.KILOCODE_API_KEY) return false;

  const isFreshInstall = env.KILOCLAW_FRESH_INSTALL === 'true';

  // Seed config on fresh install only.
  // No provider block needed — the KiloAuthPlugin auto-registers the "kilo"
  // provider when KILO_API_KEY is in the environment (set by bootstrap).
  if (isFreshInstall && !deps.existsSync(configPath)) {
    const config: Record<string, unknown> = {
      $schema: 'https://app.kilo.ai/config.json',
      permission: { edit: 'allow', bash: 'allow' },
    };
    if (env.KILOCODE_DEFAULT_MODEL) {
      config.model = toKiloModelId(env.KILOCODE_DEFAULT_MODEL);
    }
    deps.mkdirSync(configDir, { recursive: true });
    deps.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log('[kilo-cli] Seeded config at ' + configPath);
  }

  // Patch config on every boot (if it exists).
  if (deps.existsSync(configPath)) {
    try {
      // JSON structure is open-ended (user may add arbitrary keys), so we use `any`
      // rather than a strict schema.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config: any = JSON.parse(deps.readFileSync(configPath, 'utf8'));
      let dirty = false;

      // Remove any stale provider.kilo.options.baseURL from the config file.
      // Setting baseURL in opencode.json is broken (the Kilo CLI ignores it
      // in certain code paths). The correct mechanism is the KILO_API_URL env
      // var, which bootstrap sets from KILOCODE_API_BASE_URL. Early deployments
      // may still have the broken field, so we scrub it on every boot.
      if (config.provider?.kilo?.options?.baseURL) {
        delete config.provider.kilo.options.baseURL;
        dirty = true;
      }

      // Sync Kilo CLI's model with the user's KiloClaw default model.
      // Updated on every boot so model changes in KiloClaw settings take effect.
      const defaultModel = env.KILOCODE_DEFAULT_MODEL;
      if (defaultModel) {
        config.model = toKiloModelId(defaultModel);
        dirty = true;
      }

      if (dirty) {
        deps.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      }
    } catch (err) {
      console.error('[kilo-cli] Failed to patch config (corrupt JSON?), skipping:', err);
    }
  }

  return true;
}
