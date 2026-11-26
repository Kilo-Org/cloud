import { classifySystemPrompt } from '@kilocode/web-shared/lib/ai-gateway/system-prompt-kind';

// Openings and phrases quoted from each client's published prompt source.
const prompts = {
  kiloCli:
    'You are Kilo, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.\n\n# Personality\n',
  kiloLegacy:
    'You are Kilo Code, an experienced technical leader who is inquisitive and an excellent planner.\n\n====\n\nMARKDOWN RULES',
  kiloWithOpencodePrompt:
    'You are Kilo, a highly skilled software engineer.\nYou are opencode, an interactive CLI tool that helps users with software engineering tasks.',
  opencode:
    'You are OpenCode, the best coding agent on the planet.\n\nYou are an interactive CLI tool that helps users with software engineering tasks.',
  opencodeHarness:
    'You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.',
  opencodeWithClaudeIdentity:
    "You are Claude Code, Anthropic's official CLI for Claude.\nYou are OpenCode, the best coding agent on the planet.",
  cline:
    'You are Cline, a highly skilled software engineer with extensive knowledge in many programming languages.\n\n====\n\nACT MODE V.S. PLAN MODE',
  claudeCode:
    "x-anthropic-billing-header: cc_version=2.1.295.abc; cc_entrypoint=cli;\nYou are Claude Code, Anthropic's official CLI for Claude.\nYou are an agent working with the user toward their goals.",
  claudeAgentSdk: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  codex:
    'You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI.',
  codexGpt6:
    'You are Codex, an agent based on GPT-6. You and the user share one workspace, and your job is to collaborate with them.',
  pi: 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files.',
  omp: 'You are omp’s trusted coding assistant.\n\n# Engineering\n- Correctness, then six-month maintainability.',
  ompFeb2026:
    'You are a distinguished staff engineer operating inside Oh My Pi, a Pi-based coding harness.\n\nHigh-agency.',
  hermes:
    'You are Hermes Agent, built by Nous Research. Be direct: match the length of your reply to the weight of the ask.',
  openclaw: 'You are a personal assistant running inside OpenClaw.\n## Tooling\n',
  strix:
    'You are an advanced AI application security validation agent. Your purpose is to perform authorized security verification.',
  deepseekHarness:
    'You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding assistant powered by the deepseek-v4-flash model.',
  commandCodePlan:
    '<role>\n<mode>PLAN MODE ACTIVE</mode>\n\n<identity>You are Command Code, a coding agent acting as a Software Architect.</identity>',
  commandCodeDefault:
    "<role>\nYou are a confident, efficient software engineer and coding assistant.\n</role>\n<tone_and_style>\nYou're a confident pair programmer, not a formal assistant.\n</tone_and_style>\n<taste_guidance>\nIMPORTANT - Taste System (Learned Preferences):",
};

describe('classifySystemPrompt', () => {
  it.each([
    ['kiloCli', 'kilo'],
    ['kiloLegacy', 'kilo'],
    ['kiloWithOpencodePrompt', 'kilo'],
    ['opencode', 'opencode'],
    ['opencodeHarness', 'opencode'],
    ['opencodeWithClaudeIdentity', 'opencode'],
    ['cline', 'cline'],
    ['claudeCode', 'claude_code'],
    ['claudeAgentSdk', 'claude_code'],
    ['codex', 'codex'],
    ['codexGpt6', 'codex'],
    ['pi', 'pi'],
    ['omp', 'omp'],
    ['ompFeb2026', 'omp'],
    ['hermes', 'hermes_agent'],
    ['openclaw', 'openclaw'],
    ['strix', 'strix'],
    ['deepseekHarness', 'deepseek_harness'],
    ['commandCodePlan', 'command_code'],
    ['commandCodeDefault', 'command_code'],
  ] as const)('classifies %s as %s', (name, kind) => {
    expect(classifySystemPrompt(prompts[name])).toBe(kind);
  });

  it('ignores case and whitespace differences', () => {
    expect(classifySystemPrompt('YOU ARE   KILO,\n a helpful agent')).toBe('kilo');
  });

  it.each([
    ['an empty prompt', ''],
    ['a generic prompt', 'You are a helpful assistant.'],
    ['a single weak marker', 'Follow RFC 2119 keywords when reading requirements.'],
    ['a Roo prompt', 'You are Roo, a highly skilled software engineer.'],
    [
      'two clients with equal evidence',
      'You are Cline, an AI coding agent. You are Codex, an agent.',
    ],
  ])('returns null for %s', (_name, prompt) => {
    expect(classifySystemPrompt(prompt)).toBeNull();
  });
});
