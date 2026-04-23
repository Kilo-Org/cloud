import {
  getSlackTeamIdFromEventsApiBody,
  getSlackTeamIdFromInteractivityRawBody,
} from './request-payload';

describe('Slack request payload helpers', () => {
  it('extracts team IDs from Events API envelopes', () => {
    expect(getSlackTeamIdFromEventsApiBody({ team_id: 'T123' })).toBe('T123');
    expect(() => getSlackTeamIdFromEventsApiBody({ event: { team: 'T456' } })).toThrow(
      'Expected Slack Events API body.team_id'
    );
    expect(() => getSlackTeamIdFromEventsApiBody({ event: {} })).toThrow(
      'Expected Slack Events API body.team_id'
    );
  });

  it('extracts team IDs from interactivity payload team objects', () => {
    const rawBody = new URLSearchParams({
      payload: JSON.stringify({ team: { id: 'T789' } }),
    }).toString();

    expect(getSlackTeamIdFromInteractivityRawBody(rawBody)).toBe('T789');
  });

  it('extracts team IDs from interactivity payload team_id fields', () => {
    const rawBody = new URLSearchParams({
      payload: JSON.stringify({ team_id: 'T999' }),
    }).toString();

    expect(getSlackTeamIdFromInteractivityRawBody(rawBody)).toBe('T999');
  });

  it('throws when interactivity payloads are invalid', () => {
    expect(() => getSlackTeamIdFromInteractivityRawBody('payload=not-json')).toThrow();
    expect(() =>
      getSlackTeamIdFromInteractivityRawBody(
        new URLSearchParams({ payload: JSON.stringify({ team: {} }) }).toString()
      )
    ).toThrow('Expected Slack interactivity payload.team.id');
    expect(() =>
      getSlackTeamIdFromInteractivityRawBody(
        new URLSearchParams({ payload: JSON.stringify({}) }).toString()
      )
    ).toThrow('Expected Slack interactivity payload.team.id or payload.team_id');
  });
});
