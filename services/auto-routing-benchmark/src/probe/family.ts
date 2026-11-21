/**
 * Which captured request template answers for a model, decided the way the pinned CLI
 * decides it: `packages/opencode/src/session/system.ts` (`provider`) picks the system prompt
 * from the catalog's `opencode.prompt`, else from the model id, and
 * `packages/opencode/src/kilocode/provider/provider.ts` picks the SDK (and so the endpoint)
 * from the catalog's `opencode.ai_sdk_provider`.
 */

/** The endpoint a HTTP probe can speak. `anthropic` uses the Messages API instead. */
export type ProbeEndpoint = 'chat' | 'responses' | 'anthropic';

export type ProbePromptId =
  | 'default'
  | 'gpt'
  | 'gemini'
  | 'beast'
  | 'anthropic'
  | 'trinity'
  | 'codex'
  | 'kimi'
  | 'ling'
  | 'meta'
  | 'gpt55';

export type ProbeFamily = { key: string; promptId: ProbePromptId; endpoint: ProbeEndpoint };

export type ProbeModelIdentity = {
  id: string;
  opencode?: { prompt?: string | null; ai_sdk_provider?: string | null } | null;
};

// Catalog prompt names that map onto a captured prompt; `anthropic_without_todo` is the
// default prompt.
const CATALOG_PROMPT_IDS: Readonly<Record<string, ProbePromptId>> = {
  anthropic: 'anthropic',
  anthropic_without_todo: 'default',
  beast: 'beast',
  codex: 'codex',
  gemini: 'gemini',
  gpt55: 'gpt55',
  ling: 'ling',
  trinity: 'trinity',
};

const LING_EXCLUDES = ['kling', 'bling', 'spelling', 'multilingual'];

function isLing(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.includes('ling') && !LING_EXCLUDES.some(part => lower.includes(part));
}

/** The CLI's prompt choice by model id, in the CLI's own order. */
export function probePromptId(model: ProbeModelIdentity): ProbePromptId {
  const catalogPrompt = model.opencode?.prompt;
  if (catalogPrompt) {
    const mapped = CATALOG_PROMPT_IDS[catalogPrompt];
    if (mapped) return mapped;
  }
  const id = model.id;
  if (id.includes('muse')) return 'meta';
  if (id.includes('gpt-4') || id.includes('o1') || id.includes('o3')) return 'beast';
  if (id.includes('gpt')) return id.includes('codex') ? 'codex' : 'gpt';
  if (id.includes('gemini-')) return 'gemini';
  if (id.includes('claude')) return 'anthropic';
  if (id.toLowerCase().includes('trinity')) return 'trinity';
  if (id.toLowerCase().includes('kimi')) return 'kimi';
  if (isLing(id)) return 'ling';
  return 'default';
}

/** The endpoint the CLI's provider selection sends this model to. */
export function probeEndpoint(model: ProbeModelIdentity): ProbeEndpoint {
  switch (model.opencode?.ai_sdk_provider) {
    case 'openai':
      return 'responses';
    case 'anthropic':
      return 'anthropic';
    default:
      return 'chat';
  }
}

export function probeFamily(model: ProbeModelIdentity): ProbeFamily {
  const promptId = probePromptId(model);
  const endpoint = probeEndpoint(model);
  return { promptId, endpoint, key: `${promptId}/${endpoint}` };
}
