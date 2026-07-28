// Pure defaults for the merge sheet's commit title/message fields. Kept
// out of the component so they stay unit-testable and the sheet stays
// under the max-lines limit.

export function defaultCommitTitle(title: string, number: number): string {
  return `${title} (#${number})`;
}

export function defaultCommitMessage(body: string | null): string {
  if (body && body.trim().length > 0) {
    return body;
  }
  return '';
}
