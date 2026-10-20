import { instrumentCloudAgentDurableObject } from './sentry.js';
import { CloudAgentSession as CloudAgentSessionBase } from './persistence/CloudAgentSession.js';
import { SandboxControlV2 } from './control-plane/sandbox/sandbox-do.js';
import { SandboxSessionV2 } from './control-plane/session/session-do.js';
import { SandboxContainers as SandboxContainersBase } from './sandbox-containers/SandboxContainers.js';
import { StreamTicketNonceDO as StreamTicketNonceDOBase } from './persistence/StreamTicketNonceDO.js';
import { UserKiloFacade as UserKiloFacadeBase } from './kilo-facade/user-kilo-facade.js';

export { default } from './server.js';
export {
  Sandbox,
  SandboxContainment,
  SandboxSmall,
  SandboxSmallContainment,
  SandboxDIND,
  SandboxCodeReview,
  SandboxCodeReviewContainment,
  ContainerProxy,
} from './sandbox-outbound.js';
export { ContainersOutbound } from './sandbox-containers/containers-outbound.js';
export const CloudAgentSession = instrumentCloudAgentDurableObject(
  CloudAgentSessionBase,
  'legacy-session'
);
export type CloudAgentSession = CloudAgentSessionBase;
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
