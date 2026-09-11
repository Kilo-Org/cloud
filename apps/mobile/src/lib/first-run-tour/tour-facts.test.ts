import { describe, expect, it } from 'vitest';

import { classifyTourFacts, type TourFactsInput } from './tour-facts';

function input(overrides: Partial<TourFactsInput> = {}): TourFactsInput {
  return {
    historyRows: [],
    liveSessions: [],
    instances: [],
    ...overrides,
  };
}

describe('classifyTourFacts', () => {
  it('reports nothing for all-empty inputs', () => {
    expect(classifyTourFacts(input())).toEqual({
      hasCloudSession: false,
      connectedInstance: null,
      hasCliSession: false,
    });
  });

  it('flags a cloud session when any history row carries a cloud agent session id', () => {
    const facts = classifyTourFacts(
      input({
        historyRows: [{ cloud_agent_session_id: null }, { cloud_agent_session_id: 'cas-1' }],
      })
    );
    expect(facts.hasCloudSession).toBe(true);
    expect(facts.connectedInstance).toBeNull();
    expect(facts.hasCliSession).toBe(false);
  });

  it('does not flag a cloud session when every history row has a null id', () => {
    const facts = classifyTourFacts(input({ historyRows: [{ cloud_agent_session_id: null }] }));
    expect(facts.hasCloudSession).toBe(false);
  });

  it('reports the connected instance without a live session', () => {
    const facts = classifyTourFacts(
      input({ instances: [{ connectionId: 'c-1', name: 'workstation' }] })
    );
    expect(facts.connectedInstance).toEqual({ connectionId: 'c-1', name: 'workstation' });
    expect(facts.hasCliSession).toBe(false);
  });

  it('flags a live session whose connection id matches an instance', () => {
    const facts = classifyTourFacts(
      input({
        instances: [{ connectionId: 'c-1', name: 'workstation' }],
        liveSessions: [{ connectionId: 'c-1' }],
      })
    );
    expect(facts.hasCliSession).toBe(true);
  });

  it('ignores a live session with an unknown or stale connection id', () => {
    const facts = classifyTourFacts(
      input({
        instances: [{ connectionId: 'c-1', name: 'workstation' }],
        liveSessions: [{ connectionId: 'c-gone' }],
      })
    );
    expect(facts.hasCliSession).toBe(false);
  });

  it('never counts a cloud-agent live session, even if an instance carries the id', () => {
    const facts = classifyTourFacts(
      input({
        instances: [{ connectionId: 'cloud-agent', name: 'Cloud Agent' }],
        liveSessions: [{ connectionId: 'cloud-agent' }],
      })
    );
    expect(facts.hasCliSession).toBe(false);
  });

  it('takes the first instance when several are connected', () => {
    const facts = classifyTourFacts(
      input({
        instances: [
          { connectionId: 'c-1', name: 'first' },
          { connectionId: 'c-2', name: 'second' },
        ],
        liveSessions: [{ connectionId: 'c-2' }],
      })
    );
    expect(facts.connectedInstance).toEqual({ connectionId: 'c-1', name: 'first' });
    expect(facts.hasCliSession).toBe(true);
  });
});
