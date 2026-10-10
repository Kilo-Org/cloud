import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getTownStub(name = 'test-town') {
  const id = env.TOWN.idFromName(name);
  return env.TOWN.get(id);
}

describe('Convoy DAG and Feature Branches', () => {
  let town: ReturnType<typeof getTownStub>;
  let townName: string;

  beforeEach(async () => {
    townName = `convoy-dag-${crypto.randomUUID()}`;
    town = getTownStub(townName);
    // Set town ID so the alarm loop doesn't bail out
    await town.setTownId(townName);
  });

  describe('feature branch creation', () => {
    it('should create a convoy with a feature branch', async () => {
      // Need a rig for slingConvoy
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Add User Auth',
        tasks: [{ title: 'Create user model' }, { title: 'Add login endpoint' }],
      });

      expect(result.convoy.feature_branch).toBeTruthy();
      expect(result.convoy.feature_branch).toMatch(/^convoy\/add-user-auth\/[0-9a-f]+\/head$/);
      expect(result.convoy.status).toBe('active');
      expect(result.convoy.total_beads).toBe(2);
      expect(result.beads).toHaveLength(2);
    });

    it('should slug the convoy title for the branch name', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Fix: Bug #123 with special characters!!!',
        tasks: [{ title: 'Task 1' }],
      });

      expect(result.convoy.feature_branch).toMatch(
        /^convoy\/fix-bug-123-with-special-characters\/[0-9a-f]+\/head$/
      );
    });

    it('should store convoy_id and feature_branch in bead metadata', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Test Convoy',
        tasks: [{ title: 'Task 1' }],
      });

      const bead = await town.getBeadAsync(result.beads[0].bead.bead_id);
      expect(bead).toBeTruthy();
      expect(bead?.metadata?.convoy_id).toBe(result.convoy.id);
      expect(bead?.metadata?.feature_branch).toBe(result.convoy.feature_branch);
    });
  });

  describe('DAG dependency edges', () => {
    it('should create blocks dependencies from depends_on indices', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Serial Convoy',
        tasks: [
          { title: 'Step 1' },
          { title: 'Step 2', depends_on: [0] },
          { title: 'Step 3', depends_on: [0, 1] },
        ],
      });

      const status = await town.getConvoyStatus(result.convoy.id);
      expect(status).toBeTruthy();
      expect(status!.dependency_edges).toBeDefined();
      expect(status!.dependency_edges.length).toBe(3);
      const beadIds = result.beads.map(b => b.bead.bead_id);

      expect(status!.dependency_edges).toContainEqual({
        bead_id: beadIds[1],
        depends_on_bead_id: beadIds[0],
      });

      expect(status!.dependency_edges).toContainEqual({
        bead_id: beadIds[2],
        depends_on_bead_id: beadIds[0],
      });

      expect(status!.dependency_edges).toContainEqual({
        bead_id: beadIds[2],
        depends_on_bead_id: beadIds[1],
      });
    });

    it('should return empty dependency_edges for convoys without deps', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Parallel Convoy',
        tasks: [{ title: 'Task A' }, { title: 'Task B' }, { title: 'Task C' }],
      });

      const status = await town.getConvoyStatus(result.convoy.id);
      expect(status!.dependency_edges).toEqual([]);
    });

    it('should include dependency_edges in listConvoysDetailed', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Detailed Convoy',
        tasks: [{ title: 'First' }, { title: 'Second', depends_on: [0] }],
      });

      const detailed = await town.listConvoysDetailed();
      expect(detailed).toHaveLength(1);
      expect(detailed[0].dependency_edges).toBeDefined();
      expect(detailed[0].dependency_edges.length).toBe(1);
      expect(detailed[0].feature_branch).toBeTruthy();
    });
  });

  describe('DAG-aware scheduling', () => {
    it('should not dispatch blocked beads', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Serial Tasks',
        tasks: [
          { title: 'First Step' },
          { title: 'Second Step', depends_on: [0] },
          { title: 'Third Step', depends_on: [1] },
        ],
      });

      await runDurableObjectAlarm(town);

      const bead0 = await town.getBeadAsync(result.beads[0].bead.bead_id);
      const bead1 = await town.getBeadAsync(result.beads[1].bead.bead_id);
      const bead2 = await town.getBeadAsync(result.beads[2].bead.bead_id);

      expect(bead0?.assignee_agent_bead_id).toBeTruthy();

      expect(bead1?.assignee_agent_bead_id).toBeNull();
      expect(bead2?.assignee_agent_bead_id).toBeNull();
    });

    it('should unblock next bead when blocker closes', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Two Steps',
        tasks: [{ title: 'Step 1' }, { title: 'Step 2', depends_on: [0] }],
      });

      await runDurableObjectAlarm(town);

      const beadIds = result.beads.map(b => b.bead.bead_id);
      const bead0 = await town.getBeadAsync(beadIds[0]);
      const agent0Id = bead0!.assignee_agent_bead_id!;
      expect(agent0Id).toBeTruthy();

      await town.updateBeadStatus(beadIds[0], 'closed', agent0Id);

      await runDurableObjectAlarm(town);

      const status = await town.getConvoyStatus(result.convoy.id);
      expect(status?.closed_beads).toBe(1);

      const bead1 = await town.getBeadAsync(beadIds[1]);
      expect(bead1?.status).not.toBe('closed');
      expect(bead1?.assignee_agent_bead_id).toBeTruthy();
    });

    it('should handle parallel beads that both block a final bead', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      // Diamond shape: A and B run in parallel, C depends on both
      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Diamond DAG',
        tasks: [{ title: 'Task A' }, { title: 'Task B' }, { title: 'Task C', depends_on: [0, 1] }],
      });

      await runDurableObjectAlarm(town);

      const beadIds = result.beads.map(b => b.bead.bead_id);
      const beadA = await town.getBeadAsync(beadIds[0]);
      const beadB = await town.getBeadAsync(beadIds[1]);

      await town.updateBeadStatus(beadIds[0], 'closed', beadA!.assignee_agent_bead_id!);

      const status1 = await town.getConvoyStatus(result.convoy.id);
      expect(status1?.closed_beads).toBe(1);

      await town.updateBeadStatus(beadIds[1], 'closed', beadB!.assignee_agent_bead_id!);

      const status2 = await town.getConvoyStatus(result.convoy.id);
      expect(status2?.closed_beads).toBe(2);
    });
  });

  describe('convoy progress', () => {
    it('should track closed_beads progress', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Progress Test',
        tasks: [{ title: 'Task 1' }, { title: 'Task 2' }, { title: 'Task 3' }],
      });

      let status = await town.getConvoyStatus(result.convoy.id);
      expect(status?.closed_beads).toBe(0);
      expect(status?.total_beads).toBe(3);

      await runDurableObjectAlarm(town);

      const beadIds = result.beads.map(b => b.bead.bead_id);
      await town.updateBeadStatus(beadIds[0], 'closed', 'system');

      status = await town.getConvoyStatus(result.convoy.id);
      expect(status?.closed_beads).toBe(1);

      await town.updateBeadStatus(beadIds[1], 'closed', 'system');

      status = await town.getConvoyStatus(result.convoy.id);
      expect(status?.closed_beads).toBe(2);
    });

    it('should set ready_to_land when all beads close (with feature branch)', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Landing Test',
        tasks: [{ title: 'Only task' }],
      });

      expect(result.convoy.feature_branch).toBeTruthy();

      const beadId = result.beads[0].bead.bead_id;

      await town.updateBeadStatus(beadId, 'closed', 'system');

      // Convoy should NOT auto-close (it has a feature branch that needs landing)
      const status = await town.getConvoyStatus(result.convoy.id);
      expect(status?.status).toBe('active'); // Still active, waiting for feature branch landing
      expect(status?.closed_beads).toBe(1);
    });

    it('should count failed beads toward convoy progress', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Failure Test',
        tasks: [{ title: 'Task 1' }, { title: 'Task 2' }],
      });

      const beadIds = result.beads.map(b => b.bead.bead_id);

      await town.updateBeadStatus(beadIds[0], 'failed', 'system');
      await town.updateBeadStatus(beadIds[1], 'closed', 'system');

      const status = await town.getConvoyStatus(result.convoy.id);
      // Both failed and closed count toward progress
      expect(status?.closed_beads).toBe(2);
    });
  });

  describe('force close convoy', () => {
    it('should close all tracked beads and the convoy', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Force Close Test',
        tasks: [{ title: 'Task 1' }, { title: 'Task 2', depends_on: [0] }],
      });

      const closed = await town.closeConvoy(result.convoy.id);
      expect(closed?.status).toBe('landed');

      for (const b of result.beads) {
        const bead = await town.getBeadAsync(b.bead.bead_id);
        expect(bead?.status).toBe('closed');
      }
    });
  });

  describe('edge cases', () => {
    it('should ignore self-referential depends_on', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Self Ref',
        tasks: [
          { title: 'Task 0', depends_on: [0] }, // self-reference
        ],
      });

      const status = await town.getConvoyStatus(result.convoy.id);
      expect(status!.dependency_edges).toEqual([]);
    });

    it('should ignore out-of-bounds depends_on indices', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'OOB Deps',
        tasks: [{ title: 'Task 0', depends_on: [5, -1, 100] }],
      });

      const status = await town.getConvoyStatus(result.convoy.id);
      expect(status!.dependency_edges).toEqual([]);
    });

    // Cycle detection is tested in unit tests (convoy-branches.test.ts)
    // since DO throws corrupt vitest-pool-workers isolated storage.
  });

  describe('merge mode', () => {
    it('should default to review-then-land when merge_mode is not specified', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Default Mode',
        tasks: [{ title: 'Task 1' }],
      });

      const status = await town.getConvoyStatus(result.convoy.id);
      expect(status?.merge_mode).toBe('review-then-land');
    });

    it('should accept review-then-land merge mode', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Review Then Land',
        tasks: [{ title: 'Task 1' }, { title: 'Task 2' }],
        merge_mode: 'review-then-land',
      });

      const status = await town.getConvoyStatus(result.convoy.id);
      expect(status?.merge_mode).toBe('review-then-land');
      expect(status?.feature_branch).toBeTruthy();
    });

    it('should accept review-and-merge merge mode', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Review And Merge',
        tasks: [{ title: 'Task 1' }, { title: 'Task 2' }],
        merge_mode: 'review-and-merge',
      });

      const status = await town.getConvoyStatus(result.convoy.id);
      expect(status?.merge_mode).toBe('review-and-merge');
      expect(status?.feature_branch).toBeTruthy();
    });

    it('should include merge_mode in listConvoysDetailed', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Mode Test',
        tasks: [{ title: 'Task 1' }],
        merge_mode: 'review-and-merge',
      });

      const detailed = await town.listConvoysDetailed();
      expect(detailed).toHaveLength(1);
      expect(detailed[0].merge_mode).toBe('review-and-merge');
    });

    it('should include merge_mode in review queue metadata for convoy beads', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Review Queue Mode Test',
        tasks: [{ title: 'Task 1' }],
        merge_mode: 'review-then-land',
      });

      await runDurableObjectAlarm(town);

      const beadId = result.beads[0].bead.bead_id;
      const bead0 = await town.getBeadAsync(beadId);
      const agentId = bead0!.assignee_agent_bead_id!;
      expect(agentId).toBeTruthy();

      await town.agentDone(agentId, {
        branch: 'gt/toast/test1234',
        summary: 'Done with task',
      });

      // agentDone is event-only — run alarm to drain events and apply
      await runDurableObjectAlarm(town);

      const bead = await town.getBeadAsync(beadId);
      expect(bead?.status).toBe('in_review');

      const allBeads = await town.listBeads({ type: 'merge_request' });
      const mrBead = allBeads.find(b => b.metadata?.source_bead_id === beadId);
      expect(mrBead).toBeTruthy();
      expect(mrBead?.metadata?.convoy_id).toBe(result.convoy.id);
    });
  });
});
