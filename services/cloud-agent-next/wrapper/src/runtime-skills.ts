import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isSafeSkillFilePath,
  RuntimeSkillsSchema,
  type RuntimeSkillInput,
} from '../../src/shared/runtime-profile.js';

/** Write validated skills under a session-owned home. */
export async function writeRuntimeSkills(
  home: string,
  skills: readonly RuntimeSkillInput[] = []
): Promise<void> {
  if (!skills.length) return;
  // Legacy session/ready payloads can contain unsafe companion paths. Preserve
  // their skip behavior; the control-plane request schema rejects these earlier.
  const validated = RuntimeSkillsSchema.parse(
    skills.map(skill => ({
      ...skill,
      ...(skill.files === undefined
        ? {}
        : {
            files: Object.fromEntries(
              Object.entries(skill.files).filter(([name]) => isSafeSkillFilePath(name))
            ),
          }),
    }))
  );
  const baseDir = path.join(home, '.kilocode', 'skills');

  for (const skill of validated) {
    const skillDir = path.join(baseDir, skill.name);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), skill.rawMarkdown);
    for (const [relativePath, content] of Object.entries(skill.files ?? {})) {
      const targetPath = path.join(skillDir, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content);
    }
  }
}
