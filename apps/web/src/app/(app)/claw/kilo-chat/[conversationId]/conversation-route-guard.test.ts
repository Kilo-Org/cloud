import {
  kiloChatInstanceRouteDecision,
  conversationRouteDecision,
  conversationSandboxIdFromMembers,
} from './conversation-route-guard';

describe('kilo chat instance route decision', () => {
  it('waits while instance status is loading', () => {
    expect(
      kiloChatInstanceRouteDecision({
        instanceStatus: null,
        isInstanceError: false,
        isInstanceLoading: true,
      })
    ).toBe('pending');
  });

  it('redirects to setup when status loaded successfully without an instance', () => {
    expect(
      kiloChatInstanceRouteDecision({
        instanceStatus: null,
        isInstanceError: false,
        isInstanceLoading: false,
      })
    ).toBe('redirect-no-instance');
  });

  it('is ready when status loaded successfully with an instance', () => {
    expect(
      kiloChatInstanceRouteDecision({
        instanceStatus: 'running',
        isInstanceError: false,
        isInstanceLoading: false,
      })
    ).toBe('ready');
  });

  it('surfaces status errors instead of redirecting to setup', () => {
    expect(
      kiloChatInstanceRouteDecision({
        instanceStatus: null,
        isInstanceError: true,
        isInstanceLoading: false,
      })
    ).toBe('status-error');
  });
});

describe('conversation route guard', () => {
  it('derives the conversation sandbox from the KiloClaw bot member', () => {
    expect(
      conversationSandboxIdFromMembers([
        { id: 'user-1', kind: 'user' },
        { id: 'bot:kiloclaw:sandbox-conversation', kind: 'bot' },
      ])
    ).toBe('sandbox-conversation');
  });

  it('redirects to the no-instance target once the route sandbox is known missing', () => {
    expect(
      conversationRouteDecision({
        conversationMembers: undefined,
        isInstanceError: false,
        isInstanceLoading: false,
        isLeaving: false,
        routeSandboxId: null,
      })
    ).toBe('redirect-no-instance');
  });

  it('blocks rendering when the loaded conversation belongs to another sandbox', () => {
    expect(
      conversationRouteDecision({
        conversationMembers: [
          { id: 'bot:kiloclaw:sandbox-conversation', kind: 'bot' },
          { id: 'user-1', kind: 'user' },
        ],
        isInstanceError: false,
        isInstanceLoading: false,
        isLeaving: false,
        routeSandboxId: 'sandbox-route',
      })
    ).toBe('not-found');
  });

  it('surfaces status errors instead of redirecting deep links to setup', () => {
    expect(
      conversationRouteDecision({
        conversationMembers: undefined,
        isInstanceError: true,
        isInstanceLoading: false,
        isLeaving: false,
        routeSandboxId: null,
      })
    ).toBe('status-error');
  });
});
