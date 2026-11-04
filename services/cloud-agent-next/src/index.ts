import { instrumentCloudAgentDurableObject } from './sentry.js';
import { SandboxControlV2 } from './control-plane/sandbox/sandbox-do.js';
import { SandboxSessionV2 } from './control-plane/session/session-do.js';
import { SandboxContainers as SandboxContainersBase } from './sandbox-containers/SandboxContainers.js';
import { StreamTicketNonceDO as StreamTicketNonceDOBase } from './persistence/StreamTicketNonceDO.js';
import { UserKiloFacade as UserKiloFacadeBase } from './kilo-facade/user-kilo-facade.js';

export { default } from './server.js';
export { SandboxContainment, SandboxSmallContainment } from './legacy-runtime-tombstones.js';
export { ContainersOutbound } from './sandbox-containers/containers-outbound.js';
export { EnvironmentBuild } from './environment-build/environment-build-do.js';
export { VercelSnapshotBuild } from './persistence/VercelSnapshotBuild.js';
// Production `SANDBOX_CONTROL` / `SANDBOX_SESSION` bindings. `wrangler.jsonc`
// class names stay `SandboxControl` and `SandboxSession`.
export const SandboxControl = instrumentCloudAgentDurableObject(
  SandboxControlV2,
  'sandbox-control'
);
export type SandboxControl = SandboxControlV2;
export const SandboxSession = instrumentCloudAgentDurableObject(SandboxSessionV2, 'session');
export type SandboxSession = SandboxSessionV2;
export const SandboxContainers = instrumentCloudAgentDurableObject(
  SandboxContainersBase,
  'sandbox-container'
);
export type SandboxContainers = SandboxContainersBase;
export const StreamTicketNonceDO = instrumentCloudAgentDurableObject(
  StreamTicketNonceDOBase,
  'stream-ticket'
);
export type StreamTicketNonceDO = StreamTicketNonceDOBase;
export const UserKiloFacade = instrumentCloudAgentDurableObject(UserKiloFacadeBase, 'kilo-facade');
export type UserKiloFacade = UserKiloFacadeBase;
