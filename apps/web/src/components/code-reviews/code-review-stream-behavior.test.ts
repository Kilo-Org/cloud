import { getCodeReviewDisplayBehavior } from './code-review-stream-behavior';

describe('getCodeReviewDisplayBehavior', () => {
  it('loads persisted history without polling for a nonterminal V1 review', () => {
    expect(
      getCodeReviewDisplayBehavior({
        agentVersion: 'v1',
        status: 'running',
        cloudAgentSessionId: 'agent_historical',
      })
    ).toEqual({
      isHistorical: true,
      isTerminal: false,
      shouldLoadHistory: true,
      shouldPollStatus: false,
    });
  });

  it('keeps an active V2 review on the live stream path', () => {
    expect(
      getCodeReviewDisplayBehavior({
        agentVersion: 'v2',
        status: 'running',
        cloudAgentSessionId: 'agent_current',
      })
    ).toEqual({
      isHistorical: false,
      isTerminal: false,
      shouldLoadHistory: false,
      shouldPollStatus: false,
    });
  });

  it('polls while a V2 review is waiting for its session', () => {
    expect(
      getCodeReviewDisplayBehavior({
        agentVersion: 'v2',
        status: 'queued',
        cloudAgentSessionId: null,
      })
    ).toEqual({
      isHistorical: false,
      isTerminal: false,
      shouldLoadHistory: false,
      shouldPollStatus: true,
    });
  });
});
