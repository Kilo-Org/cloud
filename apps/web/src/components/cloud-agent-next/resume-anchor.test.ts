import type { PreparationAttempt, SessionCommit } from '@kilocode/cloud-agent-sdk';
import type { AssistantMessage } from '@/types/opencode.gen';
import type { StoredMessage } from './types';
import { groupConversationMessages, commitsByMessageAnchor } from './message-presentation';
import { planResumeAttempt, resumeAnchor, resumeAnchorForTranscript } from './resume-anchor';

describe('resumeAnchor', () => {
  it('resolves the group that starts with the anchor', () => {
    expect(resumeAnchor([['m1'], ['m2'], ['m3']], 'm2')).toEqual({
      groupIndex: 1,
      selectorIds: ['m2', 'm3'],
    });
  });

  it('falls back to the group first id when the anchor is mid-group', () => {
    expect(resumeAnchor([['m1'], ['m2', 'm3'], ['m4']], 'm3')).toEqual({
      groupIndex: 1,
      selectorIds: ['m2', 'm4'],
    });
  });

  it('offers every later group so an unrendered group can be skipped', () => {
    // The anchor's own group can render no element at all (an all-invisible
    // assistant turn), so the caller needs the following groups' handles to
    // land on the nearest group that did render.
    expect(resumeAnchor([['m1'], ['m2'], ['m3'], ['m4']], 'm2')).toEqual({
      groupIndex: 1,
      selectorIds: ['m2', 'm3', 'm4'],
    });
  });

  it('skips an empty group without letting it shift the index', () => {
    expect(resumeAnchor([['m1'], [], ['m2']], 'm2')).toEqual({
      groupIndex: 2,
      selectorIds: ['m2'],
    });
  });

  it('returns null when the anchor is absent', () => {
    expect(resumeAnchor([['m1'], ['m2', 'm3']], 'm9')).toBeNull();
  });

  it('returns null for an empty transcript', () => {
    expect(resumeAnchor([], 'm1')).toBeNull();
  });

  it('returns null without an anchor id', () => {
    expect(resumeAnchor([['m1']], null)).toBeNull();
    expect(resumeAnchor([['m1']], undefined)).toBeNull();
    expect(resumeAnchor([['m1']], '')).toBeNull();
  });
});

const noPreparations = new Map<string, readonly PreparationAttempt[]>();

function assistantMessage(id: string): StoredMessage {
  const info: AssistantMessage = {
    id,
    sessionID: 'ses-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'user-1',
    modelID: 'test-model',
    providerID: 'test-provider',
    mode: 'code',
    agent: 'test-agent',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  return { info, parts: [] };
}

describe('resumeAnchorForTranscript', () => {
  it('groups with the same commit anchors the transcript renders with', () => {
    const first = assistantMessage('assistant-1');
    const second = assistantMessage('assistant-2');
    const commit = {
      commitHash: 'a'.repeat(40),
      commitMessage: 'Actual commit',
      messageId: 'assistant-1',
      userMessageId: 'user-1',
      committedAt: '2026-09-01T10:00:00Z',
      pushStatus: 'unknown',
    } satisfies SessionCommit;
    const commitsAfterMessage = commitsByMessageAnchor([first, second], [commit]);
    expect(commitsAfterMessage.has('assistant-1')).toBe(true);

    // The renderer splits the two assistant messages at the commit boundary...
    expect(
      groupConversationMessages([first, second], noPreparations, commitsAfterMessage).map(group =>
        group.map(message => message.info.id)
      )
    ).toEqual([['assistant-1'], ['assistant-2']]);

    // ...so the resume must resolve the anchor to the second group's own id. A
    // grouping without the commit anchors would merge them and land the anchor
    // on the earlier rendered group's first id instead.
    expect(
      resumeAnchorForTranscript([first, second], noPreparations, commitsAfterMessage, 'assistant-2')
    ).toEqual({ groupIndex: 1, selectorIds: ['assistant-2'] });
  });

  it('keeps the renderer grouping for preparation rows', () => {
    const first = assistantMessage('assistant-1');
    const second = assistantMessage('assistant-2');
    const preparation: PreparationAttempt = {
      id: 'prep-1',
      triggerMessageId: 'assistant-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      revision: 1,
      steps: [],
    };
    const preparationByMessageId = new Map([['assistant-1', [preparation]]]);

    expect(
      resumeAnchorForTranscript([first, second], preparationByMessageId, new Map(), 'assistant-2')
    ).toEqual({ groupIndex: 1, selectorIds: ['assistant-2'] });
  });
});

describe('planResumeAttempt', () => {
  const base = {
    anchorRendered: false,
    anchorResolved: false,
    attempts: 0,
    maxOlderPages: 8,
    hasOlderMessages: true,
    isLoadingOlderMessages: false,
    hasOlderMessagesError: false,
  };

  it('scrolls to the anchor when it rendered', () => {
    expect(planResumeAttempt({ ...base, anchorResolved: true, anchorRendered: true })).toBe(
      'scroll'
    );
  });

  it('follows the tail when the anchor resolved but drew no element', () => {
    // An all-invisible assistant turn renders nothing by design, and no older
    // page can produce a target for an id already in the loaded window: the
    // open must not stay paused with follow off.
    expect(planResumeAttempt({ ...base, anchorResolved: true })).toBe('follow-tail');
  });

  it('follows the tail when the page bound or the history is exhausted', () => {
    expect(planResumeAttempt({ ...base, attempts: 8 })).toBe('follow-tail');
    expect(planResumeAttempt({ ...base, hasOlderMessages: false })).toBe('follow-tail');
  });

  it('follows the tail when the older page failed instead of waiting forever', () => {
    // The resume is one-shot: sitting on a failed page neither completes it nor
    // gives it up, and the reader is stranded paused at the oldest loaded row.
    expect(planResumeAttempt({ ...base, hasOlderMessagesError: true })).toBe('follow-tail');
  });

  it('waits while an older page is in flight', () => {
    expect(planResumeAttempt({ ...base, isLoadingOlderMessages: true })).toBe('wait');
  });

  it('loads one older page when the anchor may still be in it', () => {
    expect(planResumeAttempt(base)).toBe('load-older');
  });
});
