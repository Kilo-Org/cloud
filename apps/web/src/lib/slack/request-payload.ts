function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Expected ${description}`);
  return value;
}

function requireString(value: unknown, description: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`Expected ${description}`);
}

export function getSlackTeamIdFromEventsApiBody(body: unknown): string {
  const parsedBody = requireRecord(body, 'Slack Events API body');
  return requireString(parsedBody.team_id, 'Slack Events API body.team_id');
}

export function getSlackTeamIdFromInteractivityRawBody(rawBody: string): string {
  const payload = new URLSearchParams(rawBody).get('payload');
  if (!payload) throw new Error('Expected Slack interactivity payload');

  const parsed: unknown = JSON.parse(payload);
  const parsedPayload = requireRecord(parsed, 'Slack interactivity payload');

  if (typeof parsedPayload.team_id === 'string' && parsedPayload.team_id.length > 0) {
    return parsedPayload.team_id;
  }

  if (isRecord(parsedPayload.team)) {
    return requireString(parsedPayload.team.id, 'Slack interactivity payload.team.id');
  }

  throw new Error('Expected Slack interactivity payload.team.id or payload.team_id');
}
