import { describe, expect, it } from 'vitest';

import {
  getCodeReviewDisplayBehavior,
  resolveReviewSpectatorMode,
  retainPolledSpectatorRows,
  reviewSpectatorStreamInfoInterval,
} from './review-spectator-behavior';

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

describe('retainPolledSpectatorRows', () => {
  it('keeps the last non-empty poll when the latest snapshot is empty', () => {
    expect(retainPolledSpectatorRows([], ['kept'], true)).toEqual(['kept']);
  });

  it('uses the latest snapshot when it has rows', () => {
    expect(retainPolledSpectatorRows(['next'], ['kept'], true)).toEqual(['next']);
  });

  it('does not retain empty history after polling stops', () => {
    expect(retainPolledSpectatorRows([], ['kept'], false)).toEqual([]);
  });
});

describe('reviewSpectatorStreamInfoInterval', () => {
  it('polls while stream info has not loaded', () => {
    expect(reviewSpectatorStreamInfoInterval(undefined)).toBe(2000);
  });

  it('polls an in-flight v2 review even after the session id appears', () => {
    expect(
      reviewSpectatorStreamInfoInterval({
        success: true,
        agentVersion: 'v2',
        status: 'running',
        cloudAgentSessionId: 'agent-1',
      })
    ).toBe(2000);
  });

  it('stops polling a terminal review', () => {
    expect(
      reviewSpectatorStreamInfoInterval({
        success: true,
        agentVersion: 'v2',
        status: 'completed',
        cloudAgentSessionId: 'agent-1',
      })
    ).toBe(false);
  });
});

describe('resolveReviewSpectatorMode', () => {
  it('polls messages for an in-progress org review and does not open a live stream', () => {
    expect(
      resolveReviewSpectatorMode(
        {
          agentVersion: 'v2',
          status: 'running',
          organizationId: 'org-1',
          cloudAgentSessionId: 'agent-1',
        },
        'running',
        0
      )
    ).toEqual({
      isTerminal: false,
      shouldPollMessages: true,
      shouldLoadHistory: true,
      liveCloudId: null,
    });
  });

  it('opens a live stream for an in-progress personal review', () => {
    expect(
      resolveReviewSpectatorMode(
        {
          agentVersion: 'v2',
          status: 'running',
          cloudAgentSessionId: 'agent-1',
        },
        'running',
        0
      )
    ).toEqual({
      isTerminal: false,
      shouldPollMessages: false,
      shouldLoadHistory: false,
      liveCloudId: 'agent-1',
    });
  });

  it('loads history when the parent status is already terminal', () => {
    expect(
      resolveReviewSpectatorMode(
        {
          agentVersion: 'v2',
          status: 'running',
          organizationId: 'org-1',
          cloudAgentSessionId: 'agent-1',
        },
        'completed',
        0
      )
    ).toMatchObject({
      isTerminal: true,
      shouldPollMessages: false,
      shouldLoadHistory: true,
      liveCloudId: null,
    });
  });
});
