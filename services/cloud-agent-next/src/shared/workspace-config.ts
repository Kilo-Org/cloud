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

type RuntimeProfileFields = Pick<
  ControlPlaneRouteSpec,
  | 'runtimeSkills'
  | 'runtimeInstructions'
  | 'runtimeAgents'
  | 'builtinAgents'
  | 'modelContextLimits'
  | 'kiloCommands'
>;

export function projectRuntimeProfileFields(spec: RuntimeProfileFields): RuntimeProfileFields {
  return {
    ...(spec.runtimeSkills === undefined ? {} : { runtimeSkills: spec.runtimeSkills }),
    ...(spec.runtimeInstructions === undefined
      ? {}
      : { runtimeInstructions: spec.runtimeInstructions }),
    ...(spec.runtimeAgents === undefined ? {} : { runtimeAgents: spec.runtimeAgents }),
    ...(spec.builtinAgents === undefined ? {} : { builtinAgents: spec.builtinAgents }),
    ...(spec.modelContextLimits === undefined
      ? {}
      : { modelContextLimits: spec.modelContextLimits }),
    ...(spec.kiloCommands === undefined ? {} : { kiloCommands: spec.kiloCommands }),
  };
}

export function workspaceConfigFromSpec(
  spec: Pick<
    ControlPlaneRouteSpec,
    'env' | 'secretEnvKeys' | 'setupCommands' | 'startCommands' | 'environmentSetupCommandCount'
  > &
    RuntimeProfileFields,
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
    ...projectRuntimeProfileFields(spec),
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
    runtimeInstructions: _runtimeInstructions,
    runtimeAgents: _runtimeAgents,
    builtinAgents: _builtinAgents,
    modelContextLimits: _modelContextLimits,
    kiloCommands: _kiloCommands,
    ...attachment
  } = spec;
  return attachment;
}
