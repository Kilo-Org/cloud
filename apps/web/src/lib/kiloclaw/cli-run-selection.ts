type CliRunLike = {
  id: string;
  instance_id: string | null;
  status: string | null;
};

export function selectCurrentCliRun<TRun extends CliRunLike>(
  runs: TRun[] | undefined,
  instanceId: string | null | undefined,
  preferredRunId?: string | null
): TRun | null {
  if (!runs || !instanceId) {
    return null;
  }

  return (
    (preferredRunId
      ? runs.find(run => run.id === preferredRunId && run.instance_id === instanceId)
      : undefined) ??
    runs.find(run => run.instance_id === instanceId && run.status === 'running') ??
    runs.find(run => run.instance_id === instanceId) ??
    null
  );
}
