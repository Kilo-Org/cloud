import type { ControlPlaneRouteSpec } from '../../shared/control-plane-protocol.js';

export class WrapperStartCommandsUnsupportedError extends Error {
  constructor() {
    super('Wrapper cannot run start commands while restoring a session snapshot');
    this.name = 'WrapperStartCommandsUnsupportedError';
  }
}

/** Older wrappers run setup on clone/adopt, but not on session snapshot restore. */
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
  if (rest.sessionSnapshot !== undefined) throw new WrapperStartCommandsUnsupportedError();
  return { ...rest, setupCommands: [...(rest.setupCommands ?? []), ...startCommands] };
}
