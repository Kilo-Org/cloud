import { readFile, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import { git, type ExecResult, type ProcessOptions } from '../utils.js';
import {
  watchPrPublicationEvidenceSchema,
  type MaintenanceChat,
  type WatchPrPublicationEvidence,
  type WatchPrOwnedRebaseEvidence,
  type MaintenanceOutcome,
} from '../../../src/shared/pr-maintenance.js';

export type MaintenanceGitOptions = {
  directory: string;
  env?: NodeJS.ProcessEnv;
  runGit?: (args: string[], options?: ProcessOptions) => Promise<ExecResult>;
};

const shaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export function createMaintenanceGit(options: MaintenanceGitOptions) {
  const run = options.runGit ?? git;
  async function exec(args: string[], signal?: AbortSignal, timeoutMs = 60_000) {
    return run(['--no-pager', '-c', 'color.ui=false', ...args], {
      cwd: options.directory,
      ...(options.env ? { env: options.env, inheritEnv: false } : {}),
      timeoutMs,
      maxOutputBytes: 16_384,
      signal,
    });
  }
  async function text(args: string[], signal?: AbortSignal) {
    const result = await exec(args, signal);
    if (result.exitCode !== 0 || result.terminationReason)
      throw new Error(`maintenance_git_${args[0]?.replaceAll('-', '_') ?? 'command'}_failed`);
    return result.stdout.trim();
  }
  async function gitPath(name: string) {
    return path.resolve(options.directory, await text(['rev-parse', '--git-path', name]));
  }
  async function remoteHead(branch: string, signal?: AbortSignal) {
    const output = await text(
      ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`],
      signal
    );
    const rows = output.split('\n').map(line => line.split(/\s+/));
    const sha = rows.find(row => row[1] === `refs/heads/${branch}`)?.[0];
    if (!sha || !shaPattern.test(sha)) throw new Error('maintenance_remote_head_unavailable');
    return sha;
  }
  async function validateRemote(repoUrl: string, signal?: AbortSignal) {
    const pushUrl = await exec(['config', '--get', 'remote.origin.pushurl'], signal);
    const url =
      pushUrl.exitCode === 0
        ? pushUrl.stdout.trim()
        : await text(['config', '--get', 'remote.origin.url'], signal);
    const canonical = url
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/\.git$/, '')
      .replace(/\/$/, '')
      .toLowerCase();
    if (canonical !== repoUrl) throw new Error('maintenance_remote_identity_changed');
  }
  async function abortOwnedRebase(attemptId: string): Promise<'not_owned' | 'cleared' | 'aborted'> {
    const marker = await gitPath('kilo-maintenance-rebase');
    let owner: string;
    try {
      owner = (await readFile(marker, 'utf8')).trim();
    } catch {
      return 'not_owned';
    }
    if (owner !== attemptId) return 'not_owned';
    let rebasing = false;
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const exists = await access(await gitPath(name)).then(
        () => true,
        () => false
      );
      if (exists) rebasing = true;
    }
    if (rebasing) {
      const result = await exec(['rebase', '--abort']);
      if (result.exitCode !== 0 || result.terminationReason)
        throw new Error('maintenance_rebase_abort_failed');
    }
    if ((await readFile(marker, 'utf8').catch(() => '')).trim() === attemptId) await unlink(marker);
    return rebasing ? 'aborted' : 'cleared';
  }
  async function observe(target: MaintenanceChat['publication'], signal?: AbortSignal) {
    await validateRemote(target.repoUrl, signal);
    return remoteHead(
      target.headRef,
      signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000)
    );
  }
  async function snapshot(
    target: MaintenanceChat['publication']
  ): Promise<NonNullable<MaintenanceOutcome['workspace']>> {
    try {
      const signal = AbortSignal.timeout(5_000);
      await validateRemote(target.repoUrl, signal);
      const headSha = await text(['rev-parse', '--verify', 'HEAD^{commit}'], signal);
      if (!shaPattern.test(headSha)) throw new Error('maintenance_head_unavailable');
      const dirty = (await text(['status', '--porcelain'], signal)).length > 0;
      const remoteHeadSha = await remoteHead(target.headRef, signal);
      return {
        status: 'observed',
        source: 'git',
        headSha,
        dirty,
        remoteHeadSha,
        verifiedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'unavailable',
        reason: error instanceof Error ? error.message : 'maintenance_git_state_unavailable',
      };
    }
  }
  async function publish(
    target: MaintenanceChat['publication'],
    observedHeadSha: string,
    signal: AbortSignal,
    ownedRebase?: WatchPrOwnedRebaseEvidence
  ): Promise<WatchPrPublicationEvidence> {
    let pushStarted = false;
    let pushSucceeded = false;
    try {
      await validateRemote(target.repoUrl, signal);
      const branch = await text(['symbolic-ref', '--quiet', '--short', 'HEAD'], signal);
      if (branch !== target.headRef)
        return { status: 'failed', reason: 'maintenance_branch_changed_or_rebase_unfinished' };
      const head = await text(['rev-parse', '--verify', 'HEAD^{commit}'], signal);
      if (!shaPattern.test(head)) throw new Error('maintenance_head_unavailable');
      if (
        ownedRebase &&
        (await exec(['merge-base', '--is-ancestor', ownedRebase.rebasedHeadSha, head], signal))
          .exitCode !== 0
      )
        throw new Error('maintenance_owned_rebase_not_in_published_head');
      const baseSha = await text(
        ['merge-base', head, `refs/remotes/origin/${target.baseRef}`],
        signal
      );
      if (!shaPattern.test(baseSha)) throw new Error('maintenance_base_commit_unavailable');
      const exactLease = `refs/heads/${target.headRef}:${observedHeadSha}`;
      pushStarted = true;
      const pushed = await exec(
        [
          'push',
          `--force-with-lease=${exactLease}`,
          'origin',
          `${head}:refs/heads/${target.headRef}`,
        ],
        signal
      );
      if (pushed.terminationReason)
        return { status: 'unknown', reason: 'maintenance_push_interrupted_recheck_remote' };
      if (pushed.exitCode !== 0)
        return {
          status: 'failed',
          reason: 'maintenance_exact_lease_push_failed_fetch_and_reassess',
        };
      pushSucceeded = true;
      const remoteHeadSha = await remoteHead(target.headRef, signal);
      if (remoteHeadSha !== head)
        return { status: 'unknown', reason: 'maintenance_remote_head_changed_after_push' };
      return watchPrPublicationEvidenceSchema.parse({
        status: 'published',
        source: 'git',
        repoUrl: target.repoUrl,
        headRef: target.headRef,
        observedHeadSha,
        pushedHeadSha: head,
        remoteHeadSha,
        baseSha: ownedRebase?.baseSha ?? baseSha,
        exactLease,
        pushExitCode: pushed.exitCode,
        verifiedAt: new Date().toISOString(),
        ...(ownedRebase ? { ownedRebase } : {}),
      });
    } catch (error) {
      return {
        status: pushStarted || pushSucceeded ? 'unknown' : 'failed',
        reason: error instanceof Error ? error.message : 'maintenance_git_evidence_unavailable',
      };
    }
  }
  return {
    exec,
    text,
    gitPath,
    remoteHead,
    validateRemote,
    observe,
    snapshot,
    publish,
    abortOwnedRebase,
  };
}

export type MaintenanceGit = ReturnType<typeof createMaintenanceGit>;
