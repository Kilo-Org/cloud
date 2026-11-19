import type {
  PreviewProviderCoordinates,
  PreviewTransport,
} from '../control-plane/sandbox/preview-target.js';
import { previewTunnelName } from '../shared/preview-tunnel-protocol.js';
import type { Env } from '../types.js';

type CoordinatesFor<T extends PreviewTransport> = Extract<
  PreviewProviderCoordinates,
  { transport: T }
>;

type PreviewUpstreams = {
  [T in PreviewTransport]: (
    env: Env,
    coordinates: CoordinatesFor<T>,
    request: Request
  ) => Promise<Response>;
};

/**
 * One upstream for each preview transport. The request is already marked by
 * the route (`Host`, port and allocation markers). A new transport does not
 * compile without its entry.
 */
const PREVIEW_UPSTREAMS: PreviewUpstreams = {
  // The Containers DO checks the markers, the allocation and the port.
  'durable-object': (env, coordinates, request) =>
    env.SANDBOX_CONTAINERS.getByName(coordinates.logicalSandboxId).fetch(request),
  // The PreviewTunnel DO of the allocation checks the markers and relays the
  // request to the wrapper, which refuses reserved ports on loopback.
  'wrapper-tunnel': (env, coordinates, request) =>
    env.PREVIEW_TUNNEL.getByName(
      previewTunnelName(coordinates.logicalSandboxId, coordinates.allocationRef)
    ).fetch(request),
};

function fetchByTransport<T extends PreviewTransport>(
  env: Env,
  transport: T,
  coordinates: CoordinatesFor<T>,
  request: Request
): Promise<Response> {
  const upstream: PreviewUpstreams[T] = PREVIEW_UPSTREAMS[transport];
  return upstream(env, coordinates, request);
}

export function fetchPreviewUpstream(
  env: Env,
  coordinates: PreviewProviderCoordinates,
  request: Request
): Promise<Response> {
  return fetchByTransport(env, coordinates.transport, coordinates, request);
}
