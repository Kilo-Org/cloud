import type {
  AttachmentSpec,
  ControlPlaneRouteSpec,
  WorkspaceConfig,
} from './control-plane-protocol.js';

export function workspaceConfigRuntimeKey(
  spec: Pick<ControlPlaneRouteSpec, 'sessionId' | 'directory' | 'runtimeIsolation'>
): string {
  return spec.runtimeIsolation === 'per-session' ? spec.sessionId : spec.directory;
}

export function workspaceConfigFromSpec(
  spec: Pick<
    ControlPlaneRouteSpec,
    'env' | 'secretEnvKeys' | 'setupCommands' | 'runtimeSkills' | 'runtimeAgents' | 'kiloCommands'
  >,
  mcp: WorkspaceConfig['mcp']
): WorkspaceConfig {
  return {
    ...(mcp === undefined ? {} : { mcp }),
    ...(spec.env === undefined ? {} : { env: spec.env }),
    ...(spec.secretEnvKeys === undefined ? {} : { secretEnvKeys: spec.secretEnvKeys }),
    ...(spec.setupCommands === undefined ? {} : { setupCommands: spec.setupCommands }),
    ...(spec.runtimeSkills === undefined ? {} : { runtimeSkills: spec.runtimeSkills }),
    ...(spec.runtimeAgents === undefined ? {} : { runtimeAgents: spec.runtimeAgents }),
    ...(spec.kiloCommands === undefined ? {} : { kiloCommands: spec.kiloCommands }),
  };
}

export function attachmentSpecFromRouteSpec(spec: ControlPlaneRouteSpec): AttachmentSpec {
  const {
    mcp: _mcp,
    env: _env,
    secretEnvKeys: _secretEnvKeys,
    setupCommands: _setupCommands,
    runtimeSkills: _runtimeSkills,
    runtimeAgents: _runtimeAgents,
    kiloCommands: _kiloCommands,
    ...attachment
  } = spec;
  return attachment;
}

export function workspaceConfigsEqual(left: WorkspaceConfig, right: WorkspaceConfig): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
