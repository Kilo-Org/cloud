import { spawn } from 'child_process';
import type { IngestEvent } from '../../src/shared/protocol.js';
import { parseKilocodeOutput, stripAnsi } from './event-parser.js';

export type CondenseOnCompleteOptions = {
  workspacePath: string;
  kiloSessionId: string;
  onEvent: (event: IngestEvent) => void;
};

export async function runCondenseOnComplete(opts: CondenseOnCompleteOptions): Promise<void> {
  const sendStatus = (msg: string) =>
    opts.onEvent({
      streamEventType: 'status',
      data: { message: msg },
      timestamp: new Date().toISOString(),
    });

  try {
    sendStatus('Condensing context...');

    // Build kilo command with /condense message
    const args = [
      '--workspace',
      opts.workspacePath,
      '--json',
      '--auto',
      '--session',
      opts.kiloSessionId,
      '/condense',
    ];

    const proc = spawn('kilocode', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error('Failed to open kilo stdio streams');
    }

    // Close stdin immediately - /condense is passed as argument
    proc.stdin.end();

    // Forward events - line buffered
    let stdoutBuffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

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

    sendStatus('Context condensed successfully');
  } catch (error) {
    opts.onEvent({
      streamEventType: 'error',
      data: {
        error: `Condense context failed: ${error instanceof Error ? error.message : String(error)}`,
        fatal: false,
      },
      timestamp: new Date().toISOString(),
    });
  }
}
