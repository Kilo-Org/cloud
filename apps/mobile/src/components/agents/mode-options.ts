import {
  Bot,
  Bug,
  Code,
  HelpCircle,
  type LucideIcon,
  NotebookPen,
  Workflow,
} from '@/components/ui/icons';

import {
  BUILTIN_AGENT_MODES,
  type BuiltinAgentMode,
  isBuiltinAgentMode,
  normalizeAgentMode,
} from '@/components/agents/mode-normalize';

export type BuiltinModeOption = {
  value: BuiltinAgentMode;
  labelKey: string;
  descriptionKey: string;
};

/**
 * Copy keys per built-in mode. Keyed by the union, so a slug added to
 * `BUILTIN_AGENT_MODES` without copy is a compile error.
 */
const MODE_COPY = {
  code: {
    labelKey: 'agentChat.modeOptions.code',
    descriptionKey: 'agentChat.modeOptions.codeDescription',
  },
  plan: {
    labelKey: 'agentChat.modeOptions.plan',
    descriptionKey: 'agentChat.modeOptions.planDescription',
  },
  debug: {
    labelKey: 'agentChat.modeOptions.debug',
    descriptionKey: 'agentChat.modeOptions.debugDescription',
  },
  orchestrator: {
    labelKey: 'agentChat.modeOptions.orchestrator',
    descriptionKey: 'agentChat.modeOptions.orchestratorDescription',
  },
  ask: {
    labelKey: 'agentChat.modeOptions.ask',
    descriptionKey: 'agentChat.modeOptions.askDescription',
  },
} satisfies Record<BuiltinAgentMode, Omit<BuiltinModeOption, 'value'>>;

/** The picker rows, in `BUILTIN_AGENT_MODES` order. */
export const MODE_OPTIONS: readonly BuiltinModeOption[] = BUILTIN_AGENT_MODES.map(value => ({
  value,
  labelKey: MODE_COPY[value].labelKey,
  descriptionKey: MODE_COPY[value].descriptionKey,
}));

const MODE_ICONS = {
  code: Code,
  plan: NotebookPen,
  debug: Bug,
  orchestrator: Workflow,
  ask: HelpCircle,
} satisfies Record<BuiltinAgentMode, LucideIcon>;

export function getModeIcon(mode: string | null | undefined): LucideIcon {
  const normalized = normalizeAgentMode(mode);
  return isBuiltinAgentMode(normalized) ? MODE_ICONS[normalized] : Bot;
}

export function getBuiltinModeLabelKey(mode: string): string | null {
  const normalized = normalizeAgentMode(mode);
  return isBuiltinAgentMode(normalized) ? MODE_COPY[normalized].labelKey : null;
}

export function getBuiltinModeDescriptionKey(mode: string): string | null {
  const normalized = normalizeAgentMode(mode);
  return isBuiltinAgentMode(normalized) ? MODE_COPY[normalized].descriptionKey : null;
}
