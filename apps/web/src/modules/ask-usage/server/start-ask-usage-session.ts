import 'server-only';

import type { User } from '@kilocode/db/schema';
import { GatewayMcpAccessScope, nativeMcpResourceUrl } from '@kilocode/mcp-gateway';
import { TRPCError } from '@trpc/server';
import {
  createCloudAgentNextClient,
  rethrowAsPaymentRequired,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { AGENT_ENV_VARS_PUBLIC_KEY } from '@/lib/config.server';
import { getEnvVariable } from '@/lib/dotenvx';
import { encryptWithPublicKey } from '@/lib/encryption';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { findEligibleNativeMcpUser } from '@/lib/native-mcp/oauth/native-token-verifier';
import { generateCloudAgentToken } from '@/lib/tokens';
import { ASK_USAGE_MCP_SERVER_NAME } from '../shared/tool-identity';
import {
  ASK_USAGE_CLIENT_ID,
  ASK_USAGE_CREATED_ON_PLATFORM,
  ASK_USAGE_DEFAULT_MODEL,
  ASK_USAGE_RUNTIME_AGENT_NAME,
  ASK_USAGE_RUNTIME_AGENT_SLUG,
  blankAskUsagePrompt,
  buildUsageAnalystPrompt,
  type StartAskUsageSessionInput,
  usageAnalystPermission,
} from './usage-analyst-config';

const ASK_USAGE_CLOUD_AGENT_MCP_APP_BASE_URL_ENV = 'MCP_GATEWAY_CLOUD_AGENT_APP_BASE_URL';

function askUsageCloudAgentMcpUrl(appBaseUrl: string) {
  const cloudAgentAppBaseUrl = getEnvVariable(ASK_USAGE_CLOUD_AGENT_MCP_APP_BASE_URL_ENV);
  return nativeMcpResourceUrl(cloudAgentAppBaseUrl || appBaseUrl);
}

export async function startAskUsageSession(params: {
  user: User;
  input: StartAskUsageSessionInput;
}): Promise<{ kiloSessionId: string }> {
  const eligibleUser = await findEligibleNativeMcpUser(params.user.id);
  if (!eligibleUser) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Ask Usage is only available to eligible Kilo organization admins',
    });
  }

  const services = createGatewayServices();
  const accessToken = await services.nativeMcpTokenService.mintAccessToken({
    userId: params.user.id,
    clientId: ASK_USAGE_CLIENT_ID,
    scopes: [GatewayMcpAccessScope],
  });

  if (!AGENT_ENV_VARS_PUBLIC_KEY) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Agent secret encryption is not configured',
    });
  }

  const encryptedAuthorization = encryptWithPublicKey(
    `Bearer ${accessToken.token}`,
    Buffer.from(AGENT_ENV_VARS_PUBLIC_KEY, 'base64')
  );

  const authToken = generateCloudAgentToken(params.user);
  const client = createCloudAgentNextClient(authToken);
  const model = params.input?.model ?? ASK_USAGE_DEFAULT_MODEL;

  try {
    const session = await client.prepareSession({
      repositorySource: 'empty-local',
      mode: ASK_USAGE_RUNTIME_AGENT_SLUG,
      model,
      variant: params.input?.variant,
      prompt: blankAskUsagePrompt,
      autoCommit: false,
      autoInitiate: false,
      createdOnPlatform: ASK_USAGE_CREATED_ON_PLATFORM,
      mcpServers: {
        [ASK_USAGE_MCP_SERVER_NAME]: {
          type: 'remote',
          url: askUsageCloudAgentMcpUrl(services.config.appBaseUrl),
          headers: {
            Authorization: encryptedAuthorization,
          },
        },
      },
      runtimeAgents: [
        {
          slug: ASK_USAGE_RUNTIME_AGENT_SLUG,
          name: ASK_USAGE_RUNTIME_AGENT_NAME,
          config: {
            mode: 'primary',
            steps: 8,
            color: 'info',
            prompt: buildUsageAnalystPrompt(),
            permission: usageAnalystPermission,
          },
        },
      ],
    });

    return { kiloSessionId: session.kiloSessionId };
  } catch (error) {
    rethrowAsPaymentRequired(error);
    throw error;
  }
}
