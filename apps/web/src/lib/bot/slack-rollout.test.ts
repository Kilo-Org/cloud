import {
  getSlackTeamIdFromEventsApiBody,
  getSlackTeamIdFromInteractivityRawBody,
  parseSlackBotNewInfraIntegrationIds,
} from './slack-rollout';

describe('Slack bot rollout routing helpers', () => {
  it('parses comma-separated integration IDs with trimming and de-duping', () => {
    expect(parseSlackBotNewInfraIntegrationIds(' id-1, id-2 ,, id-1 ')).toEqual(['id-1', 'id-2']);
  });

  it('extracts team IDs from Events API envelopes', () => {
    expect(getSlackTeamIdFromEventsApiBody({ team_id: 'T123' })).toBe('T123');
    expect(getSlackTeamIdFromEventsApiBody({ event: { team: 'T456' } })).toBe('T456');
    expect(getSlackTeamIdFromEventsApiBody({ event: {} })).toBeNull();
  });

  it('extracts team IDs from interactivity payloads', () => {
    const rawBody = new URLSearchParams({
      payload: JSON.stringify({ team: { id: 'T789' } }),
    }).toString();

    expect(getSlackTeamIdFromInteractivityRawBody(rawBody)).toBe('T789');
    expect(getSlackTeamIdFromInteractivityRawBody('payload=not-json')).toBeNull();
  });
});
