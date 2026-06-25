import 'server-only';

import type { PermissionConfig } from '@kilocode/db/schema-types';
import { GatewayMcpAccessScope, nativeMcpResourceUrl } from '@kilocode/mcp-gateway';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  createCloudAgentNextClient,
  rethrowAsPaymentRequired,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { AGENT_ENV_VARS_PUBLIC_KEY } from '@/lib/config.server';
import { encryptWithPublicKey } from '@/lib/encryption';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { findEligibleNativeMcpUser } from '@/lib/native-mcp/oauth/native-token-verifier';
import { generateCloudAgentToken } from '@/lib/tokens';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';

const KILO_USAGE_AI_CLIENT_ID = 'internal:kilo-usage-ai';
const KILO_USAGE_AI_CREATED_ON_PLATFORM = 'kilo-usage-ai';
const KILO_USAGE_AI_MODEL = 'kilo-auto/balanced';
const KILO_USAGE_AI_TOOL_NAME = 'kilo_usage_query_kilo_dataset';

const startInputSchema = z
  .object({
    model: z.string().trim().min(1).max(200).optional(),
    variant: z.string().trim().min(1).max(50).optional(),
  })
  .optional();

const usageAnalystPermission = {
  '*': 'deny',
  read: 'deny',
  edit: 'deny',
  glob: 'deny',
  grep: 'deny',
  list: 'deny',
  bash: 'deny',
  task: 'deny',
  external_directory: { '*': 'deny' },
  todowrite: 'deny',
  todoread: 'deny',
  question: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  codesearch: 'deny',
  lsp: 'deny',
  skill: 'deny',
  suggest: 'deny',
  [KILO_USAGE_AI_TOOL_NAME]: 'allow',
} satisfies PermissionConfig;

const usageAnalystPrompt = `You are Usage Analyst, a Kilo usage analyst for one authenticated Kilo organization admin.

You can make factual claims only from MCP tool results returned by ${KILO_USAGE_AI_TOOL_NAME}. Do not invent values. If the tool returns no rows, say there is no data for that query. If it returns numeric zeros, say zero.

Scope rules:
- The data is only the current admin's own Kilo activity, scope type me.
- Query at most the last 60 days.
- Keep result limits around 20 to 30 rows so streamed tool output remains compact.
- Prefer one metric and at most one grouping per call so the host can render cards and charts.
- Do not ask for organization-wide or platform-wide analytics.

Tool and rendering rules:
- Use native tool calls only. Never write XML-style tool markup such as <function_calls> or <invoke> in assistant text.
- Never call browser_action or generate data URLs, HTML, JavaScript, or client-side chart code. For visual answers, call ${KILO_USAGE_AI_TOOL_NAME} and let the host render the validated tool result.

Datasets and useful fields:
- microdollar_usage: metrics costMicrodollars, costUsd, inputTokens, outputTokens, cacheWriteTokens, cacheHitTokens, and count; groups organizationId, provider, model, hasError, inferenceProvider, projectId.
- code_reviews: metrics totalInputTokens, totalOutputTokens, totalCostMicrodollars, totalCostUsd, and count; groups platform, repository, status, terminalReason, agentVersion, repositoryReviewInstructionsUsed, model.
- cloud_sessions: count only; groups organizationId, platform, sourceVersion, gitUrl, gitBranch, isRoot, status, version, lastMode, lastModel.
- cli_sessions: count only; groups organizationId, platform, sourceVersion, gitUrl, gitBranch, isRoot, status, version, lastMode, lastModel.
- vscode_sessions: count only; groups organizationId, platform, sourceVersion, gitUrl, gitBranch, isRoot, status, version, lastMode, lastModel.

Use aggregate mode for totals and grouped breakdowns. Use timeseries mode with a day bucket for trend questions unless the user asks for hour or week. Explain answers compactly and cite the returned dataset, metric, grouping, and date range in prose.`;

const blankUsageAnalysisPrompt = 'Blank Ask Usage session. Wait for the user to ask a question.';

export const adminKiloUsageAiRouter = createTRPCRouter({
  start: adminProcedure.input(startInputSchema).mutation(async ({ ctx, input }) => {
    const eligibleUser = await findEligibleNativeMcpUser(ctx.user.id);
    if (!eligibleUser) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Ask Usage is only available to eligible Kilo organization admins',
      });
    }

    const services = createGatewayServices();
    const accessToken = await services.nativeMcpTokenService.mintAccessToken({
      userId: ctx.user.id,
      clientId: KILO_USAGE_AI_CLIENT_ID,
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

    const authToken = generateCloudAgentToken(ctx.user);
    const client = createCloudAgentNextClient(authToken);
    const model = input?.model ?? KILO_USAGE_AI_MODEL;

    try {
      const session = await client.prepareSession({
        repositorySource: 'empty-local',
        mode: 'usage-analyst',
        model,
        variant: input?.variant,
        prompt: blankUsageAnalysisPrompt,
        autoCommit: false,
        autoInitiate: false,
        createdOnPlatform: KILO_USAGE_AI_CREATED_ON_PLATFORM,
        mcpServers: {
          kilo_usage: {
            type: 'remote',
            url: nativeMcpResourceUrl(services.config.appBaseUrl),
            headers: {
              Authorization: encryptedAuthorization,
            },
          },
        },
        runtimeAgents: [
          {
            slug: 'usage-analyst',
            name: 'Usage Analyst',
            config: {
              mode: 'primary',
              steps: 8,
              color: 'info',
              prompt: usageAnalystPrompt,
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
  }),
});
