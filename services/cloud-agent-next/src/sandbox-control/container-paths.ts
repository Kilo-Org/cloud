/**
 * Runtime paths inside the control-plane sandbox image.
 *
 * `CONTROL_SUPERVISOR_PATH` is what providers start; it owns wrapper restarts
 * (spec §7). `CONTROL_WRAPPER_PATH` is the bun bundle the supervisor runs and
 * is the process the stale/probe scans look for.
 */
export const CONTROL_SUPERVISOR_PATH = '/usr/local/bin/kilocode-control-plane-supervisor.sh';
export const CONTROL_WRAPPER_PATH = '/usr/local/bin/kilocode-control-plane-wrapper.js';
export const CONTROL_WRAPPER_LOG_PATH = '/tmp/kilocode-control-wrapper.log';

/** pgrep pattern matching the supervisor or its wrapper child. */
export const CONTROL_PROCESS_MATCH = `${CONTROL_SUPERVISOR_PATH}|${CONTROL_WRAPPER_PATH}`;
