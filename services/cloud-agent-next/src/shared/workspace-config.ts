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
    | 'env'
    | 'secretEnvKeys'
    | 'setupCommands'
    | 'startCommands'
    | 'environmentSetupCommandCount'
    | 'runtimeSkills'
    | 'runtimeAgents'
    | 'builtinAgents'
    | 'kiloCommands'
  >,
  mcp: WorkspaceConfig['mcp']
): WorkspaceConfig {
  return {
    ...(mcp === undefined ? {} : { mcp }),
    ...(spec.env === undefined ? {} : { env: spec.env }),
    ...(spec.secretEnvKeys === undefined ? {} : { secretEnvKeys: spec.secretEnvKeys }),
    ...(spec.setupCommands === undefined ? {} : { setupCommands: spec.setupCommands }),
    ...(spec.startCommands === undefined ? {} : { startCommands: spec.startCommands }),
    ...(spec.environmentSetupCommandCount === undefined
      ? {}
      : { environmentSetupCommandCount: spec.environmentSetupCommandCount }),
    ...(spec.runtimeSkills === undefined ? {} : { runtimeSkills: spec.runtimeSkills }),
    ...(spec.runtimeAgents === undefined ? {} : { runtimeAgents: spec.runtimeAgents }),
    ...(spec.builtinAgents === undefined ? {} : { builtinAgents: spec.builtinAgents }),
    ...(spec.kiloCommands === undefined ? {} : { kiloCommands: spec.kiloCommands }),
  };
}

export function attachmentSpecFromRouteSpec(spec: ControlPlaneRouteSpec): AttachmentSpec {
  const {
    mcp: _mcp,
    env: _env,
    secretEnvKeys: _secretEnvKeys,
    setupCommands: _setupCommands,
    startCommands: _startCommands,
    environmentSetupCommandCount: _environmentSetupCommandCount,
    runtimeSkills: _runtimeSkills,
    runtimeAgents: _runtimeAgents,
    builtinAgents: _builtinAgents,
    kiloCommands: _kiloCommands,
    ...attachment
  } = spec;
  return attachment;
}
