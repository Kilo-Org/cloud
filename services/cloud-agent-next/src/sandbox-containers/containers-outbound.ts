import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleManagedScmOutbound } from '../sandbox-outbound.js';

export class ContainersOutbound extends WorkerEntrypoint<Cloudflare.Env, { containerId: string }> {
  fetch(request: Request): Promise<Response> {
    const containerId = this.ctx.props.containerId;
    if (!containerId) {
      return Promise.resolve(new Response('SCM authorization unavailable', { status: 502 }));
    }
    return handleManagedScmOutbound(request, this.env, { containerId });
  }
}
