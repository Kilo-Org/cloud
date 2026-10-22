/**
 * The skill tab's ZIP adapter must preserve the pre-migration skill-ZIP
 * contract while the shared decoder owns archive mechanics: strip the sole
 * outer directory (even one named like a config category), ignore OS metadata,
 * and reject an archive that skipped an entry instead of importing a partial
 * skill. A decoder warning must not become a silent companion-file omission.
 */
import { describe, expect, test } from '@jest/globals';
import { buildZip } from '@kilocode/cloud-agent-profile/import/testing';
import {
  extractSkillZip,
  type SkillZipFile,
} from '@/components/cloud-agent/profile-editor/skill-archive';

function zipFile(name: string, bytes: Uint8Array): SkillZipFile {
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
  };
}

describe('extractSkillZip', () => {
  test('rejects an oversized file before reading it', async () => {
    const file: SkillZipFile = {
      name: 'huge.zip',
      size: 5 * 1024 * 1024 + 1,
      arrayBuffer: async () => {
        throw new Error('must not read');
      },
    };
    await expect(extractSkillZip(file)).rejects.toThrow('Zip file is larger than 5 MB');
  });

  test('strips a sole wrapper directory named like a config category', async () => {
    const extracted = await extractSkillZip(
      zipFile(
        'deploy.zip',
        buildZip({
          'commands/SKILL.md': '---\nname: deploy\ndescription: Deploys.\n---\n# Deploy',
          'commands/scripts/run.sh': '#!/bin/sh\necho deploy',
        })
      )
    );

    expect(extracted.frontmatterName).toBe('deploy');
    expect(extracted.frontmatterDescription).toBe('Deploys.');
    expect(extracted.rawMarkdown).toContain('# Deploy');
    expect(extracted.files).toEqual({ 'scripts/run.sh': '#!/bin/sh\necho deploy' });
  });

  test('ignores AppleDouble companion entries instead of importing them', async () => {
    const extracted = await extractSkillZip(
      zipFile(
        'deploy.zip',
        buildZip({
          'deploy/SKILL.md': '---\nname: deploy\n---\n# Deploy',
          'deploy/._SKILL.md': 'junk',
          'deploy/._helper.txt': 'junk',
        })
      )
    );

    expect(extracted.fileCount).toBe(0);
    expect(extracted.files).toEqual({});
  });

  test('rejects an archive whose entry path was skipped', async () => {
    await expect(
      extractSkillZip(
        zipFile(
          'deploy.zip',
          buildZip({
            'deploy/SKILL.md': '---\nname: deploy\n---\n# Deploy',
            'deploy/../helper.txt': 'escape',
          })
        )
      )
    ).rejects.toThrow(/helper\.txt/);
  });

  test('rejects an archive with a non-text companion', async () => {
    await expect(
      extractSkillZip(
        zipFile(
          'deploy.zip',
          buildZip({
            'deploy/SKILL.md': '---\nname: deploy\n---\n# Deploy',
            'deploy/blob.bin': new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
          })
        )
      )
    ).rejects.toThrow(/not valid UTF-8/);
  });

  test('rejects an archive without a root SKILL.md', async () => {
    await expect(
      extractSkillZip(zipFile('deploy.zip', buildZip({ 'deploy/helper.txt': 'x' })))
    ).rejects.toThrow(/SKILL\.md/);
  });
});
