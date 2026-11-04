import { findActiveDeviceSession } from '@kilocode/worker-utils/device-session-auth';
import { createKiloAuthMiddleware } from '@kilocode/worker-utils/kilo-auth-middleware';
import { WASTELAND_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import type { WastelandEnv } from '../wasteland.worker';
import { logger } from '../util/log.util';
import { resolveSecret } from '../util/secret.util';

export const kiloAuthMiddleware = createKiloAuthMiddleware<WastelandEnv>({
  resolveSecret,
  audiencePolicy: { audience: WASTELAND_AUDIENCE, mode: 'allow-legacy' },
  onAuthenticated: payload => logger.setTags({ userId: payload.kiloUserId }),
  isActiveDeviceSession: (env, deviceSessionId, userId) =>
    findActiveDeviceSession(env.HYPERDRIVE.connectionString, deviceSessionId, userId),
});
