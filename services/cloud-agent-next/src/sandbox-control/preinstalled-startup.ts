import { CONTROL_SUPERVISOR_PATH } from './container-paths.js';
import type { ProviderStartupCommand } from './provider.js';

export function preinstalledStartup(): ProviderStartupCommand {
  return { argv: ['/bin/sh', CONTROL_SUPERVISOR_PATH] };
}
