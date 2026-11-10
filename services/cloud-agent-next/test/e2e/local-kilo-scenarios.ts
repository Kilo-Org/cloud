import assert from 'node:assert/strict';
import type { Harness } from './local-kilo-harness.js';
import type { FeedStream } from './local-kilo-stack.js';

/**
 * Which sandbox family a scenario needs. The local Docker sandbox cannot clone
 * for a second workspace while another sandbox is alive, so the runner tears the
 * current sandbox down before switching families.
 */
export type SandboxKind = 'workspace' | 'hosted' | 'none';

export type Scenario = {
  name: string;
  optIn?: boolean;
  sandbox?: SandboxKind;
  run: (h: Harness) => Promise<void>;
};

const SANDBOX_RANK: Record<SandboxKind, number> = { workspace: 0, hosted: 1, none: 2 };

export function orderBySandbox(scenarios: Scenario[]): Scenario[] {
  return scenarios
    .map((scenario, index) => ({ scenario, index }))
    .sort((left, right) => {
      const rank =
        SANDBOX_RANK[left.scenario.sandbox ?? 'none'] -
        SANDBOX_RANK[right.scenario.sandbox ?? 'none'];
      return rank !== 0 ? rank : left.index - right.index;
    })
    .map(entry => entry.scenario);
}

export function validateSystem(feed: FeedStream, sessionID: string): void {
  for (const event of feed.events) {
    assert(
      ['preparing', 'cloud.status', 'cloud.sandbox.status'].includes(event.type),
      `unexpected system event ${event.type}`
    );
    assert.equal(event.properties.sessionID, sessionID);
    assert.equal(event.properties.directory, `/cloud-agent/sessions/${sessionID}`);
    assert.equal('cloudAgentSessionId' in event.properties, false);
  }
}
