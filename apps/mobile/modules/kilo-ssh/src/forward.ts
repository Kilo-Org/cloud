import type { NativeForwardConfig, NativeForwardStart } from './ReactNativeSsh.types';
import ReactNativeSsh from './ReactNativeSshModule';
import { guard } from './errors';

/** Where a forward listens and where it delivers connections. */
export type ForwardConfig = {
  /** Interface the forward listens on: the device locally, the server remotely. */
  bindHost?: string;
  /** `0` asks the operating system or the server for a free port. */
  bindPort?: number;
  destHost: string;
  destPort: number;
};

/** A running forward. `stop` ends the listener and its open connections. */
export type Forward = {
  /** The port data actually reaches. */
  port: number;
  stop: () => Promise<void>;
};

const DEFAULT_BIND_HOST = '127.0.0.1';

/** Listens on the device and reaches `destHost:destPort` from the server. */
export function startLocalForward(sessionId: string, config: ForwardConfig): Promise<Forward> {
  return track(() => ReactNativeSsh.startLocalForward(sessionId, nativeConfig(config)));
}

/** Asks the server to listen and delivers connections to the device. */
export function startRemoteForward(sessionId: string, config: ForwardConfig): Promise<Forward> {
  return track(() => ReactNativeSsh.startRemoteForward(sessionId, nativeConfig(config)));
}

async function track(start: () => Promise<NativeForwardStart>): Promise<Forward> {
  const forward = await guard(start);

  return {
    port: forward.port,
    stop: () => guard(() => ReactNativeSsh.stopForward(forward.forwardId)),
  };
}

function nativeConfig(config: ForwardConfig): NativeForwardConfig {
  return {
    bindHost: config.bindHost ?? DEFAULT_BIND_HOST,
    bindPort: config.bindPort ?? 0,
    destHost: config.destHost,
    destPort: config.destPort,
  };
}
