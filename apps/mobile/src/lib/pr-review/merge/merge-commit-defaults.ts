// Pure defaults for the merge sheet's commit title/message fields. Kept
// out of the component so they stay unit-testable and the sheet stays
// under the max-lines limit.
import { type PrMergeMethod } from '@/lib/pr-review/merge/merge-blocked-reasons';

export function defaultCommitTitle(title: string, number: number): string {
  return `${title} (#${number})`;
}

export function defaultCommitMessage(method: PrMergeMethod, body: string | null): string {
  if (method === 'squash') {
    return body && body.trim().length > 0 ? body : '';
  }
  if (body && body.trim().length > 0) {
    return body;
  }
  return '';
}
