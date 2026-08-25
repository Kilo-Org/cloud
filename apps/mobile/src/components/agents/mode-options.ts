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
  type BuiltinAgentMode,
  isBuiltinAgentMode,
  normalizeAgentMode,
} from '@/components/agents/mode-normalize';

export type BuiltinModeOption = {
  value: BuiltinAgentMode;
  labelKey: string;
  descriptionKey: string;
};

export const MODE_OPTIONS: readonly BuiltinModeOption[] = [
  {
    value: 'code',
    labelKey: 'agentChat.modeOptions.code',
    descriptionKey: 'agentChat.modeOptions.codeDescription',
  },
  {
    value: 'plan',
    labelKey: 'agentChat.modeOptions.plan',
    descriptionKey: 'agentChat.modeOptions.planDescription',
  },
  {
    value: 'debug',
    labelKey: 'agentChat.modeOptions.debug',
    descriptionKey: 'agentChat.modeOptions.debugDescription',
  },
  {
    value: 'orchestrator',
    labelKey: 'agentChat.modeOptions.orchestrator',
    descriptionKey: 'agentChat.modeOptions.orchestratorDescription',
  },
  {
    value: 'ask',
    labelKey: 'agentChat.modeOptions.ask',
    descriptionKey: 'agentChat.modeOptions.askDescription',
  },
];

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
  if (!isBuiltinAgentMode(normalized)) {
    return null;
  }
  return MODE_OPTIONS.find(option => option.value === normalized)?.labelKey ?? null;
}

export function getBuiltinModeDescriptionKey(mode: string): string | null {
  const normalized = normalizeAgentMode(mode);
  if (!isBuiltinAgentMode(normalized)) {
    return null;
  }
  return MODE_OPTIONS.find(option => option.value === normalized)?.descriptionKey ?? null;
}
