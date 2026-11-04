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
