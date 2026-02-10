import 'server-only';
import { createTRPCRouter } from '@/lib/trpc/init';
import { organizationsRouter } from '@/routers/organizations/organization-router';
import { testRouter } from '@/routers/test-router';
import { debugRouter } from '@/routers/debug-router';
import { userRouter } from '@/routers/user-router';
import { adminRouter } from '@/routers/admin-router';
import { codeIndexingRouter } from '@/routers/code-indexing/code-indexing-router';
import { deploymentsRouter } from '@/routers/deployments-router';
import { cliSessionsRouter } from '@/routers/cli-sessions-router';
import { cliSessionsV2Router } from '@/routers/cli-sessions-v2-router';
import { cloudAgentRouter } from '@/routers/cloud-agent-router';
import { cloudAgentNextRouter } from '@/routers/cloud-agent-next-router';
import { githubAppsRouter } from '@/routers/github-apps-router';
import { gitlabRouter } from '@/routers/gitlab-router';
import { slackRouter } from '@/routers/slack-router';
import { codeReviewRouter } from '@/routers/code-reviews/code-reviews-router';
import { personalReviewAgentRouter } from '@/routers/code-reviews-router';
import { byokRouter } from '@/routers/byok-router';
import { appBuilderRouter } from '@/routers/app-builder-router';
import { securityAgentRouter } from '@/routers/security-agent-router';
import { autoTriageRouter } from '@/routers/auto-triage/auto-triage-router';
import { personalAutoTriageRouter } from '@/routers/personal-auto-triage-router';
import { autoFixRouter } from '@/routers/auto-fix/auto-fix-router';
import { personalAutoFixRouter } from '@/routers/personal-auto-fix-router';
import { appReportedMessagesRouter } from '@/routers/app-reported-messages-router';
import { kiloPassRouter } from '@/routers/kilo-pass-router';
import { agentProfilesRouter } from '@/routers/agent-profiles-router';
import { webhookTriggersRouter } from '@/routers/webhook-triggers-router';
import { userFeedbackRouter } from '@/routers/user-feedback-router';
import { appBuilderFeedbackRouter } from '@/routers/app-builder-feedback-router';

export const rootRouter = createTRPCRouter({
  test: testRouter,
  organizations: organizationsRouter,
  debug: debugRouter,
  user: userRouter,
  admin: adminRouter,
  codeIndexing: codeIndexingRouter,
  deployments: deploymentsRouter,
  cliSessions: cliSessionsRouter,
  cliSessionsV2: cliSessionsV2Router,
  githubApps: githubAppsRouter,
  gitlab: gitlabRouter,
  slack: slackRouter,
  cloudAgent: cloudAgentRouter,
  cloudAgentNext: cloudAgentNextRouter,
  codeReviews: codeReviewRouter,
  personalReviewAgent: personalReviewAgentRouter,
  byok: byokRouter,
  appBuilder: appBuilderRouter,
  securityAgent: securityAgentRouter,
  autoTriage: autoTriageRouter,
  personalAutoTriage: personalAutoTriageRouter,
  autoFix: autoFixRouter,
  personalAutoFix: personalAutoFixRouter,
  appReportedMessages: appReportedMessagesRouter,
  kiloPass: kiloPassRouter,
  agentProfiles: agentProfilesRouter,
  webhookTriggers: webhookTriggersRouter,
  userFeedback: userFeedbackRouter,
  appBuilderFeedback: appBuilderFeedbackRouter,
});
// export type definition of API
export type RootRouter = typeof rootRouter;
