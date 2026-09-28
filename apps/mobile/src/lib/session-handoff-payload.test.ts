import { sessionResumeUrl } from '@kilocode/app-shared/universal-links';
import { describe, expect, it } from 'vitest';

import { buildSessionHandoff } from './session-handoff-payload';

const SESSION_ID = 'ses_1';
const ANCHOR_ID = 'msg_42';
const TITLE = 'Fix the flaky test';

describe('buildSessionHandoff', () => {
  it('advertises the resume link with the anchor in position', () => {
    expect(
      buildSessionHandoff({ sessionId: SESSION_ID, anchorMessageId: ANCHOR_ID, title: TITLE })
    ).toEqual({
      url: 'https://app.kilo.ai/cloud/sessions/ses_1?at=msg_42',
      title: TITLE,
      isEligibleForHandoff: true,
    });
  });

  it('advertises the session top when there is no anchor', () => {
    expect(buildSessionHandoff({ sessionId: SESSION_ID, title: TITLE }).url).toBe(
      'https://app.kilo.ai/cloud/sessions/ses_1'
    );
    expect(
      buildSessionHandoff({ sessionId: SESSION_ID, anchorMessageId: null, title: TITLE }).url
    ).toBe('https://app.kilo.ai/cloud/sessions/ses_1');
    expect(
      buildSessionHandoff({ sessionId: SESSION_ID, anchorMessageId: '', title: TITLE }).url
    ).toBe('https://app.kilo.ai/cloud/sessions/ses_1');
  });

  it('is the copied link: both values come from sessionResumeUrl', () => {
    for (const anchorMessageId of [ANCHOR_ID, null, '']) {
      expect(
        buildSessionHandoff({ sessionId: SESSION_ID, anchorMessageId, title: TITLE }).url
      ).toBe(sessionResumeUrl({ sessionId: SESSION_ID, anchorMessageId }));
    }

    expect(buildSessionHandoff({ sessionId: 'ses/1 2', title: TITLE }).url).toBe(
      sessionResumeUrl({ sessionId: 'ses/1 2' })
    );
  });

  it('advertises nothing for a session with no id', () => {
    expect(buildSessionHandoff({ sessionId: '', title: TITLE })).toEqual({
      url: null,
      title: TITLE,
      isEligibleForHandoff: true,
    });
  });

  it('stays eligible for handoff in every state and carries the title through', () => {
    for (const sessionId of [SESSION_ID, '']) {
      const handoff = buildSessionHandoff({
        sessionId,
        anchorMessageId: ANCHOR_ID,
        title: TITLE,
      });
      expect(handoff.isEligibleForHandoff).toBe(true);
      expect(handoff.title).toBe(TITLE);
    }
  });
});
