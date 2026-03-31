/**
 * Stub WastelandDO — placeholder until the full implementation lands.
 * Provides the class export that wrangler.jsonc requires for the
 * WASTELAND durable_objects binding.
 */
export class WastelandDO extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ error: 'WastelandDO not yet implemented' }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
