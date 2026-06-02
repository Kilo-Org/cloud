import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type WrapperBootstrapAttachment,
  type WrapperPromptRequest,
  type WrapperPromptPart,
  type WrapperSessionReadyRequest,
} from '../../src/shared/wrapper-bootstrap.js';
import { git, logToFile, runProcess, type ExecResult } from './utils.js';
import { restoreSession } from './restore-session.js';

const SETUP_COMMAND_TIMEOUT_MS = 300_000;
const GIT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_ATTACHMENT_BYTES = 5_242_880;

export type BootstrapProgressStep =
  | 'disk_check'
  | 'workspace_setup'
  | 'cloning'
  | 'branch'
  | 'kilo_session'
  | 'setup_commands'
  | 'attachments'
  | 'kilo_server';

export type BootstrapProgress = (step: BootstrapProgressStep, message: string) => void;

export type WrapperBootstrapResult = {
  workspaceWasWarm: boolean;
};

type GitRunner = (
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number }
) => Promise<ExecResult>;
type ProcessRunner = (
  command: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number }
) => Promise<ExecResult>;

export type WrapperBootstrapDeps = {
  git?: GitRunner;
  runProcess?: ProcessRunner;
  restoreSession?: typeof restoreSession;
};

function sanitizeGitOutput(output: string): string {
  return output.replace(/(oauth2|x-access-token|x-token-auth):([^@]+)@/gi, '$1:***@');
}

function authenticatedUrl(
  gitUrl: string,
  token: string | undefined,
  platform: 'github' | 'gitlab' | undefined
): string {
  if (!token) return gitUrl;
  const url = new URL(gitUrl);
  url.username = platform === 'gitlab' ? 'oauth2' : 'x-access-token';
  url.password = token;
  return url.toString();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureWorkspaceDirectories(request: WrapperSessionReadyRequest): Promise<void> {
  await fs.mkdir(request.workspace.workspacePath, { recursive: true });
  await fs.mkdir(request.workspace.sessionHome, { recursive: true });
}

async function cleanupWorkspace(request: WrapperSessionReadyRequest): Promise<void> {
  await Promise.allSettled([
    fs.rm(request.workspace.workspacePath, { recursive: true, force: true }),
    fs.rm(request.workspace.sessionHome, { recursive: true, force: true }),
  ]);
}

async function cloneRepository(
  request: WrapperSessionReadyRequest,
  runGit: GitRunner
): Promise<void> {
  const repo = request.repo;
  if (!repo) {
    throw new Error('Session metadata is missing a repository source');
  }

  const gitUrl = repo.kind === 'github' ? `https://github.com/${repo.repo}.git` : repo.url;
  const platform = repo.kind === 'git' ? repo.platform : 'github';
  const repoUrl = authenticatedUrl(gitUrl, repo.token, platform);
  const args = ['clone'];
  if (repo.shallow) {
    args.push('--depth', '1');
  }
  args.push(repoUrl, request.workspace.workspacePath);

  await fs.rm(request.workspace.workspacePath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(request.workspace.workspacePath), { recursive: true });

  const result = await runGit(args, { timeoutMs: GIT_COMMAND_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new Error(`Git clone failed: ${sanitizeGitOutput(result.stderr || result.stdout)}`);
  }

  const authorName =
    repo.kind === 'github' ? (repo.gitAuthor?.name ?? 'Kilo Code Cloud') : 'Kilo Code Cloud';
  const authorEmail =
    repo.kind === 'github' ? (repo.gitAuthor?.email ?? 'agent@kilocode.ai') : 'agent@kilocode.ai';
  const authorNameResult = await runGit(['config', 'user.name', authorName], {
    cwd: request.workspace.workspacePath,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  const authorEmailResult = await runGit(['config', 'user.email', authorEmail], {
    cwd: request.workspace.workspacePath,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  if (authorNameResult.exitCode !== 0 || authorEmailResult.exitCode !== 0) {
    throw new Error('Failed to configure git author identity');
  }
}

async function branchExists(
  runGit: GitRunner,
  workspacePath: string,
  branch: string,
  remote: boolean
): Promise<boolean> {
  const ref = remote ? `origin/${branch}` : branch;
  const result = await runGit(['rev-parse', '--verify', ref], {
    cwd: workspacePath,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  return result.exitCode === 0;
}

const GITHUB_PULL_REF_PATTERN = /^refs\/pull\/\d+\/head$/;
const GITLAB_MR_REF_PATTERN = /^refs\/merge-requests\/\d+\/head$/;

function isSyntheticReviewRef(branchName: string): boolean {
  return GITHUB_PULL_REF_PATTERN.test(branchName) || GITLAB_MR_REF_PATTERN.test(branchName);
}

async function fetchSyntheticReviewRef(
  runGit: GitRunner,
  workspacePath: string,
  branchName: string
): Promise<void> {
  const fetchResult = await runGit(['fetch', 'origin', branchName], {
    cwd: workspacePath,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  if (fetchResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch pull ref ${branchName}: ${sanitizeGitOutput(fetchResult.stderr || fetchResult.stdout)}`
    );
  }

  const checkoutResult = await runGit(['checkout', '-B', branchName, 'FETCH_HEAD'], {
    cwd: workspacePath,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  if (checkoutResult.exitCode !== 0) {
    throw new Error(
      `Failed to checkout pull ref ${branchName}: ${sanitizeGitOutput(checkoutResult.stderr || checkoutResult.stdout)}`
    );
  }
}

async function prepareBranch(
  request: WrapperSessionReadyRequest,
  runGit: GitRunner
): Promise<void> {
  const { workspacePath, branchName, strictBranch } = request.workspace;
  if (strictBranch && isSyntheticReviewRef(branchName)) {
    await fetchSyntheticReviewRef(runGit, workspacePath, branchName);
    return;
  }

  await runGit(['fetch', 'origin'], { cwd: workspacePath, timeoutMs: GIT_COMMAND_TIMEOUT_MS });

  if (await branchExists(runGit, workspacePath, branchName, false)) {
    const result = await runGit(['checkout', branchName], {
      cwd: workspacePath,
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to checkout branch ${branchName}`);
    }
    return;
  }

  if (await branchExists(runGit, workspacePath, branchName, true)) {
    const result = await runGit(['checkout', '-B', branchName, `origin/${branchName}`], {
      cwd: workspacePath,
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to checkout branch ${branchName}`);
    }
    return;
  }

  if (strictBranch) {
    throw new Error(`Branch "${branchName}" not found in repository`);
  }

  const result = await runGit(['checkout', '-b', branchName], {
    cwd: workspacePath,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create session branch ${branchName}`);
  }
}

async function refreshGitRemoteToken(
  request: WrapperSessionReadyRequest,
  runGit: GitRunner
): Promise<void> {
  const repo = request.repo;
  if (!repo?.refreshRemote || !repo.token) return;

  const gitUrl = repo.kind === 'github' ? `https://github.com/${repo.repo}.git` : repo.url;
  const platform = repo.kind === 'git' ? repo.platform : 'github';
  const nextUrl = authenticatedUrl(gitUrl, repo.token, platform);
  const result = await runGit(['remote', 'set-url', 'origin', nextUrl], {
    cwd: request.workspace.workspacePath,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error('Failed to update git remote URL');
  }
  if (repo.kind === 'github' && repo.gitAuthor) {
    const nameResult = await runGit(['config', 'user.name', repo.gitAuthor.name], {
      cwd: request.workspace.workspacePath,
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    });
    const emailResult = await runGit(['config', 'user.email', repo.gitAuthor.email], {
      cwd: request.workspace.workspacePath,
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    });
    if (nameResult.exitCode !== 0 || emailResult.exitCode !== 0) {
      throw new Error('Failed to configure git author identity');
    }
  }
}

async function writeSessionFiles(request: WrapperSessionReadyRequest): Promise<void> {
  const kiloAuthDir = path.join(request.workspace.sessionHome, '.local/share/kilo');
  await fs.mkdir(kiloAuthDir, { recursive: true });
  await fs.writeFile(
    path.join(kiloAuthDir, 'auth.json'),
    JSON.stringify({ kilo: { type: 'api', key: request.session.workerAuthToken } }, null, 2)
  );

  const rulesDir = path.join(request.workspace.sessionHome, '.kilocode/rules');
  await fs.mkdir(rulesDir, { recursive: true });
  await fs.writeFile(
    path.join(rulesDir, 'cloud-agent.md'),
    [
      '# Cloud Agent Environment',
      '',
      "You are running inside a sandboxed cloud container, not on the user's local machine.",
      'The filesystem is ephemeral and will not persist after the session ends.',
      "Do not assume access to the user's local files, browsers, or desktop environment.",
      '',
      '## Temporary Files',
      '',
      `When you need to create temporary or scratch files, use \`/tmp/${request.agentSessionId}/\` as your scratch directory.`,
      'This path is pre-approved for file access and will not trigger permission prompts.',
      '',
    ].join('\n')
  );
}

function isSafeSkillFilePath(relativePath: string): boolean {
  if (relativePath.length === 0 || relativePath.length > 200) return false;
  if (relativePath.startsWith('/')) return false;
  if (relativePath.includes('..')) return false;
  if (relativePath.includes('\\') || relativePath.includes('\0')) return false;
  if (relativePath.toLowerCase() === 'skill.md') return false;
  return /^[a-zA-Z0-9._\-/]+$/.test(relativePath);
}

async function writeRuntimeSkills(request: WrapperSessionReadyRequest): Promise<void> {
  const skills = request.materialized.runtimeSkills;
  if (!skills?.length) return;

  const baseDir = path.join(request.workspace.sessionHome, '.kilocode/skills');
  await fs.mkdir(baseDir, { recursive: true });

  for (const skill of skills) {
    const skillDir = path.join(baseDir, skill.name);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), skill.rawMarkdown);
    for (const [relativePath, content] of Object.entries(skill.files ?? {})) {
      if (!isSafeSkillFilePath(relativePath)) continue;
      const targetPath = path.join(skillDir, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content);
    }
  }
}

async function bootstrapEmptyKiloSession(
  request: WrapperSessionReadyRequest,
  restore: typeof restoreSession
): Promise<void> {
  const now = Date.now();
  const minimalSessionJson = JSON.stringify({
    info: {
      id: request.kiloSessionId,
      slug: '',
      projectID: '',
      directory: '',
      title: 'New session - ' + new Date(now).toISOString(),
      version: '2',
      time: { created: now, updated: now },
    },
    messages: [],
  });
  const importFilePath = `/tmp/kilo-empty-session-${request.kiloSessionId}.json`;
  logToFile(
    `bootstrap empty kilo session writing kiloSessionId=${request.kiloSessionId} importFilePath=${importFilePath} workspacePath=${request.workspace.workspacePath} sessionHome=${request.workspace.sessionHome} jsonChars=${minimalSessionJson.length}`
  );
  await fs.writeFile(importFilePath, minimalSessionJson);
  const result = await restore(
    request.kiloSessionId,
    request.workspace.workspacePath,
    importFilePath
  );
  if (!result.ok) {
    logToFile(
      `bootstrap empty kilo session failed kiloSessionId=${request.kiloSessionId} step=${result.step} code=${result.code ?? '(none)'} error=${result.error}`
    );
    throw new Error(`Session bootstrap failed: ${result.error}`);
  }
  logToFile(
    `bootstrap empty kilo session ready kiloSessionId=${request.kiloSessionId} diffsApplied=${result.diffs.applied} diffsSkipped=${result.diffs.skipped} diffsTotal=${result.diffs.total}`
  );
}

async function restoreOrBootstrapKiloSession(
  request: WrapperSessionReadyRequest,
  restore: typeof restoreSession
): Promise<void> {
  if (request.workspace.preferSnapshot) {
    logToFile(
      `bootstrap snapshot restore starting kiloSessionId=${request.kiloSessionId} workspacePath=${request.workspace.workspacePath}`
    );
    const result = await restore(request.kiloSessionId, request.workspace.workspacePath);
    if (result.ok) {
      logToFile(
        `bootstrap snapshot restore ready kiloSessionId=${request.kiloSessionId} downloaded=${result.downloaded} diffsApplied=${result.diffs.applied} diffsSkipped=${result.diffs.skipped} diffsTotal=${result.diffs.total}`
      );
      return;
    }
    logToFile(
      `bootstrap snapshot restore failed kiloSessionId=${request.kiloSessionId} step=${result.step} code=${result.code ?? '(none)'} error=${result.error}`
    );
    if (result.code !== 404) {
      throw new Error(`Session snapshot restore failed: ${result.error}`);
    }
    logToFile(
      `bootstrap snapshot missing; falling back to empty import kiloSessionId=${request.kiloSessionId}`
    );
  } else {
    logToFile(`bootstrap fresh session using empty import kiloSessionId=${request.kiloSessionId}`);
  }
  await bootstrapEmptyKiloSession(request, restore);
}

async function runSetupCommands(
  request: WrapperSessionReadyRequest,
  run: ProcessRunner,
  failFast: boolean
): Promise<void> {
  const setupCommands = request.materialized.setupCommands ?? [];
  logToFile(
    `bootstrap setup commands starting kiloSessionId=${request.kiloSessionId} count=${setupCommands.length} failFast=${failFast} workspacePath=${request.workspace.workspacePath}`
  );
  for (const command of setupCommands) {
    const result = await run('sh', ['-lc', command], {
      cwd: request.workspace.workspacePath,
      timeoutMs: SETUP_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 && failFast) {
      throw new Error(`Setup command failed: ${command} (exit code ${result.exitCode})`);
    }
  }
  logToFile(
    `bootstrap setup commands finished kiloSessionId=${request.kiloSessionId} count=${setupCommands.length}`
  );
}

async function downloadAttachment(
  attachment: WrapperBootstrapAttachment,
  fetchImpl: typeof fetch,
  writeResponse: (filePath: string, response: Response) => Promise<number>
): Promise<WrapperPromptPart> {
  await fs.mkdir(path.dirname(attachment.localPath), { recursive: true });
  const response = await fetchImpl(attachment.signedUrl, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Attachment download failed: ${attachment.filename}`);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment too large: ${attachment.filename}`);
  }
  await writeResponse(attachment.localPath, response);
  return {
    type: 'file',
    mime: attachment.mime,
    url: `file://${attachment.localPath}`,
    filename: attachment.filename,
  };
}

export async function materializePromptAttachments(
  prompt: WrapperPromptRequest,
  deps: {
    fetch?: typeof fetch;
    writeResponse?: (filePath: string, response: Response) => Promise<number>;
  } = {}
): Promise<WrapperPromptRequest> {
  if (!prompt.message.attachments?.length) return prompt;
  const fetchImpl = deps.fetch ?? fetch;
  const writeResponse =
    deps.writeResponse ?? ((filePath: string, response: Response) => Bun.write(filePath, response));
  const fileParts: WrapperPromptPart[] = [];
  for (const attachment of prompt.message.attachments) {
    fileParts.push(await downloadAttachment(attachment, fetchImpl, writeResponse));
  }
  return {
    ...prompt,
    message: {
      ...prompt.message,
      parts: [
        ...(prompt.message.parts ?? [{ type: 'text', text: prompt.message.prompt ?? '' }]),
        ...fileParts,
      ],
      prompt: undefined,
      attachments: undefined,
    },
  };
}

export async function prepareWrapperBootstrapWorkspace(
  request: WrapperSessionReadyRequest,
  progress?: BootstrapProgress,
  deps: WrapperBootstrapDeps = {}
): Promise<WrapperBootstrapResult> {
  const runGit = deps.git ?? git;
  const run = deps.runProcess ?? runProcess;
  const restore = deps.restoreSession ?? restoreSession;

  Object.assign(process.env, request.materialized.env);

  const workspaceWasWarm = await exists(path.join(request.workspace.workspacePath, '.git'));
  const workspaceNeedsBootstrap = !workspaceWasWarm || !request.workspace.preferSnapshot;
  logToFile(
    `bootstrap workspace plan kiloSessionId=${request.kiloSessionId} preferSnapshot=${request.workspace.preferSnapshot} workspaceWasWarm=${workspaceWasWarm} workspaceNeedsBootstrap=${workspaceNeedsBootstrap} workspacePath=${request.workspace.workspacePath} sessionHome=${request.workspace.sessionHome} home=${process.env.HOME ?? '(unset)'} homeMatchesSessionHome=${process.env.HOME === request.workspace.sessionHome} repoKind=${request.repo?.kind ?? '(none)'} setupCommandCount=${request.materialized.setupCommands?.length ?? 0} runtimeSkillCount=${request.materialized.runtimeSkills?.length ?? 0}`
  );
  if (!workspaceWasWarm) {
    progress?.('workspace_setup', 'Setting up workspace...');
  }
  await ensureWorkspaceDirectories(request);

  try {
    if (workspaceWasWarm) {
      logToFile(
        `bootstrap warm workspace refreshing remote kiloSessionId=${request.kiloSessionId}`
      );
      await refreshGitRemoteToken(request, runGit);
      logToFile(`bootstrap warm workspace remote ready kiloSessionId=${request.kiloSessionId}`);
    } else {
      progress?.('cloning', 'Cloning repository...');
      logToFile(
        `bootstrap cold workspace cloning repository kiloSessionId=${request.kiloSessionId}`
      );
      await cloneRepository(request, runGit);
      logToFile(`bootstrap cold workspace clone ready kiloSessionId=${request.kiloSessionId}`);
    }

    if (workspaceNeedsBootstrap) {
      progress?.('branch', 'Setting up branch...');
      logToFile(
        `bootstrap branch preparation starting kiloSessionId=${request.kiloSessionId} branchName=${request.workspace.branchName} strictBranch=${request.workspace.strictBranch ?? false}`
      );
      await prepareBranch(request, runGit);
      logToFile(
        `bootstrap branch preparation ready kiloSessionId=${request.kiloSessionId} branchName=${request.workspace.branchName}`
      );

      await writeSessionFiles(request);
      await writeRuntimeSkills(request);

      progress?.(
        'kilo_session',
        request.workspace.preferSnapshot ? 'Restoring session...' : 'Importing session...'
      );
      await restoreOrBootstrapKiloSession(request, restore);

      if (request.materialized.setupCommands?.length) {
        progress?.('setup_commands', 'Running setup commands...');
        await runSetupCommands(request, run, !request.workspace.preferSnapshot);
      }
    }

    logToFile(
      `bootstrap workspace ready kiloSessionId=${request.kiloSessionId} workspaceWasWarm=${workspaceWasWarm} workspaceNeedsBootstrap=${workspaceNeedsBootstrap}`
    );
    return { workspaceWasWarm };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logToFile(
      `bootstrap workspace failed kiloSessionId=${request.kiloSessionId} workspaceWasWarm=${workspaceWasWarm} workspaceNeedsBootstrap=${workspaceNeedsBootstrap} willCleanup=${workspaceNeedsBootstrap} error=${message}`
    );
    if (workspaceNeedsBootstrap) {
      await cleanupWorkspace(request);
      logToFile(`bootstrap workspace cleanup finished kiloSessionId=${request.kiloSessionId}`);
    }
    throw error;
  }
}
