import { Container } from '@cloudflare/containers';

/**
 * Stub WastelandContainerDO — placeholder until the full implementation lands.
 * Provides the class export that wrangler.jsonc requires for the
 * WASTELAND_CONTAINER durable_objects binding.
 */
export class WastelandContainerDO extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30m';
}

export function getWastelandContainerStub(env: Env, wastelandId: string) {
  return env.WASTELAND_CONTAINER.get(env.WASTELAND_CONTAINER.idFromName(wastelandId));
}
