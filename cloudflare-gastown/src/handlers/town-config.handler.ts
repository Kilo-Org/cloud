import type { Context } from 'hono';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import type { GastownEnv } from '../gastown.worker';
import { TownConfigUpdateSchema, type TownConfig } from '../types';

const LOG = '[town-config.handler]';

export async function handleGetTownConfig(c: Context<GastownEnv>, params: { townId: string }) {
  const townDO = getTownDOStub(c.env, params.townId);
  const config = await townDO.getTownConfig();
  return c.json(resSuccess(maskSensitiveValues(config)));
}

export async function handleUpdateTownConfig(c: Context<GastownEnv>, params: { townId: string }) {
  const body = await parseJsonBody(c);
  const parsed = TownConfigUpdateSchema.safeParse(body);
  if (!parsed.success) {
    console.error(`${LOG} handleUpdateTownConfig: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  // Validate env var key names: alphanumeric + underscore, no reserved prefixes
  if (parsed.data.env_vars) {
    for (const key of Object.keys(parsed.data.env_vars)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return c.json(
          resError(`Invalid env var key "${key}": must be alphanumeric with underscores`),
          400
        );
      }
      if (key.startsWith('GASTOWN_')) {
        return c.json(resError(`Env var key "${key}" uses reserved GASTOWN_ prefix`), 400);
      }
    }
  }

  const townDO = getTownDOStub(c.env, params.townId);
  const config = await townDO.updateTownConfig(parsed.data);
  console.log(`${LOG} handleUpdateTownConfig: town=${params.townId} updated config`);
  return c.json(resSuccess(maskSensitiveValues(config)));
}

/**
 * Get the raw (unmasked) town config. Used internally by the Rig DO
 * dispatch path — not exposed to dashboards.
 */
export async function handleGetTownConfigInternal(
  c: Context<GastownEnv>,
  params: { townId: string }
) {
  const townDO = getTownDOStub(c.env, params.townId);
  const config = await townDO.getTownConfig();
  return c.json(resSuccess(config));
}

// Mask token values: show only last 4 chars
function maskToken(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.length <= 4) return '****';
  return '****' + value.slice(-4);
}

function maskSensitiveValues(config: TownConfig): TownConfig {
  const envVars = { ...config.env_vars };
  for (const [key, value] of Object.entries(envVars)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('token') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('password') ||
      lowerKey.includes('key') ||
      lowerKey.includes('auth')
    ) {
      envVars[key] = maskToken(value) ?? '';
    }
  }

  return {
    ...config,
    env_vars: envVars,
    git_auth: {
      ...config.git_auth,
      github_token: maskToken(config.git_auth.github_token),
      gitlab_token: maskToken(config.git_auth.gitlab_token),
    },
  };
}
