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
const mockFindExistingReviewCommentFixTicket = jest.fn();
const mockParseFixCommand = jest.fn();
const mockAddReactionToPRReviewComment = jest.fn().mockResolvedValue(undefined);
const mockGetCollaboratorPermissionLevel = jest.fn();
const mockIsLikelyKiloBotActor = jest.fn();

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: (...args: unknown[]) => mockGetAgentConfigForOwner(...args),
}));

jest.mock('../../db/fix-tickets', () => ({
  createFixTicket: jest.fn(),
  findExistingReviewCommentFixTicket: (...args: unknown[]) =>
    mockFindExistingReviewCommentFixTicket(...args),
  resetFixTicketForRetry: jest.fn(),
}));

jest.mock('../../dispatch/dispatch-pending-fixes', () => ({
  tryDispatchPendingFixes: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: jest.fn(),
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

const integration = {
  id: 'integration-1',
  owned_by_user_id: 'user-1',
  owned_by_organization_id: null,
  github_app_type: 'standard',
} as unknown as PlatformIntegration;

describe('ReviewCommentWebhookProcessor admission', () => {
  let processor: ReviewCommentWebhookProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: comments are authored by humans, so admission proceeds.
    mockIsLikelyKiloBotActor.mockReturnValue(false);
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
});
