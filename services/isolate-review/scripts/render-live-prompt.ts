import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { StartReviewRequestSchema } from '../src/types';

const MAX_PREPARED_ARTIFACT_BYTES = 2 * 1024 * 1024;

export type RenderLivePromptOptions = {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
};

export function parsePreparedPromptArtifact(value: unknown) {
  const parsed = StartReviewRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid prepared prompt artifact request contract');
  const { preparation, userPrompt, gitToken } = parsed.data;
  if (gitToken !== undefined)
    throw new Error('Prepared prompt artifacts must not contain credentials');
  if (!preparation || !userPrompt?.trim()) {
    throw new Error(
      'A complete canonical prepared prompt artifact is required; raw template reconstruction is not supported'
    );
  }
  const hash = createHash('sha256').update(userPrompt).digest('hex');
  if (hash !== preparation.hashes.adaptedPrompt) {
    throw new Error('Prepared prompt artifact does not match its adapted prompt hash');
  }
  return { ...parsed.data, preparation, userPrompt };
}

export function readPreparedPromptArtifact(path: string) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_PREPARED_ARTIFACT_BYTES) {
    throw new Error('Prepared prompt artifact must be a regular file no larger than 2 MiB');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('Prepared prompt artifact must be private (chmod 600)');
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Prepared prompt artifact is not valid JSON');
  }
  return parsePreparedPromptArtifact(value);
}

export function renderLivePrompt(options: RenderLivePromptOptions, artifact?: unknown): string {
  if (artifact === undefined) {
    throw new Error(
      'Pass a canonical prepared request artifact as the second renderLivePrompt argument; no default template or fake review ID is generated'
    );
  }
  const prepared = parsePreparedPromptArtifact(artifact);
  if (
    prepared.owner.toLowerCase() !== options.owner.toLowerCase() ||
    prepared.repo.toLowerCase() !== options.repo.toLowerCase() ||
    prepared.pullNumber !== options.pullNumber ||
    prepared.headSha?.toLowerCase() !== options.headSha.toLowerCase()
  ) {
    throw new Error(
      'Prepared prompt artifact does not match the fixture repository, PR, or head SHA'
    );
  }
  return prepared.userPrompt;
}

export function parseRenderLivePromptArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      'prepared-prompt': { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return { help: true as const };
  if (!values['prepared-prompt']?.trim() || !values.output?.trim()) {
    throw new Error(
      '--prepared-prompt and --output are required; prompts are never printed to stdout'
    );
  }
  return { help: false as const, preparedPrompt: values['prepared-prompt'], output: values.output };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseRenderLivePromptArgs(process.argv.slice(2));
    if (args.help) {
      console.log(
        'Usage: render-live-prompt.ts --prepared-prompt <private-request.json> --output <new-private-prompt.txt>'
      );
    } else {
      const artifact = readPreparedPromptArtifact(args.preparedPrompt);
      writeFileSync(args.output, artifact.userPrompt, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Prompt rendering failed');
    process.exitCode = 1;
  }
}
