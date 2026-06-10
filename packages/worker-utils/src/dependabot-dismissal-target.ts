export type DependabotDismissalTarget = {
  alertNumber: number;
  repoOwner: string;
  repoName: string;
};

export function parseDependabotDismissalTarget(params: {
  sourceId: string;
  repoFullName: string;
}): DependabotDismissalTarget | null {
  const alertNumber = /^\d+$/.test(params.sourceId)
    ? Number.parseInt(params.sourceId, 10)
    : Number.NaN;
  const repoParts = params.repoFullName.split('/');
  const [repoOwner, repoName] = repoParts;

  if (!Number.isSafeInteger(alertNumber) || repoParts.length !== 2 || !repoOwner || !repoName) {
    return null;
  }

  return { alertNumber, repoOwner, repoName };
}
