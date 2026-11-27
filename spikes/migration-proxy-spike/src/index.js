import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

const SIX_HOURS_MS = 21_600_000;

export class DenyOutbound extends WorkerEntrypoint {
  async fetch(request) {
    return new Response(`denied by spike intercept: ${request.method} ${request.url}`, { status: 403 });
  }
}

export class SpikeDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const container = ctx.container;
      const running = container?.running === true;
      let reapplied = false;
      if (running && env.REAPPLY_TIMEOUT === '1') {
        await container.setInactivityTimeout(SIX_HOURS_MS);
        reapplied = true;
      }
      const log = (await ctx.storage.get('ctorLog')) ?? [];
      log.push({ at: new Date().toISOString(), version: env.SPIKE_VERSION, hasContainer: !!container, running, reapplied });
      await ctx.storage.put('ctorLog', log.slice(-50));
    });
  }

  async containerFetch(path, body) {
    const res = await this.ctx.container
      .getTcpPort(8080)
      .fetch(`http://container${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  async op(name, args) {
    const c = this.ctx.container;
    const base = { version: this.env.SPIKE_VERSION, id: this.ctx.id.toString(), jurisdiction: this.ctx.id.jurisdiction ?? null };
    switch (name) {
      case 'start': {
        if (!c) return { ...base, error: 'ctx.container undefined' };
        if (!c.running) {
          c.start({ image: c.images.probe, instance: 'basic', enableInternet: true });
          await c.setInactivityTimeout(SIX_HOURS_MS);
        }
        for (let i = 0; i < 60; i++) {
          try {
            const info = await this.containerFetch('/info');
            return { ...base, running: c.running, info };
          } catch (e) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }
        return { ...base, running: c.running, error: 'container port never answered' };
      }
      case 'status': {
        const out = { ...base, now: new Date().toISOString(), running: c?.running ?? null, ctorLog: await this.ctx.storage.get('ctorLog') };
        if (c?.running) {
          try { out.info = await this.containerFetch('/info'); } catch (e) { out.infoError = String(e); }
        }
        return out;
      }
      case 'intercept': {
        const deny = this.ctx.exports.DenyOutbound({ props: {} });
        await c.interceptAllOutboundHttp(deny);
        if (args.https) await c.interceptOutboundHttps('*', deny);
        return { ...base, intercepted: true, https: !!args.https };
      }
      case 'call':
        return { ...base, result: await this.containerFetch(args.path, args.body) };
      case 'destroy':
        if (c?.running) await c.destroy();
        return { ...base, running: c?.running ?? null };
      default:
        return { ...base, error: 'unknown op' };
    }
  }
}

export default {
  async fetch(request, env) {
    if (!env.SPIKE_TOKEN || request.headers.get('x-spike-token') !== env.SPIKE_TOKEN) {
      return new Response('forbidden', { status: 403 });
    }
    const url = new URL(request.url);
    const ns = url.searchParams.get('ns') === 'plain' ? env.SPIKE_DO : env.SPIKE_DO.jurisdiction('eu');
    const stub = ns.getByName('runs');
    const args = request.method === 'POST' ? await request.json() : {};
    try {
      return Response.json(await stub.op(url.pathname.slice(1), args));
    } catch (e) {
      return Response.json({ error: String(e?.stack ?? e) }, { status: 500 });
    }
  },
};
