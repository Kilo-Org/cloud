import type { ControlPlaneRouteSpec } from '../../shared/control-plane-protocol.js';

export class WrapperStartCommandsUnsupportedError extends Error {
  constructor() {
    super('Wrapper cannot run start commands while restoring a workspace tail snapshot');
    this.name = 'WrapperStartCommandsUnsupportedError';
  }
}

/** Older wrappers run setup on clone/adopt, but not on workspace tail snapshot restore. */
export function startCommandsForWrapper(
  spec: ControlPlaneRouteSpec,
  runsStartCommands: boolean
): ControlPlaneRouteSpec {
  if (runsStartCommands) return spec;
  const {
    startCommands,
    environmentSetupCommandCount: _environmentSetupCommandCount,
    ...rest
  } = spec;
  if (startCommands === undefined || startCommands.length === 0) return rest;
  if (rest.workspaceSnapshot !== undefined) throw new WrapperStartCommandsUnsupportedError();
  return { ...rest, setupCommands: [...(rest.setupCommands ?? []), ...startCommands] };
}
