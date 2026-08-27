/**
 * Unit tests for the auto-fix review-comment webhook processor's
 * admission branch. Focuses on the previously-buggy local-regex check
 * (which rejected the product-advertised "@kilocode-bot fix it" command)
 * and the new shared `parseFixCommand` admission.
 *
 * The downstream dispatch path (permission, agent config, ticket
 * creation, dispatch) is intentionally NOT exercised here — it has its
 * own coverage and would require many more mocks. The single side
 * effect we observe is the first function called after admission
 * (`getAgentConfigForOwner`), so when admission is rejected the
 * function returns silently with no further calls; when admission is
 * granted, the mock throws and the test catches the throw.
 */
import type { PlatformIntegration } from '@kilocode/db/schema';
import type { PullRequestReviewCommentPayload } from '@/lib/integrations/platforms/github/webhook-schemas';

const mockGetAgentConfigForOwner = jest.fn();
const mockCreateFixTicket = jest.fn();
const mockFindExistingReviewCommentFixTicket = jest.fn();
const mockResetFixTicketForRetry = jest.fn();
const mockTryDispatchPendingFixes = jest.fn();
const mockGetBotUserId = jest.fn();
const mockParseFixCommand = jest.fn();
const mockAddReactionToPRReviewComment = jest.fn().mockResolvedValue(undefined);
const mockGetCollaboratorPermissionLevel = jest.fn();
const mockIsLikelyKiloBotActor = jest.fn();
const mockGetPrimaryGitHubIntegrationForOrganization = jest.fn();

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: (...args: unknown[]) => mockGetAgentConfigForOwner(...args),
}));

jest.mock('../../db/fix-tickets', () => ({
  createFixTicket: (...args: unknown[]) => mockCreateFixTicket(...args),
  findExistingReviewCommentFixTicket: (...args: unknown[]) =>
    mockFindExistingReviewCommentFixTicket(...args),
  resetFixTicketForRetry: (...args: unknown[]) => mockResetFixTicketForRetry(...args),
}));

jest.mock('../../dispatch/dispatch-pending-fixes', () => ({
  tryDispatchPendingFixes: (...args: unknown[]) => mockTryDispatchPendingFixes(...args),
}));

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: (...args: unknown[]) => mockGetBotUserId(...args),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  addReactionToPRReviewComment: (...args: unknown[]) => mockAddReactionToPRReviewComment(...args),
  getCollaboratorPermissionLevel: (...args: unknown[]) =>
    mockGetCollaboratorPermissionLevel(...args),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@kilocode/app-shared/code-review', () => ({
  parseFixCommand: (text: string) => mockParseFixCommand(text),
}));

jest.mock('@/lib/code-reviews/review-memory/github-feedback', () => ({
  isLikelyKiloBotActor: (...args: unknown[]) => mockIsLikelyKiloBotActor(...args),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getPrimaryGitHubIntegrationForOrganization: (...args: unknown[]) =>
    mockGetPrimaryGitHubIntegrationForOrganization(...args),
}));

import { ReviewCommentWebhookProcessor } from './review-comment-webhook-processor';

function buildPayload(body: string): PullRequestReviewCommentPayload {
  return {
    action: 'created',
    comment: {
      id: 1,
      body,
      user: { login: 'maintainer' },
      in_reply_to_id: null,
      created_at: '2026-07-23T00:00:00.000Z',
      html_url: 'https://github.com/acme/widgets/pull/42#discussion_r1',
      path: 'src/widget.ts',
      line: 10,
      diff_hunk: '@@',
      // MEMBER is in WRITE_ACCESS_ASSOCIATIONS so the permission API
      // fallback (also mocked) is skipped.
      author_association: 'MEMBER',
    },
    pull_request: {
      number: 42,
      title: 'Test PR',
      html_url: 'https://github.com/acme/widgets/pull/42',
      user: { login: 'contributor' },
      head: { sha: 'abc123', ref: 'feature' },
      base: { ref: 'main' },
    },
    repository: {
      id: 1,
      name: 'widgets',
      full_name: 'acme/widgets',
      private: true,
      owner: { login: 'acme' },
    },
    installation: { id: 123 },
    sender: { login: 'maintainer' },
  };
}

const integrationId = '123e4567-e89b-12d3-a456-426614174001';
const integration = {
  id: integrationId,
  owned_by_user_id: 'user-1',
  owned_by_organization_id: null,
  github_app_type: 'standard',
} as unknown as PlatformIntegration;

const enabledConfig = {
  is_enabled: true,
  config: {
    enabled_for_issues: true,
    enabled_for_review_comments: true,
    repository_selection_mode: 'all',
    selected_repository_ids: [],
    skip_labels: [],
    required_labels: [],
    model_slug: 'anthropic/claude-sonnet-4.5',
    custom_instructions: null,
    pr_title_template: 'Fix #{issue_number}: {issue_title}',
    pr_body_template: null,
    pr_base_branch: 'main',
    max_pr_creation_time_minutes: 15,
    max_concurrent_per_owner: 3,
  },
};

describe('ReviewCommentWebhookProcessor admission', () => {
  let processor: ReviewCommentWebhookProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: comments are authored by humans, so admission proceeds.
    mockIsLikelyKiloBotActor.mockReturnValue(false);
    mockFindExistingReviewCommentFixTicket.mockResolvedValue(null);
    mockResetFixTicketForRetry.mockResolvedValue(undefined);
    mockTryDispatchPendingFixes.mockResolvedValue(undefined);
    mockCreateFixTicket.mockResolvedValue('ticket-1');
    mockGetPrimaryGitHubIntegrationForOrganization.mockResolvedValue(integration);
    processor = new ReviewCommentWebhookProcessor();
  });

  it('admits the product-advertised @kilocode-bot fix it command (regression evidence)', async () => {
    // Real shared parser behavior is asserted in the shared package's
    // mention-command.test.ts. Here we verify the processor delegates
    // admission to the shared parser and proceeds to the next step.
    const body = '@kilocode-bot fix it';
    mockParseFixCommand.mockReturnValue(true);
    // First call after admission — when this throws we know admission
    // was granted.
    mockGetAgentConfigForOwner.mockRejectedValue(new Error('admitted'));

    await expect(processor.process(buildPayload(body), integration)).rejects.toThrow('admitted');

    expect(mockParseFixCommand).toHaveBeenCalledWith(body);
    expect(mockGetAgentConfigForOwner).toHaveBeenCalledTimes(1);
  });

  it('admits the existing shorthand @kilo fix', async () => {
    const body = '@kilo fix this';
    mockParseFixCommand.mockReturnValue(true);
    mockGetAgentConfigForOwner.mockRejectedValue(new Error('admitted'));

    await expect(processor.process(buildPayload(body), integration)).rejects.toThrow('admitted');

    expect(mockParseFixCommand).toHaveBeenCalledWith(body);
    expect(mockGetAgentConfigForOwner).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-matching body without calling getAgentConfigForOwner', async () => {
    const body = 'please fix this';
    mockParseFixCommand.mockReturnValue(false);

    await processor.process(buildPayload(body), integration);

    expect(mockParseFixCommand).toHaveBeenCalledWith(body);
    expect(mockGetAgentConfigForOwner).not.toHaveBeenCalled();
    expect(mockFindExistingReviewCommentFixTicket).not.toHaveBeenCalled();
  });

  it('rejects a mention-only body (no fix keyword) without further processing', async () => {
    const body = '@kilocode-bot ship it';
    mockParseFixCommand.mockReturnValue(false);

    await processor.process(buildPayload(body), integration);

    expect(mockParseFixCommand).toHaveBeenCalledWith(body);
    expect(mockGetAgentConfigForOwner).not.toHaveBeenCalled();
  });

  it('ignores a comment authored by Kilo itself before parsing (no self thumbs-down)', async () => {
    // Regression: Kilo's own inline comments carry the advertised
    // "Reply with `@kilocode-bot fix it` …" footer, which parseFixCommand
    // would admit. The bot must never process its own comment — doing so
    // previously produced a thumbs-down (-1) reaction on its own review
    // comment because the author write-access check fails for the bot.
    const body =
      'Some finding.\n\n---\nReply with `@kilocode-bot fix it` to have Kilo Code address this issue.';
    const payload = buildPayload(body);
    payload.comment.user.login = 'kilo-code-bot[bot]';
    // author_association from a GitHub App bot is NONE, but the guard must
    // short-circuit before we ever reach the permission check or the parser.
    payload.comment.author_association = 'NONE';
    mockIsLikelyKiloBotActor.mockReturnValue(true);

    await processor.process(payload, integration);

    expect(mockIsLikelyKiloBotActor).toHaveBeenCalledWith('kilo-code-bot[bot]');
    expect(mockParseFixCommand).not.toHaveBeenCalled();
    expect(mockGetCollaboratorPermissionLevel).not.toHaveBeenCalled();
    expect(mockAddReactionToPRReviewComment).not.toHaveBeenCalled();
    expect(mockGetAgentConfigForOwner).not.toHaveBeenCalled();
  });

  it('keeps legacy retry GitHub API operations on the delivering installation', async () => {
    mockParseFixCommand.mockReturnValue(true);
    mockGetAgentConfigForOwner.mockResolvedValue(enabledConfig);
    mockFindExistingReviewCommentFixTicket.mockResolvedValue({
      id: 'ticket-existing',
      status: 'failed',
      platform_integration_id: null,
    });

    await processor.process(buildPayload('@kilo fix'), integration);

    expect(mockResetFixTicketForRetry).toHaveBeenCalledWith('ticket-existing');
    expect(mockAddReactionToPRReviewComment).toHaveBeenCalledWith(
      '123',
      'acme',
      'widgets',
      1,
      'eyes',
      'standard'
    );
  });

  it('does not retry through a sibling installation', async () => {
    mockParseFixCommand.mockReturnValue(true);
    mockGetAgentConfigForOwner.mockResolvedValue(enabledConfig);
    mockFindExistingReviewCommentFixTicket.mockResolvedValue({
      id: 'ticket-existing',
      status: 'failed',
      platform_integration_id: '123e4567-e89b-12d3-a456-426614174002',
    });

    await processor.process(buildPayload('@kilo fix'), integration);

    expect(mockResetFixTicketForRetry).not.toHaveBeenCalled();
    expect(mockTryDispatchPendingFixes).not.toHaveBeenCalled();
  });

  it('does not infer a secondary installation for an unpinned legacy ticket', async () => {
    const organizationIntegration = {
      ...integration,
      owned_by_user_id: null,
      owned_by_organization_id: 'organization-1',
    } as PlatformIntegration;
    mockParseFixCommand.mockReturnValue(true);
    mockFindExistingReviewCommentFixTicket.mockResolvedValue({
      id: 'ticket-existing',
      status: 'failed',
      platform_integration_id: null,
    });
    mockGetPrimaryGitHubIntegrationForOrganization.mockResolvedValue({
      id: '123e4567-e89b-12d3-a456-426614174003',
    });

    await processor.process(buildPayload('@kilo fix'), organizationIntegration);

    expect(mockResetFixTicketForRetry).not.toHaveBeenCalled();
    expect(mockTryDispatchPendingFixes).not.toHaveBeenCalled();
  });
});
