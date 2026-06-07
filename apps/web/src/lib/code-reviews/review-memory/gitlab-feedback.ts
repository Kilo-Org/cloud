import type { CodeReviewFeedbackSubject, PlatformIntegration } from '@kilocode/db/schema';
import type {
  EmojiEventPayload,
  MergeRequestPayload,
  NoteEventPayload,
} from '@/lib/integrations/platforms/gitlab/webhook-schemas';
import {
  createReviewMemoryDedupeHash,
  findFeedbackSubject,
  findFeedbackSubjectByExternalThreadId,
  hasFeedbackEventForSubject,
  listFeedbackSubjectsForPullRequest,
  recordFeedbackEvent,
  refreshAggregationStateForScope,
  updateFeedbackSubjectState,
  upsertFeedbackSubject,
  type ReviewMemoryOwner,
} from './db';
import { classifyReviewCommentReply } from './reply-classification';
import { isReviewMemoryEnabled } from './settings';
import { isLikelyKiloInlineReviewBody, parseReviewFindingMetadata } from './sync-subjects';

type GitLabFeedbackResult = {
  recorded: boolean;
  eventIds: string[];
  reason?: string;
};

type GitLabActor =
  | {
      name?: string;
      username?: string;
    }
  | null
  | undefined;

const POSITIVE_EMOJI = new Set(['thumbsup', '+1', 'heart', 'rocket', 'tada']);
const NEGATIVE_EMOJI = new Set(['thumbsdown', '-1', 'confused']);
const CREATE_EMOJI_ACTIONS = new Set(['award', 'create', 'created']);
const KILO_GITLAB_ACTOR_NAMES = new Set(['kilo code review bot', 'kilo code reviews']);
const KILO_GITLAB_ACTOR_USERNAMES = new Set([
  'kilo-code-review-bot',
  'kilo-code-reviews',
  'kilo_code_review_bot',
  'kilo_code_reviews',
]);
const REPLY_STYLE_SIGNAL_KINDS = ['corrective_reply', 'supportive_reply'] as const;

function skipped(reason: string): GitLabFeedbackResult {
  return { recorded: false, eventIds: [], reason };
}

function ownerFromIntegration(integration: PlatformIntegration): ReviewMemoryOwner | null {
  if (integration.owned_by_organization_id) {
    return { type: 'org', id: integration.owned_by_organization_id };
  }
  if (integration.owned_by_user_id) {
    return { type: 'user', id: integration.owned_by_user_id };
  }
  return null;
}

function isLikelyKiloActor(actor: GitLabActor): boolean {
  const username = actor?.username?.toLowerCase().trim() ?? '';
  const name = actor?.name?.toLowerCase().replace(/\s+/g, ' ').trim() ?? '';
  return KILO_GITLAB_ACTOR_USERNAMES.has(username) || KILO_GITLAB_ACTOR_NAMES.has(name);
}

function emojiSentiment(name: string): {
  signalKind: 'positive_reaction' | 'negative_reaction';
  sentiment: 'positive' | 'negative';
  strength: number;
} | null {
  if (POSITIVE_EMOJI.has(name)) {
    return { signalKind: 'positive_reaction', sentiment: 'positive', strength: 2 };
  }
  if (NEGATIVE_EMOJI.has(name)) {
    return { signalKind: 'negative_reaction', sentiment: 'negative', strength: 3 };
  }
  return null;
}

async function findExistingGitLabNoteSubject(params: {
  owner: ReviewMemoryOwner;
  repoFullName: string;
  noteId: number;
}): Promise<CodeReviewFeedbackSubject | null> {
  return (
    (await findFeedbackSubject({
      owner: params.owner,
      platform: 'gitlab',
      repoFullName: params.repoFullName,
      subjectType: 'discussion',
      externalId: String(params.noteId),
    })) ??
    (await findFeedbackSubject({
      owner: params.owner,
      platform: 'gitlab',
      repoFullName: params.repoFullName,
      subjectType: 'summary_comment',
      externalId: String(params.noteId),
    }))
  );
}

async function upsertKiloNoteSubject(params: {
  owner: ReviewMemoryOwner;
  repoFullName: string;
  platformProjectId: number;
  prNumber: number | null;
  note: {
    id: number;
    body: string;
    discussionId?: string | null;
    filePath?: string | null;
  };
}): Promise<CodeReviewFeedbackSubject | null> {
  const isSummary = params.note.body.includes('<!-- kilo-review -->');
  const isDiscussion = isLikelyKiloInlineReviewBody(params.note.body);
  if (!isSummary && !isDiscussion) return null;

  const metadata = isDiscussion ? parseReviewFindingMetadata(params.note.body) : null;
  return await upsertFeedbackSubject({
    owner: params.owner,
    platform: 'gitlab',
    subjectType: isSummary ? 'summary_comment' : 'discussion',
    externalId: String(params.note.id),
    externalThreadId: params.note.discussionId ?? null,
    repoFullName: params.repoFullName,
    platformProjectId: params.platformProjectId,
    prNumber: params.prNumber,
    filePath: params.note.filePath ?? null,
    findingTitle: metadata?.findingTitle ?? null,
    findingFingerprint: metadata?.findingFingerprint ?? null,
    state: 'active',
  });
}

function positionFilePath(
  position: NoteEventPayload['object_attributes']['position']
): string | null {
  return position?.new_path ?? position?.old_path ?? null;
}

export async function handleGitLabNoteFeedback(input: {
  payload: NoteEventPayload;
  integration: PlatformIntegration;
  deliveryId: string;
}): Promise<GitLabFeedbackResult> {
  const note = input.payload.object_attributes;
  if (note.noteable_type !== 'MergeRequest' || !input.payload.merge_request) {
    return skipped('not-merge-request-note');
  }

  const owner = ownerFromIntegration(input.integration);
  if (!owner) return skipped('missing-owner');
  if (!(await isReviewMemoryEnabled({ owner, platform: 'gitlab' }))) {
    return skipped('review-memory-disabled');
  }

  const repoFullName = input.payload.project.path_with_namespace;
  const prNumber = input.payload.merge_request.iid;
  const action = note.action ?? 'create';

  if (action === 'update') {
    const subject = await upsertKiloNoteSubject({
      owner,
      repoFullName,
      platformProjectId: input.payload.project.id,
      prNumber,
      note: {
        id: note.id,
        body: note.note,
        discussionId: note.discussion_id ?? null,
        filePath: positionFilePath(note.position),
      },
    });
    return subject ? skipped('subject-synced') : skipped('not-kilo-subject');
  }

  if (action !== 'create') return skipped('unsupported-note-action');
  if (note.system) return skipped('system-note');
  if (isLikelyKiloActor(input.payload.user)) return skipped('bot-authored-note');

  const subject = note.discussion_id
    ? await findFeedbackSubjectByExternalThreadId({
        owner,
        platform: 'gitlab',
        repoFullName,
        subjectType: 'discussion',
        externalThreadId: note.discussion_id,
      })
    : await findExistingGitLabNoteSubject({ owner, repoFullName, noteId: note.id });

  if (!subject) return skipped('not-kilo-subject');

  if (
    await hasFeedbackEventForSubject({
      owner,
      subjectId: subject.id,
      signalKinds: [...REPLY_STYLE_SIGNAL_KINDS],
    })
  ) {
    return skipped('subject-already-has-reply-feedback');
  }

  const classification = classifyReviewCommentReply(note.note);
  const eventKey = `gitlab:${input.deliveryId}:note:${note.id}`;
  const result = await recordFeedbackEvent({
    owner,
    platform: 'gitlab',
    subjectId: subject.id,
    repoFullName,
    platformProjectId: input.payload.project.id,
    prNumber,
    signalKind: classification.signalKind,
    sentiment: classification.sentiment,
    strength: classification.strength,
    dedupeHash: createReviewMemoryDedupeHash([eventKey]),
    evidenceExcerpt: note.note,
    occurredAt: note.created_at,
  });

  return { recorded: result.created, eventIds: [result.event.id] };
}

export async function handleGitLabEmojiFeedback(input: {
  payload: EmojiEventPayload;
  integration: PlatformIntegration;
  deliveryId: string;
}): Promise<GitLabFeedbackResult> {
  const emoji = input.payload.object_attributes;
  const action = emoji.action ?? 'award';
  if (!CREATE_EMOJI_ACTIONS.has(action)) return skipped('emoji-not-created');
  if (isLikelyKiloActor(input.payload.user)) return skipped('bot-authored-emoji');
  if (emoji.awardable_type.toLowerCase() !== 'note') return skipped('unsupported-awardable-type');

  const owner = ownerFromIntegration(input.integration);
  if (!owner) return skipped('missing-owner');
  if (!(await isReviewMemoryEnabled({ owner, platform: 'gitlab' }))) {
    return skipped('review-memory-disabled');
  }

  const sentiment = emojiSentiment(emoji.name);
  if (!sentiment) return skipped('unsupported-emoji');

  const repoFullName = input.payload.project.path_with_namespace;
  const noteId = input.payload.note?.id ?? emoji.awardable_id;
  let subject = await findExistingGitLabNoteSubject({ owner, repoFullName, noteId });
  const noteBody = input.payload.note?.note ?? input.payload.note?.body ?? '';
  if (!subject && noteBody) {
    subject = await upsertKiloNoteSubject({
      owner,
      repoFullName,
      platformProjectId: input.payload.project.id,
      prNumber: input.payload.merge_request?.iid ?? null,
      note: {
        id: noteId,
        body: noteBody,
        filePath: input.payload.note?.position?.new_path ?? input.payload.note?.position?.old_path,
      },
    });
  }

  if (!subject) return skipped('not-kilo-subject');

  const eventKey = `gitlab:${input.deliveryId}:emoji:${emoji.id}`;
  const result = await recordFeedbackEvent({
    owner,
    platform: 'gitlab',
    subjectId: subject.id,
    repoFullName,
    platformProjectId: input.payload.project.id,
    prNumber: input.payload.merge_request?.iid ?? subject.pr_number,
    signalKind: sentiment.signalKind,
    sentiment: sentiment.sentiment,
    strength: sentiment.strength,
    dedupeHash: createReviewMemoryDedupeHash([eventKey]),
    evidenceExcerpt: null,
    occurredAt: emoji.created_at ?? null,
  });

  return { recorded: result.created, eventIds: [result.event.id] };
}

async function recordGitLabMrLevelSignal(input: {
  payload: MergeRequestPayload;
  owner: ReviewMemoryOwner;
  deliveryId: string;
  signalKind: 'mr_approved' | 'mr_unapproved';
  sentiment: 'positive' | 'negative';
  evidenceExcerpt: string;
}) {
  const eventKey = `gitlab:${input.deliveryId}:merge-request:${input.payload.object_attributes.id}:${input.signalKind}`;
  return await recordFeedbackEvent({
    owner: input.owner,
    platform: 'gitlab',
    repoFullName: input.payload.project.path_with_namespace,
    platformProjectId: input.payload.project.id,
    prNumber: input.payload.object_attributes.iid,
    signalKind: input.signalKind,
    sentiment: input.sentiment,
    strength: 1,
    dedupeHash: createReviewMemoryDedupeHash([eventKey]),
    evidenceExcerpt: null,
    occurredAt: input.payload.object_attributes.updated_at,
  });
}

export async function handleGitLabMergeRequestFeedback(input: {
  payload: MergeRequestPayload;
  integration: PlatformIntegration;
  deliveryId: string;
}): Promise<GitLabFeedbackResult> {
  const owner = ownerFromIntegration(input.integration);
  if (!owner) return skipped('missing-owner');
  if (!(await isReviewMemoryEnabled({ owner, platform: 'gitlab' }))) {
    return skipped('review-memory-disabled');
  }

  const eventIds: string[] = [];
  const action = input.payload.object_attributes.action;
  if (action === 'approved' || action === 'approval') {
    const result = await recordGitLabMrLevelSignal({
      payload: input.payload,
      owner,
      deliveryId: input.deliveryId,
      signalKind: 'mr_approved',
      sentiment: 'positive',
      evidenceExcerpt: 'Merge request approved.',
    });
    eventIds.push(result.event.id);
  }

  if (action === 'unapproved' || action === 'unapproval') {
    const result = await recordGitLabMrLevelSignal({
      payload: input.payload,
      owner,
      deliveryId: input.deliveryId,
      signalKind: 'mr_unapproved',
      sentiment: 'negative',
      evidenceExcerpt: 'Merge request approval removed.',
    });
    eventIds.push(result.event.id);
  }

  const blockingDiscussionChange = input.payload.changes?.blocking_discussions_resolved;
  if (
    blockingDiscussionChange &&
    blockingDiscussionChange.previous !== blockingDiscussionChange.current &&
    typeof blockingDiscussionChange.current === 'boolean'
  ) {
    const subjects = await listFeedbackSubjectsForPullRequest({
      owner,
      platform: 'gitlab',
      repoFullName: input.payload.project.path_with_namespace,
      prNumber: input.payload.object_attributes.iid,
      subjectTypes: ['discussion'],
    });
    const signalKind = blockingDiscussionChange.current ? 'thread_resolved' : 'thread_unresolved';
    const sentiment = blockingDiscussionChange.current ? 'positive' : 'negative';

    for (const subject of subjects) {
      await updateFeedbackSubjectState({
        subjectId: subject.id,
        state: blockingDiscussionChange.current ? 'resolved' : 'active',
      });
      const eventKey = `gitlab:${input.deliveryId}:discussion:${subject.id}:${signalKind}`;
      const result = await recordFeedbackEvent({
        owner,
        platform: 'gitlab',
        subjectId: subject.id,
        repoFullName: input.payload.project.path_with_namespace,
        platformProjectId: input.payload.project.id,
        prNumber: input.payload.object_attributes.iid,
        signalKind,
        sentiment,
        strength: 2,
        dedupeHash: createReviewMemoryDedupeHash([eventKey]),
        evidenceExcerpt: blockingDiscussionChange.current
          ? 'Review discussion resolved.'
          : 'Review discussion reopened.',
        occurredAt: input.payload.object_attributes.updated_at,
        refreshAggregationState: false,
      });
      eventIds.push(result.event.id);
    }

    if (subjects.length > 0) {
      await refreshAggregationStateForScope({
        owner,
        platform: 'gitlab',
        repoFullName: input.payload.project.path_with_namespace,
        platformProjectId: input.payload.project.id,
      });
    }
  }

  return eventIds.length > 0 ? { recorded: true, eventIds } : skipped('no-feedback-signal');
}
