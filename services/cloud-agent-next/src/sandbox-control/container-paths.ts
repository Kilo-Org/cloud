import {
  CONTROL_PLANE_SUPERVISOR,
  runtimeInstallPath,
  wrapperBundle,
} from '../shared/runtime-distribution.js';

/**
 * Runtime paths inside the control-plane sandbox image.
 *
 * `CONTROL_SUPERVISOR_PATH` is what providers start; it owns wrapper restarts
 * (spec §7). `CONTROL_WRAPPER_PATH` is the bun bundle the supervisor runs and
 * is the process the stale/probe scans look for.
 *
 * Both derive from `runtime-distribution.ts`, the single owner of install paths.
 */
export const CONTROL_SUPERVISOR_PATH = runtimeInstallPath(CONTROL_PLANE_SUPERVISOR.installName);
export const CONTROL_WRAPPER_PATH = runtimeInstallPath(
  wrapperBundle('src/control-plane/main.ts').installName
);
export const CONTROL_WRAPPER_LOG_PATH = '/tmp/kilocode-control-wrapper.log';

/** pgrep pattern matching the supervisor or its wrapper child. */
export const CONTROL_PROCESS_MATCH = `${CONTROL_SUPERVISOR_PATH}|${CONTROL_WRAPPER_PATH}`;
