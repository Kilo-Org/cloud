import { getCodeReviewDisplayBehavior } from './code-review-stream-behavior';

describe('getCodeReviewDisplayBehavior', () => {
  it('loads persisted history without polling for a nonterminal V1 review', () => {
    expect(
      getCodeReviewDisplayBehavior({
        agentVersion: 'v1',
        status: 'running',
      })
    ).toEqual({
      isHistorical: true,
      isTerminal: false,
      shouldLoadMessages: true,
      shouldPollMessages: false,
      shouldPollStatus: false,
    });
  });

  it('keeps a personal V2 review on the live stream path while polling its status', () => {
    expect(
      getCodeReviewDisplayBehavior({
        agentVersion: 'v2',
        status: 'running',
      })
    ).toEqual({
      isHistorical: false,
      isTerminal: false,
      shouldLoadMessages: false,
      shouldPollMessages: false,
      shouldPollStatus: true,
    });
  });

  it.each(['pending', 'queued', 'running'])(
    'polls organization review transcripts when %s',
    status => {
      expect(
        getCodeReviewDisplayBehavior({
          agentVersion: 'v2',
          status,
          organizationId: 'org-1',
        })
      ).toEqual({
        isHistorical: false,
        isTerminal: false,
        shouldLoadMessages: true,
        shouldPollMessages: true,
        shouldPollStatus: true,
      });
    }
  );

  it.each(['completed', 'failed', 'cancelled', 'interrupted'])(
    'loads the transcript without polling when %s',
    status => {
      expect(
        getCodeReviewDisplayBehavior({
          agentVersion: 'v2',
          status,
          organizationId: 'org-1',
        })
      ).toEqual({
        isHistorical: false,
        isTerminal: true,
        shouldLoadMessages: true,
        shouldPollMessages: false,
        shouldPollStatus: false,
      });
    }
  );
});
