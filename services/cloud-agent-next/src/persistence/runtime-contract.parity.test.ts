import { describe, expect, it } from 'vitest';
import {
  RuntimeAgentSchema,
  RuntimeAgentsSchema,
  RuntimeKiloCommandSchema,
  RuntimeKiloCommandsSchema,
  RuntimeInstructionSchema,
  RuntimeInstructionsSchema,
  RuntimeSkillSchema,
  RuntimeSkillsSchema,
} from './schemas.js';
import {
  RuntimeAgentContractSchema,
  RuntimeAgentsContractSchema,
  RuntimeKiloCommandContractSchema,
  RuntimeKiloCommandsContractSchema,
  RuntimeSkillContractSchema,
  RuntimeSkillsContractSchema,
  parseLocalConfigArchive,
  instructionImportSchema,
  MAX_IMPORT_INSTRUCTIONS,
} from '@kilocode/cloud-agent-profile/import';
import { buildRepresentativeImportArchive } from '@kilocode/cloud-agent-profile/import/testing';

type ProbeSchema = { safeParse: (value: unknown) => { success: boolean } };

/**
 * The import mapper validates against a mirror of these runtime schemas
 * because the web package cannot import this service. This test is the parity
 * proof: every probe must be accepted or rejected identically by the mirror
 * and by the authoritative runtime schema.
 */
function expectParity(mirror: ProbeSchema, authoritative: ProbeSchema, probes: unknown[]): void {
  for (const probe of probes) {
    const mirrorAccepted = mirror.safeParse(probe).success;
    const authoritativeAccepted = authoritative.safeParse(probe).success;
    expect(mirrorAccepted, `mirror/runtime disagree for ${JSON.stringify(probe)}`).toBe(
      authoritativeAccepted
    );
  }
}

function agent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'reviewer',
    name: 'Reviewer',
    config: { description: 'Reviews code', model: 'anthropic/claude-sonnet-4', prompt: 'Review.' },
    ...overrides,
  };
}

function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'explain', template: 'Explain $ARGUMENTS', ...overrides };
}

function skill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'deploy', rawMarkdown: '# Deploy', ...overrides };
}

function fileMap(count: number, content = 'x'): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`file-${index}.md`, content])
  );
}

describe('runtime contract mirror parity', () => {
  it('matches RuntimeAgentSchema across boundary probes', () => {
    const probes: unknown[] = [
      agent(),
      agent({ slug: 'code' }),
      agent({ slug: 'architect' }),
      agent({ slug: 'a'.repeat(50) }),
      agent({ slug: 'a'.repeat(51) }),
      agent({ slug: 'Reviewer' }),
      agent({ slug: 'reviewer-1' }),
      agent({ slug: '1reviewer' }),
      agent({ name: '' }),
      agent({ name: 'n'.repeat(100) }),
      agent({ name: 'n'.repeat(101) }),
      agent({ config: {} }),
      agent({ config: { prompt: 'p'.repeat(50_000) } }),
      agent({ config: { prompt: 'p'.repeat(50_001) } }),
      agent({ config: { description: 'd'.repeat(2_000) } }),
      agent({ config: { description: 'd'.repeat(2_001) } }),
      agent({ config: { model: 'm'.repeat(200) } }),
      agent({ config: { model: 'm'.repeat(201) } }),
      agent({ config: { model: null } }),
      agent({ config: { variant: 'high' } }),
      agent({ config: { variant: 'high', model: 'anthropic/claude-sonnet-4' } }),
      agent({ config: { variant: 'high', model: '' } }),
      agent({ config: { mode: 'primary' } }),
      agent({ config: { mode: 'unknown' } }),
      agent({ config: { steps: 1 } }),
      agent({ config: { steps: 0 } }),
      agent({ config: { steps: 1.5 } }),
      agent({ config: { temperature: 0.2 } }),
      agent({ config: { top_p: 0.9 } }),
      agent({ config: { hidden: true, disable: false } }),
      agent({ config: { color: '#aabbcc' } }),
      agent({ config: { permission: 'allow' } }),
      agent({ config: { permission: { edit: 'deny', bash: { 'git *': 'allow' } } } }),
      agent({ config: { permission: { edit: null } } }),
      agent({ config: { options: { foo: 'bar' } } }),
      agent({ config: { extra: 'field' } }),
      agent({ config: { timeout: undefined } }),
      { ...agent(), extra: 'field' },
      null,
      'not-an-object',
    ];
    expectParity(RuntimeAgentContractSchema, RuntimeAgentSchema, probes);
  });

  it('matches RuntimeKiloCommandSchema across boundary probes', () => {
    const probes: unknown[] = [
      command(),
      command({ name: 'init' }),
      command({ name: 'a'.repeat(50) }),
      command({ name: 'a'.repeat(51) }),
      command({ name: 'a'.repeat(100) }),
      command({ name: 'a'.repeat(101) }),
      command({ name: 'Explained' }),
      command({ template: '' }),
      command({ template: 't'.repeat(100_000) }),
      command({ template: 't'.repeat(100_001) }),
      command({ description: 'd'.repeat(2_000) }),
      command({ description: 'd'.repeat(2_001) }),
      command({ description: null }),
      command({ agent: 'a'.repeat(50) }),
      command({ agent: 'a'.repeat(51) }),
      command({ agent: null }),
      command({ model: 'm'.repeat(200) }),
      command({ model: 'm'.repeat(201) }),
      command({ model: null }),
      command({ subtask: false }),
      command({ subtask: 'yes' }),
      { ...command(), description: undefined },
      null,
      42,
    ];
    expectParity(RuntimeKiloCommandContractSchema, RuntimeKiloCommandSchema, probes);
  });

  it('matches RuntimeSkillSchema across boundary probes', () => {
    const probes: unknown[] = [
      skill(),
      skill({ name: 'a'.repeat(100) }),
      skill({ name: 'a'.repeat(101) }),
      skill({ name: 'Deploy' }),
      skill({ name: '1-deploy' }),
      skill({ rawMarkdown: '' }),
      skill({ rawMarkdown: 'm'.repeat(100_000) }),
      skill({ rawMarkdown: 'm'.repeat(100_001) }),
      skill({ files: {} }),
      skill({ files: fileMap(40) }),
      skill({ files: fileMap(41) }),
      skill({ files: { ['p'.repeat(200)]: 'x' } }),
      skill({ files: { ['p'.repeat(201)]: 'x' } }),
      skill({ files: { 'nested/dir/file.md': 'x' } }),
      skill({ files: { 'bad path.md': 'x' } }),
      skill({ files: { '/absolute.md': 'x' } }),
      skill({ files: { 'a/../b.md': 'x' } }),
      skill({ files: { 'SKILL.md': 'x' } }),
      skill({ files: { 'skill.md': 'x' } }),
      skill({ files: { 'big.md': 'c'.repeat(100_000) } }),
      skill({ files: { 'big.md': 'c'.repeat(100_001) } }),
      skill({
        files: {
          'a.md': 'c'.repeat(100_000),
          'b.md': 'c'.repeat(100_000),
          'c.md': 'c'.repeat(100_000),
          'd.md': 'c'.repeat(100_000),
          'e.md': 'c'.repeat(100_000),
          'f.md': 'c'.repeat(100_000),
        },
      }),
      null,
      [],
    ];
    expectParity(RuntimeSkillContractSchema, RuntimeSkillSchema, probes);
  });

  it('matches RuntimeInstructionSchema and its array cap across boundary probes', () => {
    const instruction = { name: 'repo-rules', content: 'Follow the rules.' };
    expectParity(instructionImportSchema, RuntimeInstructionSchema, [
      instruction,
      { ...instruction, name: '' },
      { ...instruction, name: 'cloud-agent' },
      { ...instruction, name: '../escape' },
      { ...instruction, name: 'Rules' },
      { ...instruction, name: 'a'.repeat(100) },
      { ...instruction, name: 'a'.repeat(101) },
      { ...instruction, content: '' },
      { ...instruction, content: 'x'.repeat(100_000) },
      { ...instruction, content: 'x'.repeat(100_001) },
      null,
    ]);
    expect(
      RuntimeInstructionsSchema.safeParse(Array(MAX_IMPORT_INSTRUCTIONS).fill(instruction)).success
    ).toBe(true);
    expect(
      RuntimeInstructionsSchema.safeParse(Array(MAX_IMPORT_INSTRUCTIONS + 1).fill(instruction))
        .success
    ).toBe(false);
  });

  it('matches the array caps for agents, commands, and skills', () => {
    const agents = Array.from({ length: 21 }, (_, index) => agent({ slug: `agent-${index}` }));
    const commands = Array.from({ length: 51 }, (_, index) =>
      command({ name: `command-${index}` })
    );
    const skills = Array.from({ length: 51 }, (_, index) => skill({ name: `skill-${index}` }));

    expectParity(RuntimeAgentsContractSchema, RuntimeAgentsSchema, [agents.slice(0, 20), agents]);
    expectParity(RuntimeKiloCommandsContractSchema, RuntimeKiloCommandsSchema, [
      commands.slice(0, 50),
      commands,
    ]);
    expectParity(RuntimeSkillsContractSchema, RuntimeSkillsSchema, [skills.slice(0, 50), skills]);
  });

  it('accepts the mapper output for a representative local config', () => {
    const preview = parseLocalConfigArchive(buildRepresentativeImportArchive());
    expect(preview.hasErrors).toBe(false);
    const { agents, commands, skills, instructions } = preview.config;
    expect(agents.length).toBeGreaterThan(0);
    expect(commands.length).toBeGreaterThan(0);
    expect(skills.length).toBeGreaterThan(0);
    expect(instructions.length).toBeGreaterThan(0);

    for (const agent of agents) {
      expect(RuntimeAgentSchema.safeParse(agent).success, JSON.stringify(agent)).toBe(true);
    }
    for (const command of commands) {
      expect(RuntimeKiloCommandSchema.safeParse(command).success, JSON.stringify(command)).toBe(
        true
      );
    }
    for (const skill of skills) {
      expect(RuntimeSkillSchema.safeParse(skill).success, JSON.stringify(skill)).toBe(true);
    }
    for (const instruction of instructions) {
      expect(RuntimeInstructionSchema.safeParse(instruction).success).toBe(true);
    }
    expect(RuntimeInstructionsSchema.safeParse(instructions).success).toBe(true);
    expect(RuntimeAgentsSchema.safeParse(agents).success).toBe(true);
    expect(RuntimeKiloCommandsSchema.safeParse(commands).success).toBe(true);
    expect(RuntimeSkillsSchema.safeParse(skills).success).toBe(true);
  });
});
