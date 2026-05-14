import { DurableObject } from 'cloudflare:workers';

type ContainerState = {
  status: 'stopped' | 'running' | 'healthy';
};

export class Container<Env = unknown> extends DurableObject<Env> {
  defaultPort?: number;
  sleepAfter?: string;
  envVars: Record<string, string> = {};

  async getState(): Promise<ContainerState> {
    return (await this.ctx.storage.get<ContainerState>('container:state')) ?? { status: 'stopped' };
  }

  async startAndWaitForPorts(): Promise<void> {
    await this.ctx.storage.put('container:state', { status: 'healthy' } satisfies ContainerState);
    this.onStart();
  }

  async start(): Promise<void> {
    await this.startAndWaitForPorts();
  }

  async stop(): Promise<void> {
    await this.ctx.storage.put('container:state', { status: 'stopped' } satisfies ContainerState);
    this.onStop({ exitCode: 0, reason: 'test stop' });
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request | string): Promise<Response> {
    const url = new URL(typeof request === 'string' ? request : request.url);
    const path = url.pathname;

    if (path === '/health' || path === '/ping') {
      return Response.json({ status: 'ok' });
    }

    if (
      path === '/refresh-token' ||
      path === '/sync-config' ||
      path === '/repos/setup' ||
      path === '/git/merge'
    ) {
      return Response.json({ success: true });
    }

    if (path === '/dashboard-context') {
      return Response.json({ agents: [], rigs: [] });
    }

    if (path === '/agents/start') {
      await this.ctx.storage.put('container:state', { status: 'running' } satisfies ContainerState);
      return Response.json({ success: true });
    }

    if (path.endsWith('/status')) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    if (path.endsWith('/stream-ticket')) {
      return Response.json({
        ticket: 'test-ticket',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }

    if (path.includes('/pty')) {
      return Response.json({ id: 'test-pty', success: true });
    }

    if (path.startsWith('/agents/')) {
      return Response.json({ success: true });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  onStart(): void {}
  onStop(_event: { exitCode: number; reason: string }): void {}
  onError(_error: unknown): void {}
}

export function getRandom<T>(items: T[]): T | undefined {
  return items[0];
}

export function loadBalance<T>(items: T[]): T | undefined {
  return items[0];
}

export function getContainer<T>(
  binding: DurableObjectNamespace<T>,
  name: string
): DurableObjectStub<T> {
  return binding.get(binding.idFromName(name));
}

export function switchPort(url: string, port: number): string {
  const parsed = new URL(url);
  parsed.port = String(port);
  return parsed.toString();
}
