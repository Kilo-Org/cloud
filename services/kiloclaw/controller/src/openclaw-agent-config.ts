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

export type AgentSettingsPatchBody = z.infer<typeof AgentSettingsPatchBodySchema>;
export type AgentDefaultsPatchBody = z.infer<typeof AgentDefaultsPatchBodySchema>;
type OpenClawAgentConfig = z.infer<typeof OpenClawAgentConfigSchema>;
type AgentEntry = z.infer<typeof AgentEntrySchema>;
type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;
type ModelValue = z.infer<typeof AgentModelSchema>;

type NormalizedModel = {
  primary: string | null;
  fallbacks: string[];
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
