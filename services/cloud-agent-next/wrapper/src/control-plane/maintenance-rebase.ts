import { readFile, writeFile, unlink, access, open } from 'node:fs/promises';
import { z } from 'zod';
import {
  watchPrOwnedRebaseEvidenceSchema,
  type WatchPrOwnedRebaseEvidence,
  type MaintenanceChat,
} from '../../../src/shared/pr-maintenance.js';
import type { MaintenanceGit } from './maintenance-git.js';

const rebaseStateSchema = z
  .object({
    attemptId: z.uuid(),
    baseSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
    previousHeadSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  })
  .strict();

export function createMaintenanceRebase(chat: MaintenanceChat, git: MaintenanceGit) {
  let completed: WatchPrOwnedRebaseEvidence | undefined;
  let continuing = 0;
  async function readState(name: string): Promise<unknown> {
    try {
      const file = await open(await git.gitPath(name), 'r');
      try {
        const buffer = Buffer.alloc(8193);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 8192) throw new Error('maintenance_rebase_state_too_large');
        const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        return value;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw new Error('maintenance_rebase_state_invalid');
    }
  }
  async function inProgress() {
    for (const name of ['rebase-merge', 'rebase-apply']) {
      if (
        await access(await git.gitPath(name)).then(
          () => true,
          () => false
        )
      )
        return true;
    }
    return false;
  }
  async function owner() {
    return (
      await readFile(await git.gitPath('kilo-maintenance-rebase'), 'utf8').catch(() => '')
    ).trim();
  }
  async function recover() {
    const current = await owner();
    if (!current) return;
    if (current !== chat.attemptId && !chat.recoverableAttemptIds?.includes(current)) return;
    await git.abortOwnedRebase(current);
    await unlink(await git.gitPath('kilo-maintenance-rebase-state')).catch(() => undefined);
  }
  async function finishRebase(state: z.infer<typeof rebaseStateSchema>) {
    if (await inProgress()) return { status: 'conflicts' as const };
    const head = await git.text(['rev-parse', '--verify', 'HEAD^{commit}']);
    const branch = await git.text(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const ancestor = await git.exec(['merge-base', '--is-ancestor', state.baseSha, head]);
    if (
      branch !== chat.publication.headRef ||
      ancestor.exitCode !== 0 ||
      (await owner()) !== chat.attemptId
    )
      throw new Error('maintenance_completed_rebase_identity_unverified');
    completed = watchPrOwnedRebaseEvidenceSchema.parse({
      source: 'git',
      attemptId: chat.attemptId,
      baseSha: state.baseSha,
      previousHeadSha: state.previousHeadSha,
      rebasedHeadSha: head,
      completedAt: new Date().toISOString(),
    });
    await writeFile(
      await git.gitPath('kilo-maintenance-rebase-completed'),
      JSON.stringify(completed)
    );
    await unlink(await git.gitPath('kilo-maintenance-rebase'));
    await unlink(await git.gitPath('kilo-maintenance-rebase-state')).catch(() => undefined);
    return { status: 'completed' as const, evidence: completed };
  }
  async function start(signal: AbortSignal) {
    if (chat.allowRebase !== true)
      return { status: 'blocked', reason: 'maintenance_conflict_repairs_disabled' };
    await git.validateRemote(chat.publication.repoUrl, signal);
    if (await inProgress())
      return { status: 'blocked', reason: 'maintenance_rebase_already_in_progress' };
    if ((await git.text(['status', '--porcelain'], signal)).length)
      return { status: 'blocked', reason: 'maintenance_rebase_waiting_for_clean_checkout' };
    if (
      (await git.text(['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)) !==
      chat.publication.headRef
    )
      throw new Error('maintenance_branch_changed');
    const conflict = await inspectConflict(signal);
    if (conflict.status === 'mergeable')
      return { status: 'not_needed', reason: 'maintenance_git_conflict_check_clean' };
    const state = rebaseStateSchema.parse({
      attemptId: chat.attemptId,
      previousHeadSha: conflict.headSha,
      baseSha: conflict.baseSha,
    });
    await writeFile(await git.gitPath('kilo-maintenance-rebase-state'), JSON.stringify(state));
    await writeFile(await git.gitPath('kilo-maintenance-rebase'), chat.attemptId);
    const args = chat.parentCommitSha
      ? [
          'rebase',
          '--onto',
          `refs/remotes/origin/${chat.publication.baseRef}`,
          chat.parentCommitSha,
        ]
      : ['rebase', `refs/remotes/origin/${chat.publication.baseRef}`];
    const result = await git.exec(args, signal);
    if (result.exitCode !== 0 && !(await inProgress()))
      throw new Error('maintenance_rebase_failed');
    return finishRebase(state);
  }
  async function inspectConflict(signal: AbortSignal) {
    await git.validateRemote(chat.publication.repoUrl, signal);
    const fetched = await git.exec(
      [
        'fetch',
        'origin',
        `+refs/heads/${chat.publication.baseRef}:refs/remotes/origin/${chat.publication.baseRef}`,
      ],
      signal
    );
    if (fetched.exitCode !== 0 || fetched.terminationReason)
      throw new Error('maintenance_rebase_fetch_failed');
    const headSha = await git.text(['rev-parse', '--verify', 'HEAD^{commit}'], signal);
    const baseSha = await git.text(
      ['rev-parse', '--verify', `refs/remotes/origin/${chat.publication.baseRef}^{commit}`],
      signal
    );
    const conflict = await git.exec(['merge-tree', '--write-tree', headSha, baseSha], signal);
    if ((conflict.exitCode !== 0 && conflict.exitCode !== 1) || conflict.terminationReason)
      throw new Error('maintenance_git_conflict_check_failed');
    return {
      status: conflict.exitCode === 1 ? ('conflicting' as const) : ('mergeable' as const),
      headSha,
      baseSha,
    };
  }
  async function continueRebase(signal: AbortSignal) {
    if (chat.allowRebase !== true || (await owner()) !== chat.attemptId)
      throw new Error('maintenance_rebase_not_owned');
    if (++continuing > 100) throw new Error('maintenance_rebase_continue_limit');
    const parsed = rebaseStateSchema.safeParse(await readState('kilo-maintenance-rebase-state'));
    if (!parsed.success) throw new Error('maintenance_rebase_state_invalid');
    const state = parsed.data;
    if (state.attemptId !== chat.attemptId) throw new Error('maintenance_rebase_not_owned');
    const result = await git.exec(['-c', 'core.editor=true', 'rebase', '--continue'], signal);
    if (result.exitCode !== 0 && !(await inProgress()))
      throw new Error('maintenance_rebase_continue_failed');
    return finishRebase(state);
  }
  async function publicationEvidence() {
    if (!completed) {
      const persisted = await readState('kilo-maintenance-rebase-completed');
      if (persisted !== null) {
        const value = watchPrOwnedRebaseEvidenceSchema.safeParse(persisted);
        if (!value.success) throw new Error('maintenance_completed_rebase_state_invalid');
        if (value.data.attemptId === chat.attemptId) {
          const reflog = await git.text([
            'reflog',
            'show',
            'HEAD',
            '--format=%H%x00%gs',
            '-n',
            '100',
          ]);
          if (
            !reflog
              .split('\n')
              .some(line => line.startsWith(`${value.data.rebasedHeadSha}\0rebase (finish):`))
          )
            throw new Error('maintenance_completed_rebase_git_proof_missing');
          completed = value.data;
        }
      }
    }
    if (!completed) return undefined;
    const current = await git.text(['rev-parse', '--verify', 'HEAD^{commit}']);
    const ancestor = await git.exec([
      'merge-base',
      '--is-ancestor',
      completed.rebasedHeadSha,
      current,
    ]);
    if (ancestor.exitCode !== 0) throw new Error('maintenance_rebased_head_no_longer_current');
    return completed;
  }
  return { recover, inspectConflict, start, continueRebase, publicationEvidence };
}
