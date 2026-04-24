export type MorningBriefingCronJob = {
  id: string;
  enabled: boolean;
  updatedAtMs: number;
  createdAtMs: number;
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function selectMorningBriefingJobs(
  payload: unknown,
  jobName: string,
  toolName: string
): MorningBriefingCronJob[] {
  const root = asObject(payload);
  const jobs = Array.isArray(root.jobs) ? root.jobs : [];
  return jobs
    .map(raw => asObject(raw))
    .filter(job => {
      if (typeof job.name !== 'string' || job.name !== jobName) {
        return false;
      }
      const payloadObj = asObject(job.payload);
      const toolsAllow = toStringArray(payloadObj.toolsAllow);
      return toolsAllow.includes(toolName);
    })
    .map(job => ({
      id: typeof job.id === 'string' ? job.id : '',
      enabled: job.enabled === true,
      updatedAtMs: typeof job.updatedAtMs === 'number' ? job.updatedAtMs : 0,
      createdAtMs: typeof job.createdAtMs === 'number' ? job.createdAtMs : 0,
    }))
    .filter(job => job.id.length > 0);
}

export function pickCanonicalCronJobId(
  jobs: MorningBriefingCronJob[],
  preferredId: string | null
): string | null {
  if (preferredId && jobs.some(job => job.id === preferredId)) {
    return preferredId;
  }

  const sorted = [...jobs].sort((a, b) => {
    if (b.updatedAtMs !== a.updatedAtMs) {
      return b.updatedAtMs - a.updatedAtMs;
    }
    if (b.createdAtMs !== a.createdAtMs) {
      return b.createdAtMs - a.createdAtMs;
    }
    return a.id.localeCompare(b.id);
  });

  return sorted[0]?.id ?? null;
}

export function filterEnabledBriefingJobs(
  jobs: MorningBriefingCronJob[]
): MorningBriefingCronJob[] {
  return jobs.filter(job => job.enabled);
}
