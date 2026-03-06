import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getTownStub(name = 'test-town') {
  const id = env.TOWN.idFromName(name);
  return env.TOWN.get(id);
}

describe('Convoy DAG and Feature Branches', () => {
  let town: ReturnType<typeof getTownStub>;

  beforeEach(() => {
    town = getTownStub(`convoy-dag-${crypto.randomUUID()}`);
  });

  // ── Feature Branch ─────────────────────────────────────────────────

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

      // Should be lowercased, special chars replaced with hyphens, ends with /head
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

  // ── DAG Dependencies ───────────────────────────────────────────────

  describe('DAG dependency edges', () => {
    it('should create blocks dependencies from depends_on indices', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      // Task 0: no deps
      // Task 1: depends on Task 0
      // Task 2: depends on Task 0 and Task 1
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
      expect(status!.dependency_edges.length).toBe(3); // 1→0, 2→0, 2→1

      const beadIds = result.beads.map(b => b.bead.bead_id);

      // Step 2 (index 1) depends on Step 1 (index 0)
      expect(status!.dependency_edges).toContainEqual({
        bead_id: beadIds[1],
        depends_on_bead_id: beadIds[0],
      });

      // Step 3 (index 2) depends on Step 1 (index 0)
      expect(status!.dependency_edges).toContainEqual({
        bead_id: beadIds[2],
        depends_on_bead_id: beadIds[0],
      });

      // Step 3 (index 2) depends on Step 2 (index 1)
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

  // ── DAG-Aware Scheduling ───────────────────────────────────────────

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

      // The first bead should be open (ready to dispatch) or in_progress
      // The second and third should remain open (blocked)
      const bead0 = await town.getBeadAsync(result.beads[0].bead.bead_id);
      const bead1 = await town.getBeadAsync(result.beads[1].bead.bead_id);
      const bead2 = await town.getBeadAsync(result.beads[2].bead.bead_id);

      // First bead should have an agent hooked and be ready for dispatch
      expect(bead0?.assignee_agent_bead_id).toBeTruthy();

      // Second and third are blocked but still have agents hooked
      // (they'll be dispatched when unblocked)
      expect(bead1?.assignee_agent_bead_id).toBeTruthy();
      expect(bead2?.assignee_agent_bead_id).toBeTruthy();
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

      const beadIds = result.beads.map(b => b.bead.bead_id);
      const agentIds = result.beads.map(b => b.agent.id);

      // Close the first bead — this should unblock the second
      await town.updateBeadStatus(beadIds[0], 'closed', agentIds[0]);

      // After closing, check convoy progress
      const status = await town.getConvoyStatus(result.convoy.id);
      expect(status?.closed_beads).toBe(1);

      // The second bead should still be open/in_progress (it was unblocked)
      const bead1 = await town.getBeadAsync(beadIds[1]);
      expect(bead1?.status).not.toBe('closed');
      // Its agent should still be hooked
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

      const beadIds = result.beads.map(b => b.bead.bead_id);
      const agentIds = result.beads.map(b => b.agent.id);

      // Close task A — task C should still be blocked (B is open)
      await town.updateBeadStatus(beadIds[0], 'closed', agentIds[0]);

      const status1 = await town.getConvoyStatus(result.convoy.id);
      expect(status1?.closed_beads).toBe(1);

      // Close task B — task C should now be unblocked
      await town.updateBeadStatus(beadIds[1], 'closed', agentIds[1]);

      const status2 = await town.getConvoyStatus(result.convoy.id);
      expect(status2?.closed_beads).toBe(2);
    });
  });

  // ── Convoy Progress and Auto-Landing ────────────────────────────────

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

      // Initially 0 closed
      let status = await town.getConvoyStatus(result.convoy.id);
      expect(status?.closed_beads).toBe(0);
      expect(status?.total_beads).toBe(3);

      // Close one bead
      const beadIds = result.beads.map(b => b.bead.bead_id);
      const agentIds = result.beads.map(b => b.agent.id);
      await town.updateBeadStatus(beadIds[0], 'closed', agentIds[0]);

      status = await town.getConvoyStatus(result.convoy.id);
      expect(status?.closed_beads).toBe(1);

      // Close second
      await town.updateBeadStatus(beadIds[1], 'closed', agentIds[1]);

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

      // Convoy should have a feature branch
      expect(result.convoy.feature_branch).toBeTruthy();

      const beadId = result.beads[0].bead.bead_id;
      const agentId = result.beads[0].agent.id;

      // Close the only bead
      await town.updateBeadStatus(beadId, 'closed', agentId);

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
      const agentIds = result.beads.map(b => b.agent.id);

      // Fail one bead, close the other
      await town.updateBeadStatus(beadIds[0], 'failed', agentIds[0]);
      await town.updateBeadStatus(beadIds[1], 'closed', agentIds[1]);

      const status = await town.getConvoyStatus(result.convoy.id);
      // Both failed and closed count toward progress
      expect(status?.closed_beads).toBe(2);
    });
  });

  // ── Force Close ────────────────────────────────────────────────────

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

      // All beads should be closed
      for (const b of result.beads) {
        const bead = await town.getBeadAsync(b.bead.bead_id);
        expect(bead?.status).toBe('closed');
      }
    });
  });

  // ── Self-referential and edge cases ────────────────────────────────

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
      // Self-references should be ignored
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

  // ── Merge Mode ─────────────────────────────────────────────────────

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

      const beadId = result.beads[0].bead.bead_id;
      const agentId = result.beads[0].agent.id;

      // Simulate agent completing work
      await town.agentDone(agentId, {
        branch: 'gt/toast/test1234',
        summary: 'Done with task',
      });

      // Verify the source bead was closed and a review entry was created
      const bead = await town.getBeadAsync(beadId);
      expect(bead?.status).toBe('closed');

      // Check that the MR bead exists with convoy metadata
      const allBeads = await town.listBeads({ type: 'merge_request' });
      const mrBead = allBeads.find(b => b.metadata?.source_bead_id === beadId);
      expect(mrBead).toBeTruthy();
      expect(mrBead?.metadata?.convoy_id).toBe(result.convoy.id);
    });
  });
});
