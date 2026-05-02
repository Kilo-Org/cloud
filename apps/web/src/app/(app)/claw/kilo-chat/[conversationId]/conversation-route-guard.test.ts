import {
  conversationRouteDecision,
  conversationSandboxIdFromMembers,
} from './conversation-route-guard';

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
        isInstanceLoading: false,
        isLeaving: false,
        routeSandboxId: 'sandbox-route',
      })
    ).toBe('not-found');
  });
});
