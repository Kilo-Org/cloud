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

const KILO_CONFIG_DIR = '/root/.config/kilo';
const CONFIG_FILE = 'opencode.json';

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
    const config = {
      $schema: 'https://app.kilo.ai/config.json',
      permission: { edit: 'allow', bash: 'allow' },
    };
    deps.mkdirSync(configDir, { recursive: true });
    deps.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log('[kilo-cli] Seeded config at ' + configPath);
  }

  // Patch config on every boot (if it exists).
  // Only writes when a change is actually made to avoid silent no-op writes.
  if (deps.existsSync(configPath) && env.KILOCODE_API_BASE_URL) {
    try {
      // JSON structure is open-ended (user may add arbitrary keys), so we use `any`
      // rather than a strict schema. The patch only touches provider.kilo.options.baseURL.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config: any = JSON.parse(deps.readFileSync(configPath, 'utf8'));

      // Override the kilo provider's base URL for local dev (e.g., ngrok tunnel).
      // In production this env var is not set and the built-in default is used.
      config.provider = config.provider || {};
      config.provider.kilo = config.provider.kilo || {};
      config.provider.kilo.options = config.provider.kilo.options || {};
      delete config.provider.kilo.options.baseURL;

      deps.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error('[kilo-cli] Failed to patch config (corrupt JSON?), skipping:', err);
    }
  }

  return true;
}
