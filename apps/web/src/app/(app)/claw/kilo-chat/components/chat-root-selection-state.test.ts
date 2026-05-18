import {
  getChatRootLandingDecision,
  getSuppressedChatRootPath,
  shouldIgnoreRootEmptyConversationCreateResult,
  shouldStartRootEmptyConversationCreate,
} from './chat-root-selection-state';

describe('getChatRootLandingDecision', () => {
  it('returns open-latest for the most recent conversation from unresolved root', () => {
    expect(
      getChatRootLandingDecision({
        activeConversationId: null,
        hasConversationHistoryData: true,
        hasConversationHistoryError: false,
        hasResolvedRootLanding: false,
        isAutoOpenSuppressed: false,
        isFetchingConversationHistory: false,
        isLoading: false,
        latestConversationId: 'conversation-1',
        sandboxId: 'sandbox-1',
      })
    ).toBe('open-latest');
  });

  it('returns create-empty-conversation when loaded history is empty', () => {
    expect(
      getChatRootLandingDecision({
        activeConversationId: null,
        hasConversationHistoryData: true,
        hasConversationHistoryError: false,
        hasResolvedRootLanding: false,
        isAutoOpenSuppressed: false,
        isFetchingConversationHistory: false,
        isLoading: false,
        latestConversationId: null,
        sandboxId: 'sandbox-1',
      })
    ).toBe('create-empty-conversation');
  });

  it('stays on an explicitly selected conversation', () => {
    expect(
      getChatRootLandingDecision({
        activeConversationId: 'conversation-2',
        hasConversationHistoryData: true,
        hasConversationHistoryError: false,
        hasResolvedRootLanding: false,
        isAutoOpenSuppressed: false,
        isFetchingConversationHistory: false,
        isLoading: false,
        latestConversationId: 'conversation-1',
        sandboxId: 'sandbox-1',
      })
    ).toBe('stay');
  });

  it('does not reconsider landing after the root decision has already resolved', () => {
    expect(
      getChatRootLandingDecision({
        activeConversationId: null,
        hasConversationHistoryData: true,
        hasConversationHistoryError: false,
        hasResolvedRootLanding: true,
        isAutoOpenSuppressed: false,
        isFetchingConversationHistory: false,
        isLoading: false,
        latestConversationId: 'conversation-1',
        sandboxId: 'sandbox-1',
      })
    ).toBe('stay');
  });

  it('stays at root when a redirect explicitly suppresses auto-open', () => {
    expect(
      getChatRootLandingDecision({
        activeConversationId: null,
        hasConversationHistoryData: true,
        hasConversationHistoryError: false,
        hasResolvedRootLanding: false,
        isAutoOpenSuppressed: true,
        isFetchingConversationHistory: false,
        isLoading: false,
        latestConversationId: 'conversation-1',
        sandboxId: 'sandbox-1',
      })
    ).toBe('stay');
    expect(
      getChatRootLandingDecision({
        activeConversationId: null,
        hasConversationHistoryData: true,
        hasConversationHistoryError: false,
        hasResolvedRootLanding: false,
        isAutoOpenSuppressed: true,
        isFetchingConversationHistory: false,
        isLoading: false,
        latestConversationId: null,
        sandboxId: 'sandbox-1',
      })
    ).toBe('stay');
    expect(
      getChatRootLandingDecision({
        activeConversationId: null,
        hasConversationHistoryData: true,
        hasConversationHistoryError: false,
        hasResolvedRootLanding: true,
        isAutoOpenSuppressed: true,
        isFetchingConversationHistory: false,
        isLoading: false,
        latestConversationId: 'conversation-1',
        sandboxId: 'sandbox-1',
      })
    ).toBe('stay');
    expect(
      getChatRootLandingDecision({
        activeConversationId: null,
        hasConversationHistoryData: true,
        hasConversationHistoryError: false,
        hasResolvedRootLanding: false,
        isAutoOpenSuppressed: true,
        isFetchingConversationHistory: true,
        isLoading: false,
        latestConversationId: 'conversation-1',
        sandboxId: 'sandbox-1',
      })
    ).toBe('stay');
  });

  it('waits while conversation history is in an error state', () => {
    expect(
      getChatRootLandingDecision({
        activeConversationId: null,
        hasConversationHistoryData: true,
        hasConversationHistoryError: true,
        hasResolvedRootLanding: false,
        isAutoOpenSuppressed: false,
        isFetchingConversationHistory: false,
        isLoading: false,
        latestConversationId: 'conversation-1',
        sandboxId: 'sandbox-1',
      })
    ).toBe('wait');
  });

  it('waits while history loads, sandbox context is missing, or history is unavailable', () => {
    expect(
      getChatRootLandingDecision({
        activeConversationId: null,
        hasConversationHistoryData: true,
        hasConversationHistoryError: false,
        hasResolvedRootLanding: false,
        isAutoOpenSuppressed: false,
        isFetchingConversationHistory: false,
        isLoading: true,
        latestConversationId: 'conversation-1',
        sandboxId: 'sandbox-1',
      })
    ).toBe('wait');
    expect(
      getChatRootLandingDecision({
        activeConversationId: null,
        hasConversationHistoryData: true,
        hasConversationHistoryError: false,
        hasResolvedRootLanding: false,
        isAutoOpenSuppressed: false,
        isFetchingConversationHistory: true,
        isLoading: false,
        latestConversationId: null,
        sandboxId: 'sandbox-1',
      })
    ).toBe('wait');
    expect(
      getChatRootLandingDecision({
        activeConversationId: null,
        hasConversationHistoryData: true,
        hasConversationHistoryError: false,
        hasResolvedRootLanding: false,
        isAutoOpenSuppressed: false,
        isFetchingConversationHistory: true,
        isLoading: false,
        latestConversationId: 'conversation-1',
        sandboxId: 'sandbox-1',
      })
    ).toBe('wait');
    expect(
      getChatRootLandingDecision({
        activeConversationId: null,
        hasConversationHistoryData: true,
        hasConversationHistoryError: false,
        hasResolvedRootLanding: false,
        isAutoOpenSuppressed: false,
        isFetchingConversationHistory: false,
        isLoading: false,
        latestConversationId: null,
        sandboxId: null,
      })
    ).toBe('wait');
    expect(
      getChatRootLandingDecision({
        activeConversationId: null,
        hasConversationHistoryData: false,
        hasConversationHistoryError: false,
        hasResolvedRootLanding: false,
        isAutoOpenSuppressed: false,
        isFetchingConversationHistory: false,
        isLoading: false,
        latestConversationId: null,
        sandboxId: 'sandbox-1',
      })
    ).toBe('wait');
  });
});

describe('shouldStartRootEmptyConversationCreate', () => {
  it('allows only the first idle empty-conversation attempt for an empty-root landing', () => {
    expect(
      shouldStartRootEmptyConversationCreate({
        hasAttemptedEmptyConversationCreate: false,
        isCreatePending: false,
        landingDecision: 'create-empty-conversation',
        sandboxId: 'sandbox-1',
      })
    ).toBe(true);
    expect(
      shouldStartRootEmptyConversationCreate({
        hasAttemptedEmptyConversationCreate: true,
        isCreatePending: false,
        landingDecision: 'create-empty-conversation',
        sandboxId: 'sandbox-1',
      })
    ).toBe(false);
    expect(
      shouldStartRootEmptyConversationCreate({
        hasAttemptedEmptyConversationCreate: false,
        isCreatePending: true,
        landingDecision: 'create-empty-conversation',
        sandboxId: 'sandbox-1',
      })
    ).toBe(false);
    expect(
      shouldStartRootEmptyConversationCreate({
        hasAttemptedEmptyConversationCreate: false,
        isCreatePending: false,
        landingDecision: 'create-empty-conversation',
        sandboxId: null,
      })
    ).toBe(false);
  });
});

describe('shouldIgnoreRootEmptyConversationCreateResult', () => {
  it('ignores pending empty-conversation results after root landing resolves elsewhere', () => {
    expect(
      shouldIgnoreRootEmptyConversationCreateResult({
        activeConversationId: null,
        currentSandboxId: 'sandbox-1',
        hasResolvedRootLanding: true,
        isAutoOpenSuppressed: false,
        mutationSandboxId: 'sandbox-1',
      })
    ).toBe(true);
  });

  it('accepts the current unresolved root empty-conversation result', () => {
    expect(
      shouldIgnoreRootEmptyConversationCreateResult({
        activeConversationId: null,
        currentSandboxId: 'sandbox-1',
        hasResolvedRootLanding: false,
        isAutoOpenSuppressed: false,
        mutationSandboxId: 'sandbox-1',
      })
    ).toBe(false);
  });
});

describe('getSuppressedChatRootPath', () => {
  it('marks root redirects so root does not auto-open again', () => {
    expect(getSuppressedChatRootPath('/claw/chat')).toBe('/claw/chat?suppressAutoOpen=1');
    expect(getSuppressedChatRootPath('/organizations/org-1/claw/chat')).toBe(
      '/organizations/org-1/claw/chat?suppressAutoOpen=1'
    );
  });
});
