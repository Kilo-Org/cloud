import { isAbsolute } from 'node:path';
import { startOnPremBroker, type OnPremBroker } from './broker.js';
import { BROKER_PORT, DENIED_PROBE_PORT, onPremConfigSchema } from './kubernetes.js';
import { createProvisioner, readPrivateFile } from './provisioner.js';

export async function main(args: string[]): Promise<void> {
  const configPath = args[1];
  if (args.length !== 2 || args[0] !== '--config' || !configPath || !isAbsolute(configPath))
    throw new Error('explicit_config_file_required');
  if (Bun.version !== '1.3.14') throw new Error('unsupported_bun_version');
  const config = onPremConfigSchema.parse(JSON.parse(await readPrivateFile(configPath)) as unknown);
  await readPrivateFile(config.tls.keyFile, 32_768);
  const abort = new AbortController();
  const provisioner = await createProvisioner(config, providerRef =>
    broker.revokeAllocation(providerRef)
  );
  const broker: OnPremBroker = await startOnPremBroker({
    hostname: '0.0.0.0',
    port: BROKER_PORT,
    tls: { certFile: config.tls.certFile, keyFile: config.tls.keyFile },
    brokerOrigin: config.profile.brokerUrl,
    upstreams: config.upstreams,
    localFixtureUpstreams: config.localFixtureUpstreams,
    resolveAllocation: provisioner.resolveAllocation,
    resolveCredential: provisioner.resolveCredential,
  });
  let diagnostic: Bun.Server<undefined> | undefined;
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    diagnostic = Bun.serve({
      hostname: '0.0.0.0',
      port: DENIED_PROBE_PORT,
      maxRequestBodySize: 1024,
      fetch(request) {
        if (request.method !== 'GET' && request.method !== 'HEAD')
          return new Response(null, { status: 405 });
        const path = new URL(request.url).pathname;
        if (path === '/healthz') return Response.json({ probe: 'kilo-onprem-network-control' });
        if (path === '/livez')
          return new Response(null, { status: abort.signal.aborted ? 503 : 200 });
        if (path === '/readyz') {
          const health = provisioner.health();
          return Response.json(health, { status: health.ready ? 200 : 503 });
        }
        return new Response(null, { status: 404 });
      },
    });
    await provisioner.run(abort.signal);
  } finally {
    abort.abort();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await broker.stop();
    await diagnostic?.stop(true);
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch {
    console.error('onprem_provisioner_failed');
    process.exitCode = 1;
  }
}
