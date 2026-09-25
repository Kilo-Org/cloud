import { createKiloAuthMiddleware } from '@kilocode/worker-utils/kilo-auth-middleware';
import { GASTOWN_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import type { GastownEnv } from '../gastown.worker';
import { logger } from '../util/log.util';
import { resolveSecret } from '../util/secret.util';
import { isTokenPepper } from '../util/token-pepper.util';

export const kiloAuthMiddleware = createKiloAuthMiddleware<GastownEnv>({
  resolveSecret,
  audiencePolicy: { audience: GASTOWN_AUDIENCE, mode: 'allow-legacy' },
  onAuthenticated: payload => {
    // The shared context normalizes an absent claim to null; require the
    // explicit signed value before downstream equality checks can use it.
    if (!isTokenPepper(payload.apiTokenPepper)) throw new Error('Invalid token pepper');
    logger.setTags({ userId: payload.kiloUserId });
  },
});
