/**
 * Town configuration management.
 */

import { TownConfigSchema, type TownConfig, type TownConfigUpdate } from '../../types';

const CONFIG_KEY = 'town:config';

const TOWN_LOG = '[Town.do]';

export async function getTownConfig(storage: DurableObjectStorage): Promise<TownConfig> {
  const raw = await storage.get<unknown>(CONFIG_KEY);
  if (!raw) return TownConfigSchema.parse({});
  return TownConfigSchema.parse(raw);
}

export async function updateTownConfig(
  storage: DurableObjectStorage,
  update: TownConfigUpdate
): Promise<TownConfig> {
  const current = await getTownConfig(storage);

  // env_vars: full replacement semantics. Masked values (starting with "****")
  // from the server's masking layer are preserved to avoid overwriting secrets.
  let resolvedEnvVars = current.env_vars;
  if (update.env_vars) {
    resolvedEnvVars = {};
    for (const [key, value] of Object.entries(update.env_vars)) {
      resolvedEnvVars[key] = value.startsWith('****') ? (current.env_vars[key] ?? value) : value;
    }
  }

  const merged: TownConfig = {
    ...current,
    ...update,
    env_vars: resolvedEnvVars,
    git_auth: { ...current.git_auth, ...(update.git_auth ?? {}) },
    refinery:
      update.refinery !== undefined
        ? { ...current.refinery, ...update.refinery }
        : current.refinery,
    container:
      update.container !== undefined
        ? { ...current.container, ...update.container }
        : current.container,
  };

  const validated = TownConfigSchema.parse(merged);
  await storage.put(CONFIG_KEY, validated);
  console.log(
    `${TOWN_LOG} updateTownConfig: saved config with ${Object.keys(validated.env_vars).length} env vars`
  );
  return validated;
}

/**
 * Resolve the model for an agent role from town config.
 * Priority: rig override → role-specific → town default → hardcoded default.
 */
export function resolveModel(townConfig: TownConfig, _rigId: string, _role: string): string {
  // OPEN QUESTION: Should we add rig_overrides to TownConfig?
  // For now, just use the town default.
  return townConfig.default_model ?? 'anthropic/claude-sonnet-4.6';
}

/**
 * Build the ContainerConfig payload for X-Town-Config header.
 * Sent with every fetch() to the container.
 */
export async function buildContainerConfig(
  storage: DurableObjectStorage,
  env: Env
): Promise<Record<string, unknown>> {
  const config = await getTownConfig(storage);
  return {
    env_vars: config.env_vars,
    default_model: config.default_model ?? 'anthropic/claude-sonnet-4.6',
    git_auth: config.git_auth,
    kilocode_token: config.kilocode_token,
    kilo_api_url: env.KILO_API_URL ?? '',
    gastown_api_url: env.GASTOWN_API_URL ?? '',
  };
}
