import {
  CONTAINERS_INTERCEPT_CA_PATH,
  SANDBOX_INTERCEPT_HTTPS_ENABLED,
  SANDBOX_INTERCEPT_HTTPS_ENV,
} from '../shared/container-intercept.js';
import { CONTROL_PLANE_NATIVE_LOGS_ENV } from '../shared/control-diagnostics.js';
import type { ProviderStartupCommand } from '../sandbox-control/provider.js';
import { type NativeMainProcess } from './main-process.js';

import { containerInstanceStartValue, type ContainerInstanceSize } from './instance-size.js';

export type { ContainerInstanceSize } from './instance-size.js';

/** What a physical start used: the image, or an environment snapshot of it. */
export type ContainersStartSource = 'image' | 'repository';

/**
 * A published environment snapshot selected by the environment coordinator.
 * `baseImage` is the image the builder ran; a start whose image differs is a
 * fresh start, because the snapshot's base layers belong to another image.
 */
export type NativeStartSnapshot = {
  snapshotId: string;
  baseImage: string;
};

export type NativeStartRequest = {
  image: string;
  instance: ContainerInstanceSize;
  mainProcess: NativeMainProcess;
  env: Record<string, string>;
  /** Outbound interception is installed: the main process must trust the intercept CA. */
  interception: boolean;
  egressAllowlist?: string[];
  command: ProviderStartupCommand;
  snapshot?: NativeStartSnapshot;
};

/** Why a start uses the image even though one may have been offered. */
export type NativeStartReason =
  | 'no_snapshot'
  | 'not_allowed'
  | 'image_mismatch'
  | 'snapshot'
  | 'restore_failures';

export type NativeStartPlan = {
  image: string;
  source: ContainersStartSource;
  options: ContainerStartupOptions;
  snapshotId: string | null;
  reason: NativeStartReason;
};

function interceptedProcessEnv(env: Record<string, string>): Record<string, string> {
  // Bun reads NODE_EXTRA_CA_CERTS only at process start, so the injected CA file must be
  // readable before this exec for the wrapper's own TLS; cert.ts only completes the bundle
  // append and the child env afterwards.
  return {
    ...env,
    [SANDBOX_INTERCEPT_HTTPS_ENV]: SANDBOX_INTERCEPT_HTTPS_ENABLED,
    NODE_EXTRA_CA_CERTS: CONTAINERS_INTERCEPT_CA_PATH,
  };
}

/**
 * The env for a native start and for a sleep-main-process exec. Interception CA
 * goes on both; the stderr gate is native-only and set here, never in the
 * shared launch-env builder.
 */
export function nativeLaunchEnv(
  env: Record<string, string>,
  interception: boolean
): Record<string, string> {
  return {
    ...(interception ? interceptedProcessEnv(env) : env),
    [CONTROL_PLANE_NATIVE_LOGS_ENV]: '1',
  };
}

function startOptions(request: NativeStartRequest, snapshotId?: string): ContainerStartupOptions {
  const env = nativeLaunchEnv(request.env, request.interception);
  return {
    ...(snapshotId === undefined
      ? { image: request.image }
      : { containerSnapshot: { id: snapshotId } }),
    instance: containerInstanceStartValue(request.instance),
    enableInternet: request.egressAllowlist === undefined,
    entrypoint: [...request.command.argv],
    env,
  };
}

/**
 * The one start-source rule: start from the offered environment snapshot when the
 * caller allows it and it was captured from this image, and from the image
 * otherwise. The snapshot handle never comes from a request: only the environment
 * coordinator publishes it and the Sandbox DO forwards it.
 */
export function planNativeStart(
  request: NativeStartRequest,
  allowSnapshot: boolean
): NativeStartPlan {
  const image = (reason: NativeStartReason): NativeStartPlan => ({
    image: request.image,
    source: 'image',
    options: startOptions(request),
    snapshotId: null,
    reason,
  });
  const snapshot = request.snapshot;
  if (snapshot === undefined) return image('no_snapshot');
  if (!allowSnapshot) return image('not_allowed');
  if (snapshot.baseImage !== request.image) return image('image_mismatch');
  return {
    image: request.image,
    source: 'repository',
    options: startOptions(request, snapshot.snapshotId),
    snapshotId: snapshot.snapshotId,
    reason: 'snapshot',
  };
}
