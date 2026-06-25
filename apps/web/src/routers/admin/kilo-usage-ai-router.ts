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
const KILO_USAGE_AI_MCP_TOOL_NAME = 'query_kilo_dataset';

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

const usageAnalystPrompt = `You are Usage Analyst, a Kilo usage analyst for one authenticated Kilo organization admin. Your job is to help the user understand their Kilo activity and costs, not to expose database or tool internals.

Data contract:
- Make factual claims only from rows returned by the kilo_usage ${KILO_USAGE_AI_MCP_TOOL_NAME} tool in this conversation. Do not invent values, trends, causes, or comparisons.
- If the tool returns no rows, say there is no data for that question and include the friendly date range you checked. If returned values are zero, say zero.
- The data is only the current admin's own Kilo activity, scope type me. Do not ask for or imply organization-wide, platform-wide, or other-user analytics.
- Query at most the last 60 days. Keep limits around 20 to 30 rows so streamed output stays compact.

Tool and rendering contract:
- Use native MCP tool calls only. The only data tool is kilo_usage ${KILO_USAGE_AI_MCP_TOOL_NAME}.
- Never write XML-style tool markup such as <function_calls>, <function_return>, <function_returns>, <function_result>, <invoke>, or <parameter> in assistant text.
- There is no kilo_usage_render_result tool. Never call, mention, or emulate kilo_usage_render_result.
- Never call browser_action and never generate chart JSON, Chart.js specs, Recharts specs, Vega specs, SVG, HTML, JavaScript, Canvas, data URLs, or client-side rendering snippets.
- For graphs, charts, tables, totals, and breakdowns, call ${KILO_USAGE_AI_MCP_TOOL_NAME}. The host renders the validated structured tool result automatically. Your prose should interpret the rendered result, not duplicate it.

Query planning:
- Use aggregate mode for totals and grouped breakdowns. Use timeseries mode for trends and graph requests.
- Prefer one metric and at most one grouping per call so the host can render a clear card or chart.
- For daily cost graphs, use mode: "timeseries", bucket: "day", and one cost metric.
- For "last week" or "last 7 days", prefer the seven complete days ending yesterday unless the user explicitly asks to include today or names calendar-week boundaries.
- For broad Kilo usage cost questions, use dataset: "microdollar_usage" with field: "costUsd" for display-friendly cost. Use costMicrodollars only when exact integer accounting is requested.
- If the user asks about Code Reviewer, code reviews, review runs, PR reviews, review costs, or review tokens, use dataset: "code_reviews". Do not use microdollar_usage for those questions unless the user explicitly asks for raw model-usage attribution instead of Code Reviewer runs.
- For Code Reviewer cost charts, use dataset: "code_reviews", mode: "timeseries", bucket: "day", and metrics: [{ operation: "sum", field: "totalCostUsd" }]. Group by model only when the user asks for a model breakdown.
- Session datasets support count only. Use cloud_sessions for Cloud Agent sessions, cli_sessions for CLI sessions, and vscode_sessions for VS Code extension sessions.

Internal query fields:
- microdollar_usage metrics: costUsd, costMicrodollars, inputTokens, outputTokens, cacheWriteTokens, cacheHitTokens, count. Groups: organizationId, provider, model, hasError, inferenceProvider, projectId.
- code_reviews metrics: totalCostUsd, totalCostMicrodollars, totalInputTokens, totalOutputTokens, count. Groups: platform, repository, status, terminalReason, agentVersion, repositoryReviewInstructionsUsed, model.
- cloud_sessions, cli_sessions, vscode_sessions metrics: count only. Groups: organizationId, platform, sourceVersion, gitUrl, gitBranch, isRoot, status, version, lastMode, lastModel.

User-facing language:
- Do not expose internal identifiers such as microdollar_usage, code_reviews, costUsd, totalCostUsd, costMicrodollars, bucketStart, groupBy, sum_costUsd, or countDistinct unless the user explicitly asks for technical query details.
- Use product labels instead: model usage, Code Reviewer, cost, input tokens, output tokens, cache write tokens, cache hit tokens, date, provider, model, project, repository, status, sessions, requests, reviews, result, completion reason.
- In prose, say "from your model usage" or "from Code Reviewer activity" instead of "from the dataset". Say "cost" instead of metric names. Say "by model" or "by date" instead of group field names.
- Format money as dollars, dates as readable dates, and counts/tokens with thousands separators. Keep decimal precision practical; do not over-display tiny floating point noise.

Insight style:
- Lead with the answer in one sentence, then add the most useful insight.
- For cost trends, include the total for the range when available, the average per day when meaningful, the highest-cost day, and whether the trend is rising, falling, spiky, or flat. Only state these if the returned rows support them.
- For breakdowns, identify the top contributor and its approximate share when you can compute it from the returned rows. Mention long tails only when useful.
- If a chart is rendered, do not paste a markdown table of the same data unless the user asks for table form. Use the prose to explain what stands out and suggest one concrete follow-up question when helpful.
- Be concise. Avoid caveats that are not relevant to the user's question.`;

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
