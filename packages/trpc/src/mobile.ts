import 'server-only';
import { createTRPCRouter } from '@/lib/trpc/init';
import { organizationsRouter } from '@/routers/organizations/organization-router';
import { userRouter } from '@/routers/user-router';
import { cliSessionsV2Router } from '@/routers/cli-sessions-v2-router';
import { cloudAgentNextRouter } from '@/routers/cloud-agent-next-router';
import { githubAppsRouter } from '@/routers/github-apps-router';
import { codeReviewRouter } from '@/routers/code-reviews/code-reviews-router';
import { personalReviewAgentRouter } from '@/routers/code-reviews-router';
import { securityAgentRouter } from '@/routers/security-agent-router';
import { kiloPassRouter } from '@/routers/kilo-pass-router';
import { agentProfilesRouter } from '@/routers/agent-profiles-router';
import { kiloclawRouter } from '@/routers/kiloclaw-router';
import { modelsRouter } from '@/routers/models-router';
import { activeSessionsRouter } from '@/routers/active-sessions-router';
import { modelPreferencesRouter } from '@/routers/model-preferences-router';
import { githubPrReviewRouter } from '@/routers/github-pr-review-router';
import { kiloChatRouter } from '@/routers/kilo-chat-router';

/**
 * Mobile-scoped tRPC router. Composes only the namespaces the mobile app
 * consumes, so `@kilocode/trpc/mobile` ships a smaller client-facing type
 * surface than the full `RootRouter`. This is additive: `root-router.ts` is
 * unchanged and remains the single source of the server router composition.
 */
const mobileRouter = createTRPCRouter({
  organizations: organizationsRouter,
  user: userRouter,
  cliSessionsV2: cliSessionsV2Router,
  cloudAgentNext: cloudAgentNextRouter,
  githubApps: githubAppsRouter,
  codeReviews: codeReviewRouter,
  personalReviewAgent: personalReviewAgentRouter,
  securityAgent: securityAgentRouter,
  kiloPass: kiloPassRouter,
  agentProfiles: agentProfilesRouter,
  kiloclaw: kiloclawRouter,
  models: modelsRouter,
  activeSessions: activeSessionsRouter,
  modelPreferences: modelPreferencesRouter,
  githubPrReview: githubPrReviewRouter,
  kiloChat: kiloChatRouter,
});

export type MobileRouter = typeof mobileRouter;
export type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
