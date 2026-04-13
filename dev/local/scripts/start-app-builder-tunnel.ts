import * as path from 'node:path';
import { ensureCloudflared, startCloudflaredTunnel, updateEnvValue } from './cloudflared-tunnel';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const devVarsPath = path.join(repoRoot, 'services/app-builder/.dev.vars');
const envDevLocalPath = path.join(repoRoot, '.env.development.local');

ensureCloudflared();

const port = process.argv[2] ?? '8790';

startCloudflaredTunnel({
  port,
  onCapture: url => {
    const hostname = url.replace('https://', '');
    updateEnvValue(devVarsPath, 'BUILDER_HOSTNAME', hostname);
    updateEnvValue(envDevLocalPath, 'APP_BUILDER_URL', url);

    console.log(`\nTunnel URL: ${url}`);
    console.log(`Set BUILDER_HOSTNAME=${hostname}`);
    console.log(`Set APP_BUILDER_URL=${url}`);
  },
});
