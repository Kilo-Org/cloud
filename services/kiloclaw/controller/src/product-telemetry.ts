/**
 * Collects product telemetry from the live openclaw config.
 *
 * Read from disk once per invocation (~every 24h). All fields have safe
 * defaults so callers never see an exception.
 *
 * Each top-level section is parsed independently so a malformed `tools`
 * block (for example) does not zero out unrelated fields like `defaultModel`.
 */
import fs from 'node:fs';
import { z } from 'zod';
import { detectChannels } from './pairing-cache';

export { detectChannels };

const CONFIG_PATH = '/root/.openclaw/openclaw.json';

export type ProductTelemetry = {
  openclawVersion: string | null;
  defaultModel: string | null;
  channelCount: number;
  enabledChannels: string[];
  toolsProfile: string | null;
  execSecurity: string | null;
  browserEnabled: boolean;
  googleLegacyMigrationAttempted?: boolean;
  googleLegacyMigrationSucceeded?: boolean;
  googleLegacyMigrationFailureReason?: string | null;
};

export type ProductTelemetryExtras = {
  googleLegacyMigrationAttempted?: boolean;
  googleLegacyMigrationSucceeded?: boolean;
  googleLegacyMigrationFailureReason?: string | null;
};

// Per-section schemas — each is parsed independently so one bad section
// doesn't drop the rest.
const AgentsSchema = z.object({
  defaults: z.object({
    model: z.object({ primary: z.string() }),
  }),
});

const ToolsSchema = z.object({
  profile: z.string().optional(),
  exec: z.object({ security: z.string() }).optional(),
});

const BrowserSchema = z.object({
  enabled: z.boolean(),
});

export type ProductTelemetryDeps = {
  readConfigFile: () => string;
};

const defaultDeps: ProductTelemetryDeps = {
  readConfigFile: () => fs.readFileSync(CONFIG_PATH, 'utf8'),
};

export function collectProductTelemetry(
  openclawVersion: string | null,
  deps: ProductTelemetryDeps = defaultDeps,
  extras?: ProductTelemetryExtras
): ProductTelemetry {
  const empty: ProductTelemetry = {
    openclawVersion,
    defaultModel: null,
    channelCount: 0,
    enabledChannels: [],
    toolsProfile: null,
    execSecurity: null,
    browserEnabled: false,
    ...extras,
  };

  let raw: unknown;
  try {
    raw = JSON.parse(deps.readConfigFile());
  } catch {
    return empty;
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return empty;
  const obj = raw as Record<string, unknown>;

  const agents = AgentsSchema.safeParse(obj.agents);
  const tools = ToolsSchema.safeParse(obj.tools);
  const browser = BrowserSchema.safeParse(obj.browser);
  const enabledChannels = detectChannels(raw);

  return {
    openclawVersion,
    defaultModel: (agents.success && agents.data.defaults.model.primary) || null,
    channelCount: enabledChannels.length,
    enabledChannels,
    toolsProfile: (tools.success && tools.data.profile) || null,
    execSecurity: (tools.success && tools.data.exec?.security) || null,
    browserEnabled: browser.success ? browser.data.enabled : false,
    ...extras,
  };
}
