import {
  canRestoreSubmittedDraft,
  canRestoreFailedPrompt,
  ownsSubmittedDraft,
  type SubmittedDraft,
} from './composer-bridge';
const submission: SubmittedDraft = {
  conversationKey: 'chat-a',
  revision: 3,
  text: 'Original draft',
  attachmentIds: ['file-a'],
};
it('settles only the submitted revision in the originating conversation', () => {
  expect(ownsSubmittedDraft(submission, 'chat-a', 3)).toBe(true);
  expect(ownsSubmittedDraft(submission, 'chat-b', 3)).toBe(false);
  expect(ownsSubmittedDraft(submission, 'chat-a', 4)).toBe(false);
});
it('recovers rejection after switching conversations without replacing a newer draft', () => {
  const drafts = new Map([
    ['chat-a', { revision: 3, text: '' }],
    ['chat-b', { revision: 1, text: 'Other conversation' }],
  ]);
  const original = drafts.get('chat-a');
  if (original && canRestoreSubmittedDraft(submission, original.revision, original.text))
    original.text = submission.text;
  expect(drafts.get('chat-a')?.text).toBe('Original draft');
  expect(drafts.get('chat-b')?.text).toBe('Other conversation');
  expect(canRestoreSubmittedDraft(submission, 4, 'New typing')).toBe(false);
  expect(canRestoreSubmittedDraft(submission, 4, '')).toBe(false);
});

it('requires a matching submission to restore a failed prompt after mount', () => {
  expect(canRestoreFailedPrompt(undefined, 'chat-b', 0, '', 'A failed prompt')).toBe(false);
  expect(canRestoreFailedPrompt(undefined, 'new', 0, '', 'A failed prompt')).toBe(false);
  expect(canRestoreFailedPrompt(submission, 'chat-b', 3, '', submission.text)).toBe(false);
  expect(canRestoreFailedPrompt(submission, 'chat-a', 3, '', 'Other prompt')).toBe(false);
  expect(canRestoreFailedPrompt(submission, 'chat-a', 3, '', submission.text)).toBe(true);
});
