export type ReviewCommentReplyClassification = {
  signalKind: 'corrective_reply' | 'supportive_reply';
  sentiment: 'positive' | 'negative' | 'neutral';
  strength: number;
};

const CORRECTIVE_REPLY_PATTERNS = [
  'false positive',
  'not an issue',
  'incorrect',
  'wrong',
  'this is expected',
  'expected behavior',
  'does not apply',
  'please remove',
  'unhelpful',
];

const SUPPORTIVE_REPLY_PATTERNS = [
  'good catch',
  'nice catch',
  'thanks',
  'thank you',
  'fixed',
  'resolved',
  'agreed',
  'makes sense',
];

export function classifyReviewCommentReply(body: string): ReviewCommentReplyClassification {
  const normalized = body.toLowerCase();
  if (CORRECTIVE_REPLY_PATTERNS.some(pattern => normalized.includes(pattern))) {
    return { signalKind: 'corrective_reply', sentiment: 'negative', strength: 3 };
  }

  if (SUPPORTIVE_REPLY_PATTERNS.some(pattern => normalized.includes(pattern))) {
    return { signalKind: 'supportive_reply', sentiment: 'positive', strength: 2 };
  }

  return { signalKind: 'supportive_reply', sentiment: 'neutral', strength: 1 };
}
