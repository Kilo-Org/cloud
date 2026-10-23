import { extractBearerToken } from '@kilocode/worker-utils';
import { verifyKiloBearerAgainstCurrentPepper } from '@kilocode/worker-utils/kilo-token-auth';
import { CLOUD_AGENT_NEXT_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  CloudAgentAuthoritySchema,
  type CloudAgentAuthority,
} from '@kilocode/worker-utils/cloud-agent-authority';
import { verifyKiloTokenForResource } from '@kilocode/worker-utils/kilo-token-policy';

export async function validateKiloToken(
  authHeader: string | null,
  params: {
    secret: string | null | undefined;
    connectionString: string;
    workerEnv?: string;
    allowCloudAgentAuthority?: boolean;
  }
): Promise<
  | {
      success: true;
      userId: string;
      token: string;
      botId?: string;
      cloudAgentAuthority?: CloudAgentAuthority;
    }
  | { success: false; error: string }
> {
  const { secret, connectionString, workerEnv } = params;
  if (!secret) {
    return { success: false, error: 'NEXTAUTH_SECRET is not configured on the worker' };
  }

  const token = extractBearerToken(authHeader);
  if (!token) {
    return { success: false, error: 'Missing or malformed Authorization header' };
  }

  const auth = await verifyKiloBearerAgainstCurrentPepper({
    token,
    nextAuthSecret: secret,
    connectionString,
    resourceAudience: { audience: CLOUD_AGENT_NEXT_AUDIENCE, mode: 'allow-legacy' },
    ...(workerEnv ? { workerEnv } : {}),
  });

  if (!auth) {
    return { success: false, error: 'Invalid or expired token' };
  }

  try {
    const verified = await verifyKiloTokenForResource(token, secret, {
      audience: CLOUD_AGENT_NEXT_AUDIENCE,
      mode: 'allow-legacy',
    });
    if (verified.cloudAgentAuthority && !params.allowCloudAgentAuthority) {
      return { success: false, error: 'Cloud Agent authority only permits internal preparation' };
    }
    return {
      success: true,
      userId: auth.userId,
      token,
      botId: auth.botId,
      ...(verified.cloudAgentAuthority
        ? { cloudAgentAuthority: CloudAgentAuthoritySchema.parse(verified.cloudAgentAuthority) }
        : {}),
    };
  } catch {
    return { success: false, error: 'Invalid or expired token' };
  }
}
