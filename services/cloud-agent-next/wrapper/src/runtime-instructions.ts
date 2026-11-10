import fs from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeInstructionInput } from '../../src/shared/runtime-profile.js';
import { logToFile } from './utils.js';

export async function writeRuntimeInstructions(
  home: string,
  instructions: readonly RuntimeInstructionInput[] | undefined,
  options: { replaceExisting?: boolean } = {}
): Promise<void> {
  if (!instructions?.length && !options.replaceExisting) return;
  const rulesDir = path.join(home, '.kilocode', 'rules');
  await fs.mkdir(rulesDir, { recursive: true });
  const retained = new Set(['cloud-agent.md']);
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
    // This directory belongs to the workspace profile. A restored HOME may
    // still contain a previously enabled rule; the glob must not load it.
    for (const filename of await fs.readdir(rulesDir)) {
      if (/^[a-z0-9][a-z0-9-]*\.md$/.test(filename) && !retained.has(filename)) {
        await fs.unlink(path.join(rulesDir, filename));
      }
    }
  }
}
