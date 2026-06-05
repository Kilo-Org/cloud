import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { atomicWrite } from './atomic-write';
import { backupConfigFile } from './config-writer';

export const OPENCLAW_CONFIG_PATH = '/root/.openclaw/openclaw.json';
export const DEFAULT_AGENT_ID = 'main';

const INVALID_AGENT_ID_CHARS = /[^a-z0-9_-]+/g;
const LEADING_DASHES = /^-+/;
const TRAILING_DASHES = /-+$/;
const VALID_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const AgentModelSchema = z.union([
  z.string().min(1),
  z
    .object({
      primary: z.string().min(1).optional(),
      fallbacks: z.array(z.string().min(1)).optional(),
    })
    .passthrough(),
]);

const ThinkingDefaultSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'adaptive',
  'max',
]);
const VerboseDefaultSchema = z.enum(['off', 'on', 'full']);
const ReasoningDefaultSchema = z.enum(['on', 'off', 'stream']);

const AgentEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    workspace: z.string().optional(),
    agentDir: z.string().optional(),
    model: AgentModelSchema.optional(),
    thinkingDefault: ThinkingDefaultSchema.optional(),
    verboseDefault: VerboseDefaultSchema.optional(),
    reasoningDefault: ReasoningDefaultSchema.optional(),
    fastModeDefault: z.boolean().optional(),
  })
  .passthrough();

const AgentDefaultsSchema = z
  .object({
    model: AgentModelSchema.optional(),
    thinkingDefault: ThinkingDefaultSchema.optional(),
    verboseDefault: VerboseDefaultSchema.optional(),
  })
  .passthrough();

const OpenClawAgentConfigSchema = z
  .object({
    agents: z
      .object({
        defaults: AgentDefaultsSchema.optional(),
        list: z.array(AgentEntrySchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const EditableModelSchema = z
  .object({
    primary: z.string().trim().min(1).optional(),
    fallbacks: z.array(z.string().trim().min(1)).optional(),
  })
  .strict()
  .refine(model => model.primary !== undefined || model.fallbacks !== undefined, {
    message: 'Model patch must include primary or fallbacks',
  });

const EditableSettingsSchema = z
  .object({
    model: EditableModelSchema.optional(),
    thinkingDefault: ThinkingDefaultSchema.optional(),
    verboseDefault: VerboseDefaultSchema.optional(),
    reasoningDefault: ReasoningDefaultSchema.optional(),
    fastModeDefault: z.boolean().optional(),
  })
  .strict();

const EditableDefaultsSettingsSchema = z
  .object({
    model: EditableModelSchema.optional(),
    thinkingDefault: ThinkingDefaultSchema.optional(),
    verboseDefault: VerboseDefaultSchema.optional(),
  })
  .strict();

const EditableUnsetFieldSchema = z.enum([
  'model',
  'model.primary',
  'model.fallbacks',
  'thinkingDefault',
  'verboseDefault',
  'reasoningDefault',
  'fastModeDefault',
]);

const EditableDefaultsUnsetFieldSchema = z.enum([
  'model',
  'model.primary',
  'model.fallbacks',
  'thinkingDefault',
  'verboseDefault',
]);

export const AgentSettingsPatchBodySchema = z
  .object({
    etag: z.string().min(1).optional(),
    set: EditableSettingsSchema.default({}),
    unset: z.array(EditableUnsetFieldSchema).default([]),
  })
  .strict()
  .refine(body => Object.keys(body.set).length > 0 || body.unset.length > 0, {
    message: 'Patch must set or unset at least one field',
  });

export const AgentDefaultsPatchBodySchema = z
  .object({
    etag: z.string().min(1).optional(),
    set: EditableDefaultsSettingsSchema.default({}),
    unset: z.array(EditableDefaultsUnsetFieldSchema).default([]),
  })
  .strict()
  .refine(body => Object.keys(body.set).length > 0 || body.unset.length > 0, {
    message: 'Patch must set or unset at least one field',
  });

// Declarative channel-route set: this agent's channel-level default-account
// routes should become exactly `channels`. Advanced and account-scoped bindings
// are preserved.
export const AgentBindingsPutBodySchema = z
  .object({
    etag: z.string().min(1).optional(),
    channels: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(64)
          .refine(value => !value.startsWith('-'), {
            message: 'Channel must not begin with a dash',
          })
      )
      .max(50),
  })
  .strict();

export type AgentSettingsPatchBody = z.infer<typeof AgentSettingsPatchBodySchema>;
export type AgentDefaultsPatchBody = z.infer<typeof AgentDefaultsPatchBodySchema>;
export type AgentBindingsPutBody = z.infer<typeof AgentBindingsPutBodySchema>;
type OpenClawAgentConfig = z.infer<typeof OpenClawAgentConfigSchema>;
type AgentEntry = z.infer<typeof AgentEntrySchema>;
type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;
type ModelValue = z.infer<typeof AgentModelSchema>;

type NormalizedModel = {
  primary: string | null;
  fallbacks: string[];
};

export type AgentBindingSummary = {
  channel: string;
  accountId: string | null;
  // True when the binding is more specific than a channel(/account) route
  // (peer/guild/team/roles match, or a non-route binding type). The simple
  // channel-level editor surfaces these but must not clobber them.
  advanced: boolean;
};

export type AgentSummary = {
  id: string;
  name: string | null;
  configured: boolean;
  workspace: string | null;
  agentDir: string | null;
  model: NormalizedModel & { source: 'agent' | 'defaults' | null };
  rawModel: ModelValue | null;
  settings: {
    thinkingDefault: string | null;
    verboseDefault: string | null;
    reasoningDefault: string | null;
    fastModeDefault: boolean | null;
  };
  bindings: AgentBindingSummary[];
};

export type AgentConfigSummary = {
  defaults: {
    model: NormalizedModel | null;
    settings: AgentSummary['settings'];
  };
  agents: AgentSummary[];
};

export type AgentConfigSnapshot = {
  raw: string;
  etag: string;
  config: OpenClawAgentConfig;
};

export class AgentConfigError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AgentConfigError';
    this.status = status;
    this.code = code;
  }
}

export type AgentConfigOptions = {
  configPath?: string;
};

const mutationQueues = new Map<string, Promise<void>>();

export function computeConfigEtag(raw: string): string {
  return crypto.createHash('md5').update(raw).digest('hex');
}

export function normalizeAgentId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_AGENT_ID;
  }
  const normalized = trimmed.toLowerCase();
  if (VALID_AGENT_ID.test(trimmed)) {
    return normalized;
  }
  return (
    normalized
      .replace(INVALID_AGENT_ID_CHARS, '-')
      .replace(LEADING_DASHES, '')
      .replace(TRAILING_DASHES, '')
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

export function requireAgentId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AgentConfigError(400, 'invalid_agent_id', 'Agent id is required');
  }
  const normalized = normalizeAgentId(trimmed);
  if (normalized === DEFAULT_AGENT_ID && trimmed.toLowerCase() !== DEFAULT_AGENT_ID) {
    throw new AgentConfigError(400, 'invalid_agent_id', 'Agent id normalizes to a reserved id');
  }
  return normalized;
}

function normalizeModel(model: ModelValue | undefined): NormalizedModel | null {
  if (typeof model === 'string') {
    return { primary: model.trim() || null, fallbacks: [] };
  }
  if (model === undefined) {
    return null;
  }
  return {
    primary: model.primary?.trim() || null,
    fallbacks: (model.fallbacks ?? []).map(item => item.trim()).filter(Boolean),
  };
}

function normalizeModelForWrite(model: z.infer<typeof EditableModelSchema>): {
  primary?: string;
  fallbacks?: string[];
} {
  return {
    ...(model.primary !== undefined ? { primary: model.primary.trim() } : {}),
    ...(model.fallbacks !== undefined
      ? { fallbacks: model.fallbacks.map(item => item.trim()).filter(Boolean) }
      : {}),
  };
}

function settingsOf(entry: AgentEntry | AgentDefaults | undefined): AgentSummary['settings'] {
  const reasoningDefault =
    entry && 'reasoningDefault' in entry && typeof entry.reasoningDefault === 'string'
      ? entry.reasoningDefault
      : null;
  const fastModeDefault =
    entry && 'fastModeDefault' in entry && typeof entry.fastModeDefault === 'boolean'
      ? entry.fastModeDefault
      : null;
  return {
    thinkingDefault: entry?.thinkingDefault ?? null,
    verboseDefault: entry?.verboseDefault ?? null,
    reasoningDefault,
    fastModeDefault,
  };
}

function findConfiguredEntry(config: OpenClawAgentConfig, agentId: string): AgentEntry | undefined {
  return config.agents?.list?.find(entry => normalizeAgentId(entry.id) === agentId);
}

// The top-level `bindings` array is not modeled by OpenClawAgentConfigSchema
// (it round-trips via .passthrough()), so read it leniently at runtime — a
// malformed binding entry is skipped, never fatal to a read.
// `accountId` is validated (string) so a malformed value (e.g. a number) fails
// parsing and the entry is treated as unmanaged: skipped on read, preserved on
// write, never mistaken for a default-account route. Other match keys
// (peer/guild/team/roles) pass through and are detected by presence.
const BindingMatchSchema = z
  .object({ channel: z.string().min(1), accountId: z.string().optional() })
  .passthrough();
const ConfigBindingSchema = z
  .object({
    type: z.string().optional(),
    agentId: z.string().min(1),
    match: BindingMatchSchema,
  })
  .passthrough();

// Match keys that make a binding more specific than a channel(/account) route.
const ADVANCED_MATCH_KEYS = ['peer', 'parentPeer', 'guildId', 'teamId', 'roles'];

// Classify a raw binding entry as a "managed" channel-level default-account route
// (the only kind the declarative set touches), or null for anything else
// (advanced match, account-scoped, non-route type, or unparseable — all preserved).
function classifyManagedChannelRoute(item: unknown): { agentId: string; channel: string } | null {
  const parsed = ConfigBindingSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const binding = parsed.data;
  const match = binding.match as Record<string, unknown>;
  if (typeof match.accountId === 'string') {
    return null;
  }
  if (binding.type !== undefined && binding.type !== 'route') {
    return null;
  }
  if (ADVANCED_MATCH_KEYS.some(key => match[key] !== undefined)) {
    return null;
  }
  return { agentId: normalizeAgentId(binding.agentId), channel: binding.match.channel };
}

// Parse the top-level bindings array once and group summaries by normalized
// agent id, so summarizing the fleet stays O(agents + bindings) rather than
// re-scanning every binding per agent.
function summarizeBindingsByAgent(config: OpenClawAgentConfig): Map<string, AgentBindingSummary[]> {
  const byAgent = new Map<string, AgentBindingSummary[]>();
  const raw = (config as { bindings?: unknown }).bindings;
  if (!Array.isArray(raw)) {
    return byAgent;
  }
  for (const item of raw) {
    const parsed = ConfigBindingSchema.safeParse(item);
    if (!parsed.success) {
      continue;
    }
    const binding = parsed.data;
    const agentId = normalizeAgentId(binding.agentId);
    const match = binding.match as Record<string, unknown>;
    const accountId = typeof match.accountId === 'string' ? match.accountId : null;
    const advanced =
      (binding.type !== undefined && binding.type !== 'route') ||
      ADVANCED_MATCH_KEYS.some(key => match[key] !== undefined);
    const summaries = byAgent.get(agentId) ?? [];
    summaries.push({ channel: binding.match.channel, accountId, advanced });
    byAgent.set(agentId, summaries);
  }
  return byAgent;
}

function assertUniqueAgentIds(config: OpenClawAgentConfig): void {
  const seen = new Set<string>();
  for (const entry of config.agents?.list ?? []) {
    const normalized = requireAgentId(entry.id);
    if (seen.has(normalized)) {
      throw new AgentConfigError(422, 'invalid_agent_config', `Duplicate agent id: ${normalized}`);
    }
    seen.add(normalized);
  }
}

export function readAgentConfigSnapshot(options: AgentConfigOptions = {}): AgentConfigSnapshot {
  const configPath = options.configPath ?? OPENCLAW_CONFIG_PATH;
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[controller] Failed to read OpenClaw agent config:', message);
    throw new AgentConfigError(500, 'agent_config_read_failed', 'Failed to read agent config');
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AgentConfigError(500, 'invalid_agent_config', 'OpenClaw config is not valid JSON');
  }
  const parsed = OpenClawAgentConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentConfigError(
      422,
      'invalid_agent_config',
      'OpenClaw agent config shape is invalid'
    );
  }
  return { raw, etag: computeConfigEtag(raw), config: parsed.data };
}

export function summarizeAgentConfig(config: OpenClawAgentConfig): AgentConfigSummary {
  const defaults = config.agents?.defaults;
  const defaultsModel = normalizeModel(defaults?.model);
  const entries = config.agents?.list?.length ? config.agents.list : [{ id: DEFAULT_AGENT_ID }];
  const bindingsByAgent = summarizeBindingsByAgent(config);
  return {
    defaults: {
      model: defaultsModel,
      settings: settingsOf(defaults),
    },
    agents: entries.map(entry => {
      const id = normalizeAgentId(entry.id);
      const ownModel = normalizeModel(entry.model);
      const effectiveModel = ownModel ?? defaultsModel ?? { primary: null, fallbacks: [] };
      return {
        id,
        name: entry.name ?? null,
        configured: findConfiguredEntry(config, id) !== undefined,
        workspace: entry.workspace ?? null,
        agentDir: entry.agentDir ?? null,
        model: {
          ...effectiveModel,
          source: ownModel ? 'agent' : defaultsModel ? 'defaults' : null,
        },
        rawModel: entry.model ?? null,
        settings: settingsOf(entry),
        bindings: bindingsByAgent.get(id) ?? [],
      };
    }),
  };
}

export function readAgentSummary(
  agentId: string,
  options: AgentConfigOptions = {}
): { snapshot: AgentConfigSnapshot; agent: AgentSummary } {
  const normalized = requireAgentId(agentId);
  const snapshot = readAgentConfigSnapshot(options);
  const entry = findConfiguredEntry(snapshot.config, normalized);
  if (entry === undefined && normalized !== DEFAULT_AGENT_ID) {
    throw new AgentConfigError(404, 'agent_not_found', `Agent "${normalized}" not found`);
  }
  const summarizedEntry = entry ?? { id: DEFAULT_AGENT_ID };
  const agent = summarizeAgentConfig({
    ...snapshot.config,
    agents: { ...snapshot.config.agents, list: [summarizedEntry] },
  }).agents[0];
  if (!agent) {
    throw new AgentConfigError(500, 'agent_config_read_failed', 'Unable to summarize agent');
  }
  return { snapshot, agent: { ...agent, configured: entry !== undefined } };
}

function applySettingsPatch(
  target: AgentEntry | AgentDefaults,
  patch: AgentSettingsPatchBody
): void {
  for (const field of patch.unset) {
    switch (field) {
      case 'model':
        delete target.model;
        break;
      case 'model.primary':
        if (typeof target.model === 'string') {
          delete target.model;
        } else if (target.model !== undefined) {
          delete target.model.primary;
        }
        break;
      case 'model.fallbacks':
        if (target.model !== undefined && typeof target.model !== 'string') {
          delete target.model.fallbacks;
        }
        break;
      case 'thinkingDefault':
        delete target.thinkingDefault;
        break;
      case 'verboseDefault':
        delete target.verboseDefault;
        break;
      case 'reasoningDefault':
        delete target.reasoningDefault;
        break;
      case 'fastModeDefault':
        delete target.fastModeDefault;
        break;
    }
  }

  if (patch.set.model !== undefined) {
    const existingModel =
      typeof target.model === 'string'
        ? { primary: target.model }
        : target.model === undefined
          ? {}
          : target.model;
    target.model = { ...existingModel, ...normalizeModelForWrite(patch.set.model) };
  }
  if (patch.set.thinkingDefault !== undefined) {
    target.thinkingDefault = patch.set.thinkingDefault;
  }
  if (patch.set.verboseDefault !== undefined) {
    target.verboseDefault = patch.set.verboseDefault;
  }
  if (patch.set.reasoningDefault !== undefined) {
    target.reasoningDefault = patch.set.reasoningDefault;
  }
  if (patch.set.fastModeDefault !== undefined) {
    target.fastModeDefault = patch.set.fastModeDefault;
  }
}

async function enqueueMutation<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(configPath) ?? Promise.resolve();
  let complete: (() => void) | undefined;
  const currentComplete = new Promise<void>(resolve => {
    complete = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => currentComplete);
  mutationQueues.set(configPath, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    complete?.();
    if (mutationQueues.get(configPath) === tail) {
      mutationQueues.delete(configPath);
    }
  }
}

export async function serializeAgentConfigMutation<T>(
  operation: () => Promise<T>,
  options: AgentConfigOptions = {}
): Promise<T> {
  const configPath = options.configPath ?? OPENCLAW_CONFIG_PATH;
  return enqueueMutation(configPath, operation);
}

async function mutateAgentConfig<T>(
  etag: string | undefined,
  mutate: (config: OpenClawAgentConfig) => T,
  options: AgentConfigOptions
): Promise<{ snapshot: AgentConfigSnapshot; result: T }> {
  const configPath = options.configPath ?? OPENCLAW_CONFIG_PATH;
  return serializeAgentConfigMutation(async () => {
    const current = readAgentConfigSnapshot({ configPath });
    assertUniqueAgentIds(current.config);
    if (etag !== undefined && current.etag !== etag) {
      throw new AgentConfigError(409, 'config_etag_conflict', 'Config changed since last read');
    }
    const result = mutate(current.config);
    assertUniqueAgentIds(current.config);

    // OpenClaw config mutations use a snapshot hash guard rather than a shared
    // file lock. Re-check the source just before this atomic write to reject
    // changes observed since our read-modify step.
    const latest = readAgentConfigSnapshot({ configPath });
    if (latest.etag !== current.etag) {
      throw new AgentConfigError(409, 'config_etag_conflict', 'Config changed during update');
    }

    const serialized = `${JSON.stringify(current.config, null, 2)}\n`;
    backupConfigFile(configPath);
    atomicWrite(configPath, serialized, undefined, { mode: 0o600 });
    const snapshot = readAgentConfigSnapshot({ configPath });
    return { snapshot, result };
  }, options);
}

export async function updateAgentSettings(
  agentId: string,
  patch: AgentSettingsPatchBody,
  options: AgentConfigOptions = {}
): Promise<{ snapshot: AgentConfigSnapshot; agent: AgentSummary }> {
  const normalized = requireAgentId(agentId);
  const { snapshot } = await mutateAgentConfig(
    patch.etag,
    config => {
      let entry = findConfiguredEntry(config, normalized);
      if (entry === undefined) {
        if (normalized !== DEFAULT_AGENT_ID) {
          throw new AgentConfigError(404, 'agent_not_found', `Agent "${normalized}" not found`);
        }
        config.agents ??= {};
        config.agents.list ??= [];
        entry = { id: DEFAULT_AGENT_ID };
        config.agents.list.push(entry);
      }
      applySettingsPatch(entry, patch);
      const validated = AgentEntrySchema.safeParse(entry);
      if (!validated.success) {
        throw new AgentConfigError(422, 'invalid_config_after_patch', 'Updated agent is invalid');
      }
    },
    options
  );
  const updatedEntry = findConfiguredEntry(snapshot.config, normalized);
  if (updatedEntry === undefined) {
    throw new AgentConfigError(500, 'invalid_config_after_patch', 'Updated agent is missing');
  }
  const agent = summarizeAgentConfig({
    ...snapshot.config,
    agents: { ...snapshot.config.agents, list: [updatedEntry] },
  }).agents[0];
  if (!agent) {
    throw new AgentConfigError(
      500,
      'invalid_config_after_patch',
      'Unable to summarize updated agent'
    );
  }
  return { snapshot, agent };
}

export async function updateAgentDefaults(
  patch: AgentDefaultsPatchBody,
  options: AgentConfigOptions = {}
): Promise<{ snapshot: AgentConfigSnapshot; defaults: AgentConfigSummary['defaults'] }> {
  const { snapshot } = await mutateAgentConfig(
    patch.etag,
    config => {
      config.agents ??= {};
      config.agents.defaults ??= {};
      applySettingsPatch(config.agents.defaults, patch);
      const validated = AgentDefaultsSchema.safeParse(config.agents.defaults);
      if (!validated.success) {
        throw new AgentConfigError(
          422,
          'invalid_config_after_patch',
          'Updated defaults are invalid'
        );
      }
    },
    options
  );
  return { snapshot, defaults: summarizeAgentConfig(snapshot.config).defaults };
}

/**
 * Declaratively set an agent's channel-level (default-account) routes via a
 * single guarded, atomic config write. Surgically replaces only this agent's
 * managed channel routes; advanced bindings (peer/guild/team/roles, non-route
 * types), account-scoped routes, and other agents' bindings are preserved
 * untouched. Fails closed (422) if the bindings array is an unexpected shape,
 * and rejects (409 agent_binding_conflict) a channel already routed to another
 * agent — all before any write.
 */
export async function updateAgentBindings(
  agentId: string,
  body: AgentBindingsPutBody,
  options: AgentConfigOptions = {}
): Promise<{ snapshot: AgentConfigSnapshot; agent: AgentSummary }> {
  const normalized = requireAgentId(agentId);
  const desired = [...new Set(body.channels.map(channel => channel.trim().toLowerCase()))];

  const { snapshot } = await mutateAgentConfig(
    body.etag,
    config => {
      if (
        findConfiguredEntry(config, normalized) === undefined &&
        normalized !== DEFAULT_AGENT_ID
      ) {
        throw new AgentConfigError(404, 'agent_not_found', `Agent "${normalized}" not found`);
      }

      const rawBindings = (config as { bindings?: unknown }).bindings;
      if (rawBindings !== undefined && !Array.isArray(rawBindings)) {
        throw new AgentConfigError(
          422,
          'invalid_agent_config',
          'Unexpected bindings shape in config'
        );
      }
      const existing: unknown[] = Array.isArray(rawBindings) ? rawBindings : [];

      // Reject any requested channel already routed (default account) to another agent.
      for (const channel of desired) {
        const conflicted = existing.some(item => {
          const route = classifyManagedChannelRoute(item);
          return route !== null && route.channel === channel && route.agentId !== normalized;
        });
        if (conflicted) {
          throw new AgentConfigError(
            409,
            'agent_binding_conflict',
            `Channel "${channel}" is already routed to another agent`
          );
        }
      }

      // Drop only this agent's managed channel routes; keep everything else.
      const preserved = existing.filter(item => {
        const route = classifyManagedChannelRoute(item);
        return !(route !== null && route.agentId === normalized);
      });
      const added = desired.map(channel => ({
        type: 'route',
        agentId: normalized,
        match: { channel },
      }));
      const next = [...preserved, ...added];

      if (next.length > 0 || Array.isArray(rawBindings)) {
        (config as { bindings?: unknown }).bindings = next;
      }
    },
    options
  );

  // Summarize via the implicit-main fallback (same as readAgentSummary): binding
  // `main` does not materialize an agents.list entry, and summarizeAgentConfig
  // only synthesizes implicit main when the list is empty — so look it up against
  // a single synthetic entry rather than the full list.
  const entry = findConfiguredEntry(snapshot.config, normalized);
  const summarizedEntry = entry ?? { id: DEFAULT_AGENT_ID };
  const agent = summarizeAgentConfig({
    ...snapshot.config,
    agents: { ...snapshot.config.agents, list: [summarizedEntry] },
  }).agents[0];
  if (!agent) {
    throw new AgentConfigError(
      500,
      'agent_config_read_failed',
      'Unable to summarize agent after binding update'
    );
  }
  return { snapshot, agent: { ...agent, configured: entry !== undefined } };
}
