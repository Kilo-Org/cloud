import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { ControlPlaneRouteSpec } from '../../../src/shared/control-plane-protocol.js';
import {
  CONTROL_HOME_ROOT,
  LEGACY_CONTROL_HOME_DIR_NAME,
} from '../../../src/shared/runtime-environment.js';

/** Where a wrapper keeps HOME directories; tests point both roots at a temporary tree. */
export type HomeRoots = {
  /** Directory-keyed homes of `worktree` runtime allocations. */
  directory: string;
  /** Per-session homes of allocations that keep their original layout. */
  legacy: string;
};

export function defaultHomeRoots(): HomeRoots {
  return {
    directory: CONTROL_HOME_ROOT,
    legacy: path.join(os.tmpdir(), LEGACY_CONTROL_HOME_DIR_NAME),
  };
}

/**
 * The fixed HOME of one workspace directory. The environment builder and each
 * session in that directory compute the same path, so `~/.cache` and other
 * toolchains written by builder setup are the session's own home after restore.
 */
export function directoryHome(directory: string, root: string = CONTROL_HOME_ROOT): string {
  return path.join(root, createHash('sha256').update(directory).digest('hex'));
}

/**
 * HOME for one route. A spec that still carries `runtimeIsolation` belongs to an
 * allocation that keeps its per-session runtime and HOME; the Sandbox DO strips
 * the field only for a negotiated `worktree` runtime, which keys HOME by
 * directory alone.
 */
export function routeHome(spec: ControlPlaneRouteSpec, roots: HomeRoots): string {
  if (spec.runtimeIsolation === 'per-session') {
    const id = createHash('sha256')
      .update(spec.sessionId)
      .update('\0')
      .update(spec.directory)
      .digest('hex');
    return path.join(roots.legacy, id);
  }
  return directoryHome(spec.directory, roots.directory);
}
