import { describe, expect, test } from 'vitest';
import { kiloCommandCreateInputSchema } from '../contracts/kilo-commands';
import { collectImportItems, parseLocalConfigArchive, type ImportPreview } from './index';
import { buildRepresentativeImportArchive, buildStoredZip, buildZip } from './test-fixtures';
import {
  MAX_IMPORT_ENTRY_EXPANDED_BYTES,
  MAX_IMPORT_INSTRUCTION_GLOB_LENGTH,
  MAX_IMPORT_INSTRUCTION_GLOB_WILDCARDS,
  MAX_IMPORT_INSTRUCTION_GLOBS,
} from './limits';

function parseFiles(files: Record<string, string | Uint8Array>): ImportPreview {
  return parseLocalConfigArchive(buildZip(files));
}

function issueCodes(preview: ImportPreview): string[] {
  return preview.issues.map(issue => issue.code);
}

describe('parseLocalConfigArchive', () => {
  test('rejects companion collisions across case-variant skill roots', () => {
    const preview = parseFiles({
      'skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploy\n---\nDeploy.',
      'skills/deploy/x.md': 'First',
      'Skills/deploy/x.md': 'Second',
    });
    expect(preview.hasErrors).toBe(true);
    expect(preview.config.skills).toEqual([]);
    expect(preview.issues).toContainEqual(
      expect.objectContaining({
        code: 'duplicate-definition',
        category: 'skills',
        path: 'Skills/deploy/x.md',
      })
    );
  });

  test('maps a representative wrapped config with zero field loss and no errors', () => {
    const preview = parseLocalConfigArchive(buildRepresentativeImportArchive());

    expect(preview.hasErrors).toBe(false);
    expect(preview.config.agents.map(agent => agent.slug).sort()).toEqual([
      'auditor',
      'reviewer',
      'triage',
    ]);
    const reviewer = preview.config.agents.find(agent => agent.slug === 'reviewer');
    expect(reviewer).toEqual({
      slug: 'reviewer',
      name: 'reviewer',
      config: {
        description: 'Reviews pull requests',
        mode: 'subagent',
        model: 'anthropic/claude-sonnet-4',
        variant: 'high',
        temperature: 0.3,
        permission: { edit: 'deny', bash: { 'git *': 'allow' } },
        prompt: 'Review the diff carefully.',
      },
    });
    const triage = preview.config.agents.find(agent => agent.slug === 'triage');
    expect(triage?.config).toEqual({
      description: 'Triage issues',
      mode: 'subagent',
      model: 'anthropic/claude-sonnet-4',
      temperature: 0.2,
      prompt: 'You triage.',
    });

    expect(preview.config.commands.map(command => command.name).sort()).toEqual([
      'explain',
      'fix',
      'ship',
    ]);
    expect(preview.config.commands.find(command => command.name === 'fix')).toEqual({
      name: 'fix',
      description: 'Fix lint',
      template: 'Fix $ARGUMENTS',
      agent: 'reviewer',
      model: 'anthropic/claude-sonnet-4',
    });

    expect(preview.config.skills.map(skill => skill.name)).toEqual(['deploy']);
    const deploy = preview.config.skills[0];
    expect(deploy.description).toBe('Deploy services');
    expect(deploy.rawMarkdown).toContain('# Deploy');
    expect(deploy.files).toEqual({ 'scripts/run.sh': '#!/bin/sh\necho deploy' });

    expect(preview.config.instructions.map(instruction => instruction.name).sort()).toEqual([
      'agents',
      'coding-style',
    ]);
    expect(
      preview.config.instructions.find(instruction => instruction.name === 'agents')?.content
    ).toBe('Repo-wide instructions.');

    // The local-only `mcp` section is ignored without an issue.
    expect(preview.issues).toEqual([]);
  });

  test('accepts agent/ and agents/, command/ and commands/, and a bare unwrapped root', () => {
    const preview = parseFiles({
      'agent/nested-dir-agent.md': 'A',
      'agents/plural-agent.md': 'A',
      'command/one.md': 'One',
      'commands/two.md': 'Two',
    });
    expect(preview.config.agents.map(agent => agent.slug).sort()).toEqual([
      'nested-dir-agent',
      'plural-agent',
    ]);
    expect(preview.config.commands.map(command => command.name).sort()).toEqual(['one', 'two']);
  });

  test('preserves the freeform agent options bag', () => {
    const preview = parseFiles({
      'agent/options.md': [
        '---',
        'description: Options',
        'options:',
        '  custom_key: custom_value',
        '  nested:',
        '    enabled: true',
        '---',
        'Body',
      ].join('\n'),
    });
    expect(preview.config.agents[0]?.config.options).toEqual({
      custom_key: 'custom_value',
      nested: { enabled: true },
    });
  });

  test('ignores local settings for CLI built-in agents without an issue', () => {
    const preview = parseFiles({
      'agent/code.md': 'Code.',
      'kilo.jsonc': JSON.stringify({
        agent: {
          plan: { disable: true },
          ask: { disable: true },
          explore: { model: 'kilo/deepseek/deepseek-v4.1-flash', variant: 'low' },
          compaction: { model: 'kilo/deepseek/deepseek-v4.1-flash' },
          reviewer: { prompt: 'Review.' },
        },
      }),
    });
    expect(preview.issues).toEqual([]);
    expect(preview.config.agents.map(agent => agent.slug)).toEqual(['reviewer']);
  });

  test('rejects a variant without a model', () => {
    const preview = parseFiles({ 'agent/variant-only.md': '---\nvariant: high\n---\nBody' });
    const issue = preview.issues.find(candidate => candidate.code === 'agent-config-invalid');
    expect(issue?.field).toBe('config.variant');
    expect(preview.config.agents).toEqual([]);
  });

  test('rejects bad slug characters and over-long names', () => {
    const badSlug = parseFiles({ 'agent/Bad_Slug.md': 'Body' });
    expect(badSlug.issues.some(issue => issue.code === 'agent-slug-invalid')).toBe(true);
    expect(badSlug.config.agents).toEqual([]);

    const longName = parseFiles({ [`agent/${'a'.repeat(101)}.md`]: 'Body' });
    expect(longName.issues.some(issue => issue.code === 'agent-name-invalid')).toBe(true);
    expect(longName.config.agents).toEqual([]);
  });

  test('offers more definitions than a profile holds so the user can select a subset', () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 21; index += 1) files[`agent/agent-${index}.md`] = 'Body';
    for (let index = 0; index < 51; index += 1) files[`skills/skill-${index}/SKILL.md`] = '# S';
    const preview = parseFiles(files);
    expect(preview.issues).toEqual([]);
    expect(preview.config.agents.length).toBe(21);
    expect(preview.config.skills.length).toBe(51);
  });

  test('rejects an oversized skill companion', () => {
    const preview = parseFiles({
      'skills/big/SKILL.md': '# Big',
      'skills/big/huge.md': 'c'.repeat(100_001),
    });
    const issue = preview.issues.find(candidate => candidate.code === 'skill-files-invalid');
    expect(issue?.field).toBe('files');
    expect(issue?.message).toContain('exceeds');
    expect(preview.config.skills).toEqual([]);
  });

  test('reports a skill bundle without a SKILL.md manifest', () => {
    const preview = parseFiles({ 'skills/orphan/readme.md': 'Body' });
    expect(preview.issues.some(issue => issue.code === 'missing-skill-manifest')).toBe(true);
    expect(preview.config.skills).toEqual([]);
  });

  test('rejects an instruction that would shadow cloud-agent.md', () => {
    const preview = parseFiles({ 'instructions/cloud-agent.md': 'Body' });
    const issue = preview.issues.find(candidate => candidate.code === 'instruction-invalid');
    expect(issue?.field).toBe('name');
    expect(issue?.message).toContain('Cloud-Agent');
    expect(preview.config.instructions).toEqual([]);
  });

  test('slugifies nested instruction paths into a safe rules filename', () => {
    const preview = parseFiles({ 'instructions/team/style.md': 'Body' });
    expect(preview.config.instructions).toEqual([{ name: 'team-style', content: 'Body' }]);
  });

  test('rejects duplicate definitions with both sources named', () => {
    const preview = parseFiles({
      'agent/dupe.md': 'One',
      'agents/dupe.md': 'Two',
    });
    const issue = preview.issues.find(candidate => candidate.code === 'duplicate-definition');
    expect(issue?.message).toContain('agent/dupe.md');
    expect(issue?.message).toContain('agents/dupe.md');
    expect(preview.config.agents).toEqual([]);
  });

  test('rejects a markdown/kilo.json collision with both sources named', () => {
    const preview = parseFiles({
      'agent/triage.md': 'One',
      'kilo.json': JSON.stringify({ agent: { triage: { prompt: 'Two' } } }),
    });
    const issue = preview.issues.find(candidate => candidate.code === 'duplicate-definition');
    expect(issue?.message).toContain('agent/triage.md');
    expect(issue?.message).toContain('kilo.json#agent.triage');
    expect(preview.config.agents).toEqual([]);
  });

  test('excludes both definitions when the first one is invalid', () => {
    const preview = parseFiles({
      'agent/triage.md': '---\ndescription: "a\\"b"\n---\nOne',
      'kilo.json': JSON.stringify({ agent: { triage: { prompt: 'Two' } } }),
    });
    expect(issueCodes(preview).sort()).toEqual(['duplicate-definition', 'invalid-frontmatter']);
    expect(preview.config.agents).toEqual([]);
  });

  test('rejects two config files as ambiguous', () => {
    const preview = parseFiles({ 'kilo.json': '{}', 'kilo.jsonc': '{}' });
    expect(preview.issues.some(issue => issue.code === 'duplicate-config-file')).toBe(true);
  });

  test('ignores local-only kilo.json sections without an issue', () => {
    const preview = parseFiles({
      'kilo.json': JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        provider: { x: {} },
        remote_control: true,
        agent: { reviewer: { prompt: 'Review.' } },
      }),
    });
    expect(preview.issues).toEqual([]);
    expect(preview.config.agents.map(agent => agent.slug)).toEqual(['reviewer']);
  });

  test('reports malformed kilo.json but still imports markdown definitions', () => {
    const preview = parseFiles({ 'kilo.json': '{ "agent": ', 'agent/reviewer.md': 'Review.' });
    expect(preview.issues.some(issue => issue.code === 'invalid-config-json')).toBe(true);
    expect(preview.config.agents.map(agent => agent.slug)).toEqual(['reviewer']);
    expect(preview.hasErrors).toBe(true);
  });

  test('ignores remote instruction URLs and globs that match no files', () => {
    const preview = parseFiles({
      'kilo.json': JSON.stringify({
        instructions: ['https://example.com/INSTRUCTIONS.md', 'docs/*.md'],
      }),
      'agent/reviewer.md': 'Review.',
    });
    expect(preview.issues).toEqual([]);
    expect(preview.config.instructions).toEqual([]);
  });

  test('resolves global config instruction globs against the archive root', () => {
    const preview = parseFiles({
      'kilo-config/kilo.jsonc': JSON.stringify({ instructions: ['~/.config/kilo/rules/*.md'] }),
      'kilo-config/rules/style.md': 'Style body',
    });
    expect(preview.issues).toEqual([]);
    expect(preview.config.instructions).toEqual([{ name: 'rules-style', content: 'Style body' }]);
  });

  test('ignores unreadable files outside the importable layout', () => {
    const preview = parseFiles({
      'kilo-config/agent/reviewer.md': 'Review.',
      'kilo-config/bin/tool': new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
      'kilo-config/agent/notes.txt': 'Not an agent',
    });
    expect(preview.issues).toEqual([]);
    expect(preview.config.agents.map(agent => agent.slug)).toEqual(['reviewer']);
  });

  test.each([
    'agent/notes.txt',
    'agents/sub/x.md',
    'command/notes.txt',
    'commands/sub/x.md',
    'instructions/notes.txt',
    'skills/README.md',
    'rules/notes.txt',
  ])('ignores unreadable and oversized ignored files at %s', path => {
    for (const content of [
      new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
      'x'.repeat(MAX_IMPORT_ENTRY_EXPANDED_BYTES + 1),
    ]) {
      const preview = parseFiles({
        'kilo.json': JSON.stringify({ instructions: ['rules/*'] }),
        'agent/reviewer.md': 'Review.',
        [path]: content,
      });
      expect(preview.issues).toEqual([]);
      expect(preview.hasErrors).toBe(false);
      expect(preview.config.agents.map(agent => agent.slug)).toEqual(['reviewer']);
    }
  });

  test.each([
    'Agent/reviewer.MD',
    'agents/reviewer.md',
    'Command/review.MD',
    'commands/review.md',
    'Instructions/nested/style.MD',
    'rules/style.md',
  ])('reports unreadable and oversized imported files at %s', path => {
    for (const [content, code] of [
      [new Uint8Array([0xff, 0xfe, 0x00, 0x01]), 'unreadable-entry'],
      ['x'.repeat(MAX_IMPORT_ENTRY_EXPANDED_BYTES + 1), 'entry-too-large'],
    ] as const) {
      const preview = parseFiles({
        'kilo.json': JSON.stringify({ instructions: ['rules/*'] }),
        [path]: content,
      });
      expect(preview.issues).toContainEqual(expect.objectContaining({ code, path }));
    }
  });

  test('reports a skill whose only file is unreadable', () => {
    const preview = parseFiles({
      'skills/deploy/SKILL.md': new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
    });
    expect(preview.config.skills).toEqual([]);
    expect(preview.issues).toEqual([
      expect.objectContaining({ code: 'skill-files-invalid', path: 'skills/deploy/SKILL.md' }),
    ]);
  });

  test('excludes a skill whose bundle has an unreadable file', () => {
    const preview = parseFiles({
      'skills/deploy/SKILL.md': '---\nname: deploy\n---\nDeploy.',
      'skills/deploy/logo.png': new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
      'skills/lint/SKILL.md': '---\nname: lint\n---\nLint.',
    });
    expect(preview.config.skills.map(skill => skill.name)).toEqual(['lint']);
    expect(preview.issues).toEqual([
      expect.objectContaining({
        code: 'skill-files-invalid',
        category: 'skills',
        path: 'skills/deploy/logo.png',
      }),
    ]);
  });

  test('surfaces repeated ZIP member paths as an archive error', () => {
    const zip = buildStoredZip([
      { path: 'agent/reviewer.md', content: 'One' },
      { path: 'agent/reviewer.md', content: 'Two' },
    ]);
    const preview = parseLocalConfigArchive(zip);
    expect(preview.issues.map(issue => issue.code)).toEqual(['duplicate-entry']);
    expect(preview.hasErrors).toBe(true);
    expect(preview.config.agents).toEqual([]);
  });

  test('rejects unmappable frontmatter with an explicit issue', () => {
    const preview = parseFiles({ 'agent/list.md': '---\ntools:\n  - read\n---\nBody' });
    expect(preview.issues.some(issue => issue.code === 'invalid-frontmatter')).toBe(true);
    expect(preview.config.agents).toEqual([]);
  });

  test('imports an agent without its unmapped frontmatter fields', () => {
    const preview = parseFiles({ 'agent/extra.md': '---\nunknown_field: value\n---\nBody' });
    expect(preview.issues).toEqual([]);
    expect(preview.config.agents).toEqual([
      { slug: 'extra', name: 'extra', config: { prompt: 'Body' } },
    ]);
  });

  test('rejects a kilo command model over the runtime cap even though storage accepts it', () => {
    const overLongModel = 'a'.repeat(201);
    expect(
      kiloCommandCreateInputSchema.safeParse({
        name: 'long-model',
        template: 'Template',
        model: overLongModel,
      }).success
    ).toBe(true);

    const preview = parseFiles({
      'kilo.json': JSON.stringify({
        command: { 'long-model': { template: 'Template', model: overLongModel } },
      }),
    });
    const issue = preview.issues.find(candidate => candidate.code === 'command-field-invalid');
    expect(issue?.field).toBe('model');
    expect(preview.config.commands).toEqual([]);
  });

  test('rejects a kilo command agent over the runtime cap', () => {
    const preview = parseFiles({
      'command/agent-cap.md': `---\nagent: ${'a'.repeat(51)}\n---\nBody`,
    });
    const issue = preview.issues.find(candidate => candidate.code === 'command-field-invalid');
    expect(issue?.field).toBe('agent');
    expect(preview.config.commands).toEqual([]);
  });

  test('rejects a built-in command name', () => {
    const preview = parseFiles({ 'command/init.md': 'Boot the project' });
    const issue = preview.issues.find(candidate => candidate.code === 'command-name-invalid');
    expect(issue?.field).toBe('name');
    expect(issue?.message).toContain('built-in');
    expect(preview.config.commands).toEqual([]);
  });

  test('warns when an archive contains no supported definitions', () => {
    const preview = parseFiles({ 'src/index.ts': 'export {}' });
    expect(preview.issues.map(issue => issue.code)).toEqual(['empty-import']);
    expect(preview.hasErrors).toBe(false);
  });

  test('rejects duplicate JSONC properties before object conversion', () => {
    const preview = parseFiles({
      'kilo.json': '{"agent":{"reviewer":{"prompt":"A"},"reviewer":{"prompt":"B"}}}',
    });
    const issue = preview.issues.find(candidate => candidate.code === 'duplicate-definition');
    expect(issue?.message).toContain('agent.reviewer');
    expect(preview.config.agents).toEqual([]);
    expect(preview.hasErrors).toBe(true);
  });

  test('rejects a repeated top-level JSONC section', () => {
    const preview = parseFiles({
      'kilo.json': '{"agent":{"a":{"prompt":"A"}},"agent":{"b":{"prompt":"B"}}}',
    });
    const issue = preview.issues.find(candidate => candidate.code === 'duplicate-definition');
    expect(issue?.message).toContain('Duplicate property "agent"');
    expect(preview.config.agents).toEqual([]);
    expect(preview.hasErrors).toBe(true);
  });

  test('reports malformed config sections instead of silently skipping them', () => {
    const preview = parseFiles({
      'kilo.json': JSON.stringify({ agent: [], command: 'bad', instructions: 42 }),
    });
    const malformed = preview.issues.filter(issue => issue.code === 'invalid-config-section');
    expect(malformed.map(issue => issue.field).sort()).toEqual([
      'agent',
      'command',
      'instructions',
    ]);
    expect(preview.hasErrors).toBe(true);
    expect(preview.config).toEqual({ agents: [], commands: [], skills: [], instructions: [] });
  });

  test('takes a command template from the body and ignores a frontmatter template', () => {
    const preview = parseFiles({ 'command/conflict.md': '---\ntemplate: First\n---\nSecond' });
    expect(preview.issues).toEqual([]);
    expect(preview.config.commands).toEqual([{ name: 'conflict', template: 'Second' }]);
  });

  test('rejects a skill with multiple manifests instead of keeping the last', () => {
    const preview = parseFiles({
      'skills/deploy/SKILL.md': '# Deploy',
      'skills/deploy/skill.md': '# Deploy again',
    });
    const issue = preview.issues.find(candidate => candidate.code === 'duplicate-definition');
    expect(issue?.message).toContain('skills/deploy/SKILL.md');
    expect(issue?.message).toContain('skills/deploy/skill.md');
    expect(preview.config.skills).toEqual([]);
    expect(preview.hasErrors).toBe(true);
  });

  test('rejects case variants of the skills directory that merge into one bundle', () => {
    const preview = parseFiles({
      'skills/deploy/SKILL.md': '# Deploy',
      'Skills/deploy/SKILL.md': '# Deploy',
    });
    expect(preview.issues.some(issue => issue.code === 'duplicate-definition')).toBe(true);
    expect(preview.config.skills).toEqual([]);
  });

  test('imports an instruction file also matched by a kilo.json glob without a false duplicate', () => {
    const preview = parseFiles({
      'kilo.json': JSON.stringify({ instructions: ['instructions/*.md'] }),
      'instructions/style.md': 'Body',
    });
    expect(issueCodes(preview)).not.toContain('duplicate-definition');
    expect(preview.hasErrors).toBe(false);
    expect(preview.config.instructions).toEqual([{ name: 'style', content: 'Body' }]);
  });

  test('rejects two distinct instruction sources that normalize to one name', () => {
    const preview = parseFiles({
      'kilo.json': JSON.stringify({ instructions: ['*.md'] }),
      'instructions/style.md': 'Directory body',
      'style.md': 'Root body',
    });
    const issue = preview.issues.find(candidate => candidate.code === 'duplicate-definition');
    expect(issue?.message).toContain('instructions/style.md');
    expect(issue?.message).toContain('style.md');
    expect(preview.config.instructions).toEqual([]);
  });

  test('preserves a single-quoted permission key through the mapper', () => {
    const preview = parseFiles({
      'agent/perms.md': ['---', 'permission:', "  'git *': deny", '---', 'Body'].join('\n'),
    });
    expect(preview.config.agents[0]?.config.permission).toEqual({ 'git *': 'deny' });
  });

  test('reports escaped frontmatter strings as invalid instead of altering them', () => {
    const preview = parseFiles({ 'agent/escaped.md': '---\ndescription: "a\\"b"\n---\nBody' });
    expect(preview.issues.some(issue => issue.code === 'invalid-frontmatter')).toBe(true);
    expect(preview.config.agents).toEqual([]);
  });

  test('strips inline frontmatter comments before mapping', () => {
    const preview = parseFiles({
      'agent/commented.md': '---\ndescription: Reviews code # note\n---\nBody',
    });
    expect(preview.config.agents[0]?.config.description).toBe('Reviews code');
  });

  test('reports an inline collection in options as invalid frontmatter', () => {
    const preview = parseFiles({ 'agent/flow.md': '---\noptions: { custom: value }\n---\nBody' });
    expect(preview.issues.some(issue => issue.code === 'invalid-frontmatter')).toBe(true);
    expect(preview.config.agents).toEqual([]);
  });

  test('rejects YAML anchors, aliases, and tags instead of importing altered fields', () => {
    for (const [path, body] of [
      ['agent/anchored.md', '---\nmodel: &default sonnet\n---\nBody'],
      ['agent/aliased.md', '---\nmodel: *default\n---\nBody'],
      ['agent/tagged.md', '---\nmodel: !!str sonnet\n---\nBody'],
    ] as const) {
      const preview = parseFiles({ [path]: body });
      expect(preview.issues.some(issue => issue.code === 'invalid-frontmatter')).toBe(true);
      expect(preview.config.agents).toEqual([]);
    }
  });

  test('collects category-tagged import items for previewing', () => {
    const preview = parseLocalConfigArchive(buildRepresentativeImportArchive());
    const items = collectImportItems(preview.config);
    expect(items.map(item => item.category).sort()).toEqual([
      'agents',
      'agents',
      'agents',
      'commands',
      'commands',
      'commands',
      'instructions',
      'instructions',
      'skills',
    ]);
  });
});

describe('instruction glob import limits', () => {
  test('drops an over-long glob and keeps the other globs', () => {
    const longGlob = `${'a'.repeat(MAX_IMPORT_INSTRUCTION_GLOB_LENGTH)}.md`;
    const preview = parseFiles({
      'kilo.json': JSON.stringify({ instructions: [longGlob, 'rules/*.md'] }),
      'rules/style.md': 'Body',
    });

    expect(preview.issues).toContainEqual(
      expect.objectContaining({
        code: 'instruction-glob-limit',
        category: 'config',
        path: 'kilo.json',
        field: 'instructions.0',
      })
    );
    expect(preview.hasErrors).toBe(true);
    expect(preview.config.instructions).toEqual([{ name: 'rules-style', content: 'Body' }]);
  });

  test('drops a glob with too many star tokens and keeps the other globs', () => {
    const starryGlob = `${'**/'.repeat(MAX_IMPORT_INSTRUCTION_GLOB_WILDCARDS + 1)}AGENTS.md`;
    const preview = parseFiles({
      'kilo.json': JSON.stringify({ instructions: [starryGlob, 'docs/*.md'] }),
      'docs/style.md': 'Body',
    });

    expect(preview.issues).toContainEqual(
      expect.objectContaining({ code: 'instruction-glob-limit', field: 'instructions.0' })
    );
    expect(preview.config.instructions).toEqual([{ name: 'docs-style', content: 'Body' }]);
  });

  test('does not echo an over-long glob in full into the issue message', () => {
    const longGlob = `rules/${'a'.repeat(4096)}.md`;
    const preview = parseFiles({ 'kilo.json': JSON.stringify({ instructions: [longGlob] }) });

    const issue = preview.issues.find(candidate => candidate.code === 'instruction-glob-limit');
    expect(issue?.message).toContain('rules/aaaa');
    expect(issue?.message).not.toContain('a'.repeat(200));
    expect(issue?.message.length).toBeLessThan(300);
  });

  test('reads at most the allowed number of instruction globs', () => {
    const globs = Array.from({ length: MAX_IMPORT_INSTRUCTION_GLOBS + 3 }, () => 'AGENTS.md');
    const preview = parseFiles({
      'kilo.json': JSON.stringify({ instructions: globs }),
      'AGENTS.md': 'Body',
    });

    expect(issueCodes(preview)).toContain('instruction-globs-exceeded');
    expect(preview.config.instructions).toEqual([{ name: 'agents', content: 'Body' }]);
  });

  test('applies instruction globs within the import limit', () => {
    const glob = `${'*a'.repeat(15)}*.md`;
    const files: Record<string, string> = {
      'kilo.json': JSON.stringify({ instructions: Array.from({ length: 8 }, () => glob) }),
    };
    for (let index = 0; index < 3; index += 1) {
      files[`${'a'.repeat(80)}p${index}.md`] = 'Body';
    }

    const preview = parseFiles(files);
    expect(preview.issues).toEqual([]);
    expect(preview.config.instructions).toHaveLength(3);
  });

  test('skips instruction globs when the archive is over the import limit', () => {
    const glob = `${'*a'.repeat(15)}*.md`;
    const files: Record<string, string> = {
      'kilo.json': JSON.stringify({ instructions: Array.from({ length: 32 }, () => glob) }),
      'instructions/style.md': 'Directory body',
    };
    for (let index = 0; index < 12; index += 1) {
      files[`${'a'.repeat(5000)}p${index}.md`] = 'Body';
    }

    const preview = parseFiles(files);
    expect(preview.issues).toContainEqual(
      expect.objectContaining({ code: 'instruction-globs-exceeded', field: 'instructions' })
    );
    expect(preview.config.instructions).toEqual([{ name: 'style', content: 'Directory body' }]);
  });

  test('parses an archive whose instruction glob spans many directories', () => {
    const deepPath = Array.from({ length: 40 }, (_, index) => `d${index}`).join('/');
    const glob = `${'**/'.repeat(12)}NEVER-EXIST.md`;
    const started = performance.now();
    const preview = parseFiles({
      'kilo.json': JSON.stringify({ instructions: [glob] }),
      [`${deepPath}/other.md`]: 'Body',
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(preview.config.instructions).toEqual([]);
  });
});
