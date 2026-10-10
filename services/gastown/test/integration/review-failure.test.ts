import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getTownStub(name = 'test-town') {
  const id = env.TOWN.idFromName(name);
  return env.TOWN.get(id);
}

describe('Review failure paths — convoy progress and source bead recovery', () => {
  let town: ReturnType<typeof getTownStub>;
  let townName: string;

  beforeEach(async () => {
    townName = `review-failure-${crypto.randomUUID()}`;
    town = getTownStub(townName);
    await town.setTownId(townName);
  });

  async function setupConvoyWithMR() {
    await town.addRig({
      rigId: 'rig-1',
      name: 'main-rig',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });

    const result = await town.slingConvoy({
      rigId: 'rig-1',
      convoyTitle: 'Review Failure Test',
      tasks: [{ title: 'Task 1' }],
    });

    await runDurableObjectAlarm(town);

    const beadId = result.beads[0].bead.bead_id;
    const bead = await town.getBeadAsync(beadId);
    const agentId = bead!.assignee_agent_bead_id!;
    expect(agentId).toBeTruthy();

    // Simulate agent completing work — inserts agent_done event
    await town.agentDone(agentId, {
      branch: 'gt/polecat/test-branch',
      summary: 'Completed task',
    });

    // agentDone is event-only — run alarm to drain events and create MR bead
    await runDurableObjectAlarm(town);

    const sourceBead = await town.getBeadAsync(beadId);
    expect(sourceBead?.status).toBe('in_review');

    const allBeads = await town.listBeads({ type: 'merge_request' });
    const mrBead = allBeads.find(b => b.metadata?.source_bead_id === beadId);
    expect(mrBead).toBeTruthy();

    return { result, beadId, agentId, mrBeadId: mrBead!.bead_id, convoyId: result.convoy.id };
  }

  describe('completeReviewWithResult on MR failure', () => {
    it('should return source bead to in_progress when MR bead fails', async () => {
      const { beadId, mrBeadId } = await setupConvoyWithMR();

      // Fail the review via completeReviewWithResult (the fixed path)
      await town.completeReviewWithResult({
        entry_id: mrBeadId,
        status: 'failed',
        message: 'Refinery container failed to start',
      });

      const mrBead = await town.getBeadAsync(mrBeadId);
      expect(mrBead?.status).toBe('failed');

      // Source bead should be returned to open for rework (not stuck in in_review).
      // The reconciler will assign a new agent on the next alarm tick.
      const sourceBead = await town.getBeadAsync(beadId);
      expect(sourceBead?.status).toBe('open');
    });

    it('should update convoy progress when MR bead is merged', async () => {
      const { beadId, mrBeadId, convoyId } = await setupConvoyWithMR();

      // Complete the review successfully
      await town.completeReviewWithResult({
        entry_id: mrBeadId,
        status: 'merged',
        message: 'Merged by refinery',
      });

      const sourceBead = await town.getBeadAsync(beadId);
      expect(sourceBead?.status).toBe('closed');

      const mrBead = await town.getBeadAsync(mrBeadId);
      expect(mrBead?.status).toBe('closed');

      const convoyStatus = await town.getConvoyStatus(convoyId);
      expect(convoyStatus?.closed_beads).toBe(1);
    });
  });

  describe('convoy progress with mixed outcomes', () => {
    it('should not stall convoy when one MR fails and another merges', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Two-Task Convoy',
        tasks: [{ title: 'Task 1' }, { title: 'Task 2' }],
      });

      await runDurableObjectAlarm(town);

      const bead0Id = result.beads[0].bead.bead_id;
      const bead0 = await town.getBeadAsync(bead0Id);
      const agent0Id = bead0!.assignee_agent_bead_id!;
      const bead1Id = result.beads[1].bead.bead_id;
      const bead1 = await town.getBeadAsync(bead1Id);
      const agent1Id = bead1!.assignee_agent_bead_id!;

      await town.agentDone(agent0Id, {
        branch: 'gt/polecat/task-1',
        summary: 'Task 1 done',
      });
      await town.agentDone(agent1Id, {
        branch: 'gt/polecat/task-2',
        summary: 'Task 2 done',
      });

      await runDurableObjectAlarm(town);

      const mrBeads = await town.listBeads({ type: 'merge_request' });
      const mr0 = mrBeads.find(b => b.metadata?.source_bead_id === bead0Id);
      const mr1 = mrBeads.find(b => b.metadata?.source_bead_id === bead1Id);
      expect(mr0).toBeTruthy();
      expect(mr1).toBeTruthy();

      // Fail MR for task 1 via completeReviewWithResult
      await town.completeReviewWithResult({
        entry_id: mr0!.bead_id,
        status: 'failed',
        message: 'Review failed',
      });

      const source0 = await town.getBeadAsync(bead0Id);
      expect(source0?.status).toBe('open');

      await town.completeReviewWithResult({
        entry_id: mr1!.bead_id,
        status: 'merged',
        message: 'Merged',
      });

      const source1 = await town.getBeadAsync(bead1Id);
      expect(source1?.status).toBe('closed');

      // Convoy should show 1 closed bead (task 2 merged; task 1 is in_progress
      // awaiting rework, its MR is failed but the source isn't terminal yet)
      const convoyStatus = await town.getConvoyStatus(result.convoy.id);
      expect(convoyStatus?.closed_beads).toBe(1);
    });
  });

  describe('agentDone transitions source bead to in_review', () => {
    it('should set source bead to in_review after polecat calls agentDone', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Agent Done Test',
        tasks: [{ title: 'Single Task' }],
      });

      await runDurableObjectAlarm(town);

      const beadId = result.beads[0].bead.bead_id;
      const assignedBead = await town.getBeadAsync(beadId);
      const agentId = assignedBead!.assignee_agent_bead_id!;

      await town.agentDone(agentId, {
        branch: 'gt/polecat/test',
        summary: 'Done',
      });

      // agentDone is event-only — run alarm to drain events
      await runDurableObjectAlarm(town);

      const updatedBead = await town.getBeadAsync(beadId);
      expect(updatedBead?.status).toBe('in_review');

      const mrBeads = await town.listBeads({ type: 'merge_request' });
      expect(mrBeads.length).toBeGreaterThan(0);
      expect(mrBeads.some(b => b.metadata?.source_bead_id === beadId)).toBe(true);
    });
  });
});
