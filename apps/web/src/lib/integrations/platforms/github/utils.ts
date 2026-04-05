export function extractBranchNameFromRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}
