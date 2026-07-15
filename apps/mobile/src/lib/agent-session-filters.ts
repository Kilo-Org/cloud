export type AgentSessionFilters = {
  activeNow: boolean;
  platformFilter: string[];
  projectFilter: string[];
};

export function createDefaultAgentSessionFilters(): AgentSessionFilters {
  return { activeNow: true, platformFilter: [], projectFilter: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

export function parseStoredAgentSessionFilters(raw: string | null): AgentSessionFilters | null {
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;

    return {
      activeNow: typeof parsed.activeNow === 'boolean' ? parsed.activeNow : true,
      platformFilter: readStringArray(parsed.platformFilter),
      projectFilter: readStringArray(parsed.projectFilter),
    };
  } catch {
    return null;
  }
}
