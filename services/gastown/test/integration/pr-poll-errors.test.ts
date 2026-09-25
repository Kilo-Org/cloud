/**
 * Integration tests for PR poll error discrimination (#3149).
 *
 * Tests verify that the poll_pr action handler correctly handles the
 * discriminated PRStatusOutcome: immediate-fail for no_token / non-transient
 * HTTP errors, 3-strike threshold for invalid_response / unrecognized_url /
 * host_mismatch, and 10-strike threshold for transient HTTP errors (5xx, 429).
 *
 * The no-token test runs fully end-to-end through the DO alarm. HTTP error
 * scenarios are covered by unit tests (test/unit/pr-poll-*.test.ts) since
 * mocking fetch is not practical in the Cloudflare Workers test runtime.
 */

import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getTownStub(name = 'test-town') {
  const id = env.TOWN.idFromName(name);
  return env.TOWN.get(id);
}

describe('PR poll error discrimination (#3149)', () => {
  let town: ReturnType<typeof getTownStub>;
  let townName: string;

  beforeEach(async () => {
    townName = `pr-poll-${crypto.randomUUID()}`;
    town = getTownStub(townName);
    await town.setTownId(townName);
  });

  async function setupMrBeadWithPrUrl(prUrl: string) {
    await town.addRig({
      rigId: 'rig-1',
      name: 'main-rig',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });

    const result = await town.slingConvoy({
      rigId: 'rig-1',
      convoyTitle: 'PR Poll Test',
      tasks: [{ title: 'Task 1' }],
    });

    await runDurableObjectAlarm(town);

    const beadId = result.beads[0].bead.bead_id;
    const bead = await town.getBeadAsync(beadId);
    const agentId = bead!.assignee_agent_bead_id!;
    expect(agentId).toBeTruthy();

    await town.agentDone(agentId, {
      branch: 'gt/polecat/test-branch',
      summary: 'Completed task',
    });

    await runDurableObjectAlarm(town);

    const allMrs = await town.listBeads({ type: 'merge_request' });
    const mrBead = allMrs.find(b => b.metadata?.source_bead_id === beadId);
    expect(mrBead).toBeTruthy();

    // Set the PR URL and put the MR bead back to in_progress so the
    // reconciler will schedule a poll_pr action on the next alarm tick.
    await town.updateBead(
      mrBead!.bead_id,
      {
        metadata: {
          ...(mrBead!.metadata ?? {}),
          pr_url: prUrl,
        },
      },
      'system'
    );
    await town.updateBeadStatus(mrBead!.bead_id, 'in_progress', 'system');

    return { beadId, mrBeadId: mrBead!.bead_id, agentId, convoyId: result.convoy.id };
  }

  describe('no_token: town with no GitHub token', () => {
    it('should fail the MR bead immediately (1 strike) with failureKind "no_token"', async () => {
      // Town is set up with no git_auth, so resolveGitHubToken will return
      // { ok: false, tried: [...] } and checkPRStatus will return a no_token error.
      const { mrBeadId } = await setupMrBeadWithPrUrl('https://github.com/test/repo/pull/1');

      // Run alarm — the reconciler should generate a poll_pr action, which
      // calls checkPRStatus and gets a no_token error. Since no_token is an
      // immediate-fail error, the bead should fail on the first poll.
      await runDurableObjectAlarm(town);

      const mrBead = await town.getBeadAsync(mrBeadId);
      expect(mrBead?.status).toBe('failed');
      expect(mrBead?.metadata?.failureReason).toBe('pr_poll_failed');
      expect(mrBead?.metadata?.failureKind).toBe('no_token');
      expect(mrBead?.metadata?.failureMessage).toContain('No GitHub token resolved');
      expect(mrBead?.metadata?.failureMessage).toContain('town.git_auth.github_token');
      expect(mrBead?.metadata?.failureMessage).toContain('town.github_cli_pat');
    });
  });
});
