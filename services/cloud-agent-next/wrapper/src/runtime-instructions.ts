import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { RuntimeInstructionInput } from '../../src/shared/runtime-profile.js';
import { logToFile } from './utils.js';

const profileRuleFilesSchema = z.array(
  z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*\.md$/)
    .refine(filename => filename !== 'cloud-agent.md')
);

async function readProfileRuleFiles(manifest: string): Promise<string[]> {
  try {
    return profileRuleFilesSchema.parse(JSON.parse(await fs.readFile(manifest, 'utf8')));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      logToFile('bootstrap ignored invalid profile instruction manifest');
      return [];
    }
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function writeRuntimeInstructions(
  home: string,
  instructions: readonly RuntimeInstructionInput[] | undefined,
  options: { replaceExisting?: boolean } = {}
): Promise<void> {
  if (!instructions?.length && !options.replaceExisting) return;
  const rulesDir = path.join(home, '.kilocode', 'rules');
  await fs.mkdir(rulesDir, { recursive: true });
  const manifest = path.join(home, '.kilocode', 'profile-instructions.json');
  const previous = await readProfileRuleFiles(manifest);
  const retained = new Set<string>();
  for (const instruction of instructions ?? []) {
    // Backstop for callers bypassing profile validation; never replace built-in rules.
    if (instruction.name === 'cloud-agent' || !/^[a-z0-9][a-z0-9-]*$/.test(instruction.name)) {
      logToFile(`bootstrap rejected unsafe instruction name=${JSON.stringify(instruction.name)}`);
      continue;
    }
    const filename = `${instruction.name}.md`;
    await fs.writeFile(path.join(rulesDir, filename), instruction.content);
    retained.add(filename);
  }
  if (options.replaceExisting) {
    // HOME also contains setup/agent-created rules; only remove profile-owned files.
    for (const filename of previous) {
      if (retained.has(filename)) continue;
      const file = path.join(rulesDir, filename);
      try {
        if (!(await fs.lstat(file)).isFile()) {
          logToFile(`bootstrap skipped non-file stale instruction name=${filename}`);
          continue;
        }
        await fs.rm(file, { force: true });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        logToFile(`bootstrap stale instruction already removed name=${filename}`);
      }
    }
  }
  await fs.writeFile(
    manifest,
    JSON.stringify(
      options.replaceExisting ? [...retained] : [...new Set([...previous, ...retained])]
    )
  );
}
