import { DurableObject } from 'cloudflare:workers';

export class UserSessionDO extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    return new Response('Not implemented', { status: 501 });
  }

  async pushEvent(_context: string, _event: string, _payload: unknown): Promise<void> {
    // Placeholder — full implementation in Task 3
  }
}
