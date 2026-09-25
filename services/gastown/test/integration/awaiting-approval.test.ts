import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getTownStub(name = 'test-town') {
  const id = env.TOWN.idFromName(name);
  return env.TOWN.get(id);
}

describe('Awaiting approval — convoy landing MR respawn suppression', () => {
  let town: ReturnType<typeof getTownStub>;
  let townName: string;

  beforeEach(async () => {
    townName = `awaiting-approval-${crypto.randomUUID()}`;
    town = getTownStub(townName);
    await town.setTownId(townName);
    await town.addRig({
      rigId: 'rig-1',
      name: 'main-rig',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  async function setupConvoyWithLandingMr() {
    const result = await town.slingConvoy({
      rigId: 'rig-1',
      convoyTitle: 'Landing MR Test',
      tasks: [{ title: 'Task 1' }],
      merge_mode: 'review-then-land',
    });

    const beadId = result.beads[0].bead.bead_id;

    await runDurableObjectAlarm(town);

    const bead = await town.getBeadAsync(beadId);
    const agentId = bead!.assignee_agent_bead_id!;
    expect(agentId).toBeTruthy();

    await town.agentDone(agentId, {
      branch: 'gt/polecat/test-branch',
      summary: 'Completed task',
    });

    await runDurableObjectAlarm(town);

    const sourceBead = await town.getBeadAsync(beadId);
    expect(sourceBead?.status).toBe('in_review');

    const allMrs = await town.listBeads({ type: 'merge_request' });
    const mrBead = allMrs.find(b => b.metadata?.source_bead_id === beadId);
    expect(mrBead).toBeTruthy();

    return {
      convoyId: result.convoy.id,
      beadId,
      mrBeadId: mrBead!.bead_id,
      featureBranch: result.convoy.feature_branch!,
    };
  }

  it('should not fail an MR bead via Rule 4 timeout when awaiting_approval is set', async () => {
    const { mrBeadId } = await setupConvoyWithLandingMr();

    const mrBead = await town.getBeadAsync(mrBeadId);
    await town.updateBead(
      mrBeadId,
      {
        metadata: {
          ...(mrBead?.metadata ?? {}),
          awaiting_approval: 1,
          review_decision: 'REVIEW_REQUIRED',
          merge_state_status: 'BLOCKED',
          last_poll_at: new Date(Date.now() - 45 * 60_000).toISOString(),
        },
      },
      'system'
    );

    await town.updateBeadStatus(mrBeadId, 'in_progress', 'system');

    await runDurableObjectAlarm(town);

    const after = await town.getBeadAsync(mrBeadId);
    expect(after?.status).toBe('in_progress');
    expect(after?.metadata?.awaiting_approval).toBe(1);
  });

  it('should not re-dispatch refinery (Rule 6) when awaiting_approval is set', async () => {
    const { mrBeadId } = await setupConvoyWithLandingMr();

    const mrBead = await town.getBeadAsync(mrBeadId);
    await town.updateBead(
      mrBeadId,
      {
        metadata: {
          ...(mrBead?.metadata ?? {}),
          awaiting_approval: 1,
          review_decision: 'REVIEW_REQUIRED',
          merge_state_status: 'BLOCKED',
        },
      },
      'system'
    );
    await town.updateBeadStatus(mrBeadId, 'in_progress', 'system');

    const refineries = await town.listAgents({ role: 'refinery' });
    if (refineries.length > 0) {
      await town.updateAgentStatus(refineries[0].id, 'idle');
    }

    await runDurableObjectAlarm(town);

    const after = await town.getBeadAsync(mrBeadId);
    expect(after?.status).toBe('in_progress');
    expect(after?.metadata?.awaiting_approval).toBe(1);
  });

  it('should suppress convoy landing MR respawn when failed MR has awaiting_approval', async () => {
    const { convoyId, beadId, mrBeadId, featureBranch } = await setupConvoyWithLandingMr();

    await town.updateBeadStatus(beadId, 'closed', 'system');
    await runDurableObjectAlarm(town);

    const mrBead = await town.getBeadAsync(mrBeadId);
    await town.updateBead(
      mrBeadId,
      {
        metadata: {
          ...(mrBead?.metadata ?? {}),
          awaiting_approval: 1,
          review_decision: 'REVIEW_REQUIRED',
          merge_state_status: 'BLOCKED',
        },
      },
      'system'
    );
    await town.updateBeadStatus(mrBeadId, 'failed', 'system');

    await runDurableObjectAlarm(town);

    const allMrs = await town.listBeads({ type: 'merge_request' });
    const failedWithApproval = allMrs.filter(
      b => b.status === 'failed' && b.metadata?.awaiting_approval === 1
    );
    expect(failedWithApproval.length).toBeGreaterThan(0);

    const convoyStatus = await town.getConvoyStatus(convoyId);
    expect(convoyStatus?.status).not.toBe('failed');
  });

  it('should allow MR to proceed when awaiting_approval is cleared', async () => {
    const { mrBeadId } = await setupConvoyWithLandingMr();

    const mrBead = await town.getBeadAsync(mrBeadId);
    await town.updateBead(
      mrBeadId,
      {
        metadata: {
          ...(mrBead?.metadata ?? {}),
          awaiting_approval: 1,
          review_decision: 'REVIEW_REQUIRED',
        },
      },
      'system'
    );
    await town.updateBeadStatus(mrBeadId, 'in_progress', 'system');

    await runDurableObjectAlarm(town);

    const during = await town.getBeadAsync(mrBeadId);
    expect(during?.status).toBe('in_progress');

    const withApproval = await town.getBeadAsync(mrBeadId);
    await town.updateBead(
      mrBeadId,
      {
        metadata: {
          ...(withApproval?.metadata ?? {}),
          awaiting_approval: 0,
          review_decision: 'APPROVED',
          merge_state_status: 'CLEAN',
        },
      },
      'system'
    );

    await runDurableObjectAlarm(town);

    const after = await town.getBeadAsync(mrBeadId);
    expect(after?.metadata?.awaiting_approval).toBe(0);
    expect(after?.status).toBe('in_progress');
  });
});

describe('PR feedback vs awaiting approval — CHANGES_REQUESTED creates feedback bead, REVIEW_REQUIRED does not', () => {
  let town: ReturnType<typeof getTownStub>;
  let townName: string;

  beforeEach(async () => {
    townName = `feedback-vs-approval-${crypto.randomUUID()}`;
    town = getTownStub(townName);
    await town.setTownId(townName);
    await town.addRig({
      rigId: 'rig-1',
      name: 'main-rig',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  it('should not create a feedback bead for REVIEW_REQUIRED (awaiting approval)', async () => {
    const result = await town.slingConvoy({
      rigId: 'rig-1',
      convoyTitle: 'Review Required Test',
      tasks: [{ title: 'Task 1' }],
    });

    const beadId = result.beads[0].bead.bead_id;
    await runDurableObjectAlarm(town);

    const bead = await town.getBeadAsync(beadId);
    const agentId = bead!.assignee_agent_bead_id!;

    await town.agentDone(agentId, {
      branch: 'gt/polecat/test-branch',
      summary: 'Completed task',
    });
    await runDurableObjectAlarm(town);

    const allMrs = await town.listBeads({ type: 'merge_request' });
    const mrBead = allMrs.find(b => b.metadata?.source_bead_id === beadId);
    expect(mrBead).toBeTruthy();

    const mrWithApproval = await town.getBeadAsync(mrBead!.bead_id);
    await town.updateBead(
      mrBead!.bead_id,
      {
        metadata: {
          ...(mrWithApproval?.metadata ?? {}),
          awaiting_approval: 1,
          review_decision: 'REVIEW_REQUIRED',
          merge_state_status: 'BLOCKED',
        },
      },
      'system'
    );

    const feedbackBeadsBefore = await town.listBeads({});
    const prFeedbackBeadsBefore = feedbackBeadsBefore.filter(b =>
      b.labels?.includes('gt:pr-feedback')
    );

    await runDurableObjectAlarm(town);

    const feedbackBeadsAfter = await town.listBeads({});
    const prFeedbackBeadsAfter = feedbackBeadsAfter.filter(b =>
      b.labels?.includes('gt:pr-feedback')
    );

    expect(prFeedbackBeadsAfter.length).toBe(prFeedbackBeadsBefore.length);
  });

  it('should create a feedback bead for CHANGES_REQUESTED even when also awaiting approval', async () => {
    const result = await town.slingConvoy({
      rigId: 'rig-1',
      convoyTitle: 'Changes Requested Test',
      tasks: [{ title: 'Task 1' }],
    });

    const beadId = result.beads[0].bead.bead_id;
    await runDurableObjectAlarm(town);

    const bead = await town.getBeadAsync(beadId);
    const agentId = bead!.assignee_agent_bead_id!;

    await town.agentDone(agentId, {
      branch: 'gt/polecat/test-branch',
      summary: 'Completed task',
    });
    await runDurableObjectAlarm(town);

    const allMrs = await town.listBeads({ type: 'merge_request' });
    const mrBead = allMrs.find(b => b.metadata?.source_bead_id === beadId);
    expect(mrBead).toBeTruthy();

    const mrWithChanges = await town.getBeadAsync(mrBead!.bead_id);
    await town.updateBead(
      mrBead!.bead_id,
      {
        metadata: {
          ...(mrWithChanges?.metadata ?? {}),
          awaiting_approval: 1,
          review_decision: 'CHANGES_REQUESTED',
          merge_state_status: 'BLOCKED',
        },
      },
      'system'
    );

    await town.debugInsertTownEvent({
      event_type: 'pr_feedback_detected',
      bead_id: mrBead!.bead_id,
      payload: {
        mr_bead_id: mrBead!.bead_id,
        pr_url: 'https://github.com/test/repo/pull/1',
        pr_number: 1,
        repo: 'test/repo',
        branch: 'gt/polecat/test-branch',
        has_unresolved_comments: true,
        has_failing_checks: false,
        has_unchecked_runs: false,
      },
    });

    await runDurableObjectAlarm(town);

    const feedbackBeads = await town.listBeads({});
    const prFeedbackBeads = feedbackBeads.filter(b => b.labels?.includes('gt:pr-feedback'));
    expect(prFeedbackBeads.length).toBeGreaterThan(0);
  });
});
