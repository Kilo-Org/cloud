import { describe, expect, it } from 'vitest';

import * as universalLinks from './index';
import {
  SESSION_RESUME_ANCHOR_PARAM,
  anchorPosition,
  readSessionResume,
  resolveIncomingResume,
  sessionResumeUrl,
} from './resume-link';

const WEB = 'https://app.kilo.ai';
const SESSION_ID = 'ses_1';
const ANCHOR_ID = 'msg_42';

describe('sessionResumeUrl', () => {
  it('builds the https link without an anchor', () => {
    expect(sessionResumeUrl({ sessionId: SESSION_ID })).toBe(`${WEB}/cloud/sessions/ses_1`);
  });

  it('appends the anchor query for a non-empty anchor', () => {
    expect(sessionResumeUrl({ sessionId: SESSION_ID, anchorMessageId: ANCHOR_ID })).toBe(
      `${WEB}/cloud/sessions/ses_1?at=msg_42`
    );
  });

  it('omits the query for a null, undefined or empty anchor', () => {
    const base = `${WEB}/cloud/sessions/ses_1`;
    expect(sessionResumeUrl({ sessionId: SESSION_ID, anchorMessageId: null })).toBe(base);
    expect(sessionResumeUrl({ sessionId: SESSION_ID, anchorMessageId: undefined })).toBe(base);
    expect(sessionResumeUrl({ sessionId: SESSION_ID, anchorMessageId: '' })).toBe(base);
  });

  it('percent-encodes the id and the anchor exactly once', () => {
    const url = sessionResumeUrl({ sessionId: 'ses/1', anchorMessageId: 'msg 2' });
    expect(url).toBe(`${WEB}/cloud/sessions/ses%2F1?at=msg%202`);
    expect(url).not.toContain('%252F');
    expect(url).not.toContain('%2520');
  });

  it('uses the anchor parameter name the parser reads', () => {
    expect(SESSION_RESUME_ANCHOR_PARAM).toBe('at');
    expect(sessionResumeUrl({ sessionId: SESSION_ID, anchorMessageId: ANCHOR_ID })).toContain(
      `?${SESSION_RESUME_ANCHOR_PARAM}=`
    );
  });
});

describe('readSessionResume', () => {
  it('round-trips sessionResumeUrl without an anchor', () => {
    for (const target of [{ sessionId: SESSION_ID }, { sessionId: 'ses/1' }]) {
      expect(readSessionResume(sessionResumeUrl(target))).toEqual({
        sessionId: target.sessionId,
        anchorMessageId: null,
      });
    }
  });

  it('round-trips sessionResumeUrl with an anchor', () => {
    const url = sessionResumeUrl({ sessionId: 'ses/1', anchorMessageId: 'msg 2' });
    expect(readSessionResume(url)).toEqual({
      sessionId: 'ses/1',
      anchorMessageId: 'msg 2',
    });
  });

  it('reads the https form', () => {
    expect(readSessionResume(`${WEB}/cloud/sessions/ses_1?at=msg_42`)).toEqual({
      sessionId: 'ses_1',
      anchorMessageId: 'msg_42',
    });
  });

  it('reads the kiloapp:/// form', () => {
    expect(readSessionResume('kiloapp:///cloud/sessions/ses_1?at=msg_42')).toEqual({
      sessionId: 'ses_1',
      anchorMessageId: 'msg_42',
    });
  });

  it('decodes the id and the anchor once', () => {
    expect(readSessionResume(`${WEB}/cloud/sessions/a%2Fb?at=m%202`)).toEqual({
      sessionId: 'a/b',
      anchorMessageId: 'm 2',
    });
    // A double encode would decode to the still-encoded text.
    expect(readSessionResume(`${WEB}/cloud/sessions/a%252Fb`)).toEqual({
      sessionId: 'a%2Fb',
      anchorMessageId: null,
    });
  });

  it('returns null for an unknown host or scheme', () => {
    expect(readSessionResume('https://evil.example.com/cloud/sessions/ses_1?at=msg_42')).toBeNull();
    expect(readSessionResume('https://kilo.ai/cloud/sessions/ses_1?at=msg_42')).toBeNull();
    expect(readSessionResume('ftp://app.kilo.ai/cloud/sessions/ses_1?at=msg_42')).toBeNull();
  });

  it('returns null for an unknown path', () => {
    expect(readSessionResume(`${WEB}/cloud/sessions?at=msg_42`)).toBeNull();
    expect(readSessionResume(`${WEB}/cloud/sessions/ses_1/extra?at=msg_42`)).toBeNull();
    expect(readSessionResume(`${WEB}/profile?at=msg_42`)).toBeNull();
    expect(readSessionResume(`${WEB}/`)).toBeNull();
    expect(readSessionResume('kiloapp:///profile?at=msg_42')).toBeNull();
  });

  it('returns a null anchor for a missing or empty at', () => {
    expect(readSessionResume(`${WEB}/cloud/sessions/ses_1`)).toEqual({
      sessionId: 'ses_1',
      anchorMessageId: null,
    });
    expect(readSessionResume(`${WEB}/cloud/sessions/ses_1?at=`)).toEqual({
      sessionId: 'ses_1',
      anchorMessageId: null,
    });
    expect(readSessionResume(`${WEB}/cloud/sessions/ses_1?at`)).toEqual({
      sessionId: 'ses_1',
      anchorMessageId: null,
    });
  });

  it('ignores other query parameters and a fragment', () => {
    expect(readSessionResume(`${WEB}/cloud/sessions/ses_1?foo=1&at=msg_42&bar=2`)).toEqual({
      sessionId: 'ses_1',
      anchorMessageId: 'msg_42',
    });
    expect(readSessionResume(`${WEB}/cloud/sessions/ses_1?at=msg_42#section`)).toEqual({
      sessionId: 'ses_1',
      anchorMessageId: 'msg_42',
    });
  });

  it('does not read a query that sits inside a fragment', () => {
    // The fragment starts before the `?`, so everything after it is fragment
    // text: the session still opens, but no anchor is adopted from it.
    expect(readSessionResume(`${WEB}/cloud/sessions/ses_1#section?at=msg_42`)).toEqual({
      sessionId: 'ses_1',
      anchorMessageId: null,
    });
    expect(readSessionResume('kiloapp:///cloud/sessions/ses_1#section?at=msg_42')).toEqual({
      sessionId: 'ses_1',
      anchorMessageId: null,
    });
  });

  it('never throws on garbage', () => {
    const garbage = [
      'not a url',
      '',
      'kiloapp://',
      `${WEB}/cloud/sessions/%E0%A4%A`,
      `${WEB}/cloud/sessions/ses_1?at=%E0%A4%A`,
    ] as const;

    for (const raw of garbage) {
      expect(() => readSessionResume(raw)).not.toThrow();
      const result = readSessionResume(raw);
      if (raw.startsWith(`${WEB}/cloud/sessions/ses_1`)) {
        expect(result).toEqual({ sessionId: 'ses_1', anchorMessageId: null });
      } else {
        expect(result).toBeNull();
      }
    }
  });
});

describe('resolveIncomingResume', () => {
  it('returns the agent-chat href and the anchor for the session link', () => {
    expect(resolveIncomingResume(`${WEB}/cloud/sessions/ses_1?at=msg_42`)).toEqual({
      href: '/(app)/agent-chat/ses_1',
      anchorMessageId: 'msg_42',
    });
  });

  it('returns the href with a null anchor for a session link without at', () => {
    expect(resolveIncomingResume('kiloapp:///cloud/sessions/ses_1')).toEqual({
      href: '/(app)/agent-chat/ses_1',
      anchorMessageId: null,
    });
  });

  it('wraps the other rows with a null anchor', () => {
    expect(resolveIncomingResume(`${WEB}/profile`)).toEqual({
      href: '/(app)/(tabs)/(3_profile)',
      anchorMessageId: null,
    });
  });

  it('returns null exactly where resolveIncomingUrl does', () => {
    for (const raw of ['https://evil.example.com/cloud/sessions/ses_1?at=msg_42', 'not a url']) {
      expect(resolveIncomingResume(raw)).toBeNull();
    }
  });
});

describe('anchorPosition', () => {
  const ORDERED = ['msg_1', 'msg_2', 'msg_3'] as const;

  it('returns the index of an exact hit', () => {
    expect(anchorPosition(ORDERED, 'msg_2')).toBe(1);
    expect(anchorPosition(ORDERED, 'msg_1')).toBe(0);
    expect(anchorPosition(ORDERED, 'msg_3')).toBe(2);
  });

  it('returns null for an id absent from the list', () => {
    expect(anchorPosition(ORDERED, 'msg_404')).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(anchorPosition([], 'msg_1')).toBeNull();
  });

  it('returns null for an empty anchor', () => {
    expect(anchorPosition(ORDERED, '')).toBeNull();
  });
});

describe('universal-links entry point', () => {
  it('names the resume-link interface from index.ts', () => {
    expect(universalLinks.SESSION_RESUME_ANCHOR_PARAM).toBe('at');
    expect(universalLinks.sessionResumeUrl).toBe(sessionResumeUrl);
    expect(universalLinks.readSessionResume).toBe(readSessionResume);
    expect(universalLinks.resolveIncomingResume).toBe(resolveIncomingResume);
    expect(universalLinks.anchorPosition).toBe(anchorPosition);
  });
});
