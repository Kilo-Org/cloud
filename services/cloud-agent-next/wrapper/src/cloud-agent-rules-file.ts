import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildCloudAgentRules,
  type CloudAgentRulesInput,
} from '../../src/shared/cloud-agent-rules.js';

/** V1 discovers this directory; V2 receives it through configured instructions. */
export function cloudAgentRulesFilePath(home: string): string {
  return path.join(home, '.kilocode', 'rules', 'cloud-agent.md');
}

export async function writeCloudAgentRulesFile(
  home: string,
  input: CloudAgentRulesInput
): Promise<void> {
  const file = cloudAgentRulesFilePath(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buildCloudAgentRules(input));
}
