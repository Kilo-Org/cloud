import { z } from 'zod';
import { awsByocConfigurationSchema } from '@kilocode/worker-utils/aws-byoc';
import { egressDomainSchema } from '@kilocode/worker-utils/egress-allowlist';
import { AWS_EGRESS_PORT } from '@kilocode/worker-utils/aws-egress';
import { readProxyTaskCredentials } from './task-credentials.js';
import { createProxyDeploymentStore } from './deployment-store.js';
import { establishProxyDeployment } from './deployment.js';
import { createPublicResolver } from './resolver.js';
import { publicHttpsFetch } from './https-transport.js';
import { createControlPlaneClient } from './control-plane.js';
import { createEgressServer } from './server.js';

async function main() {
  const config = z
    .object({
      AWS_REGION: z.literal('us-east-1'),
      AWS_STACK_ID: awsByocConfigurationSchema.shape.stackId,
      AWS_ARTIFACT_BUCKET: awsByocConfigurationSchema.shape.bucket,
      PROXY_HOSTNAME: egressDomainSchema,
      KILO_CONTROL_PLANE_URL: z.url(),
    })
    .parse(process.env);
  const credentials = await readProxyTaskCredentials(
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  );
  const material = await establishProxyDeployment({
    stackId: config.AWS_STACK_ID,
    hostname: config.PROXY_HOSTNAME,
    store: createProxyDeploymentStore({
      credentials,
      region: config.AWS_REGION,
      bucket: config.AWS_ARTIFACT_BUCKET,
    }),
  });
  const resolve = createPublicResolver();
  const control = createControlPlaneClient({
    origin: config.KILO_CONTROL_PLANE_URL,
    deployment: material.deployment,
    identity: material.identity,
    fetch: publicHttpsFetch(resolve),
  });
  const proxy = createEgressServer({
    control,
    resolve,
    tls: material.tls,
    expiresAt: Date.parse(material.deployment.expiresAt),
  });
  proxy.server.listen(AWS_EGRESS_PORT, '0.0.0.0', () => console.info('AWS egress proxy ready'));
  proxy.server.on('error', () => {
    console.error('AWS egress listener failed');
    proxy.close();
    process.exitCode = 1;
  });
  process.once('SIGTERM', () => proxy.close());
  process.once('SIGINT', () => proxy.close());
}
void main().catch(() => {
  console.error('AWS egress startup failed');
  process.exitCode = 1;
});
