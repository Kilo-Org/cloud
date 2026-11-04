import type { ControlPlaneRouteSpec } from '../../shared/control-plane-protocol.js';

/**
 * A wrapper that runs start commands gets them as their own list. An older
 * wrapper gets them appended to setup, so it still runs every command on
 * every workspace preparation, as before start commands existed.
 */
export function startCommandsForWrapper(
  spec: ControlPlaneRouteSpec,
  runsStartCommands: boolean
): ControlPlaneRouteSpec {
  if (runsStartCommands) return spec;
  const { startCommands, ...rest } = spec;
  if (startCommands === undefined || startCommands.length === 0) return rest;
  return { ...rest, setupCommands: [...(rest.setupCommands ?? []), ...startCommands] };
}
