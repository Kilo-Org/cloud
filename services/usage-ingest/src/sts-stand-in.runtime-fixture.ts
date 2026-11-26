import { WorkerEntrypoint } from 'cloudflare:workers';

/**
 * Test-only Worker; never deployed. workerd refuses to start a Worker whose service binding names
 * a service it does not run, so runtime tests that start the committed wrangler.jsonc run this
 * empty `SecretsBroker` under the bound STS service name (sts-stand-in.test-fixture.ts).
 */
export class SecretsBroker extends WorkerEntrypoint {}

export default {
  fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
