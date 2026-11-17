import { CONTROL_SUPERVISOR_PATH } from '../../src/sandbox-control/container-paths.js';
import type { ProviderStartupCommand } from '../../src/sandbox-control/provider.js';

export function supervisorStartup(): ProviderStartupCommand {
  return { argv: ['/bin/sh', CONTROL_SUPERVISOR_PATH] };
}
