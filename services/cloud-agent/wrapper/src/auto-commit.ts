import { spawn } from 'child_process';
import type { IngestEvent } from '../../src/shared/protocol.js';
import { exec, getCurrentBranch } from './utils.js';
import { parseKilocodeOutput, stripAnsi } from './event-parser.js';

export type AutoCommitOptions = {
  workspacePath: string;
  upstreamBranch?: string;
  onEvent: (event: IngestEvent) => void;
};

function buildAutoCommitPrompt(hasUpstream: boolean): string {
  const lines = [
    'Commit and push all uncommitted changes. Follow these guidelines:',
    '1. Create a clear, concise commit message summarizing the changes',
    '2. Stage all modified and new files (git add -A)',
    '3. If pre-commit hooks fail, retry with --no-verify',
    '4. Push to the current branch',
    '5. Do NOT force push',
    '6. If you detect secrets or credentials, decline to commit and explain why',
  ];
  if (!hasUpstream) {
    lines.push('7. Do NOT push to main or master branches - if on these branches, skip the push');
  }
  return lines.join('\n');
}

export async function runAutoCommit(opts: AutoCommitOptions): Promise<void> {
  const sendStatus = (msg: string) =>
    opts.onEvent({
      streamEventType: 'status',
      data: { message: msg },
      timestamp: new Date().toISOString(),
    });

  try {
    // Check current branch
    const branch = await getCurrentBranch(opts.workspacePath);
    if (!branch) {
      sendStatus('Auto-commit skipped: detached HEAD state');
      return;
    }

    // Branch protection
    const hasUpstream = opts.upstreamBranch !== undefined && opts.upstreamBranch !== '';
    if (!hasUpstream && (branch === 'main' || branch === 'master')) {
      sendStatus(`Auto-commit skipped: cannot commit to ${branch}`);
      return;
    }

    // Check for changes
    const status = await exec(`cd ${opts.workspacePath} && git status --porcelain`);
    if (!status.stdout.trim()) {
      sendStatus('No uncommitted changes');
      return;
    }

    sendStatus('Auto-committing changes...');

    // Select prompt based on explicit upstream branch
    const prompt = buildAutoCommitPrompt(hasUpstream);

    // Run kilocode for commit
    const proc = spawn(
      'kilocode',
      ['--mode', 'code', '--workspace', opts.workspacePath, '--auto', '--json'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error('Failed to open kilocode stdio streams');
    }

    proc.stdin.write(prompt);
    proc.stdin.end();

    // Forward events - line buffered
    let acStdoutBuffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      acStdoutBuffer += chunk.toString();
      const lines = acStdoutBuffer.split('\n');
      acStdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        opts.onEvent(parseKilocodeOutput(line));
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      opts.onEvent({
        streamEventType: 'output',
        data: { content: stripAnsi(chunk.toString()), source: 'stderr' },
        timestamp: new Date().toISOString(),
      });
    });

    await new Promise<void>((resolve, reject) => {
      proc.on('exit', code => (code === 0 ? resolve() : reject(new Error(`Exit code ${code}`))));
      proc.on('error', reject);
    });

    sendStatus('Auto-commit completed');
  } catch (error) {
    opts.onEvent({
      streamEventType: 'error',
      data: {
        error: `Auto-commit failed: ${error instanceof Error ? error.message : String(error)}`,
        fatal: false,
      },
      timestamp: new Date().toISOString(),
    });
  }
}
