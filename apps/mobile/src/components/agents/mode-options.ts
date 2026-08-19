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
  type ModeOption,
  normalizeAgentMode,
} from '@/components/agents/mode-normalize';

export const MODE_OPTIONS: ModeOption[] = [
  { value: 'code', label: 'Code', description: 'Write and modify code' },
  { value: 'plan', label: 'Plan', description: 'Plan and design solutions' },
  { value: 'debug', label: 'Debug', description: 'Find and fix issues' },
  { value: 'orchestrator', label: 'Orchestrator', description: 'Coordinate complex tasks' },
  { value: 'ask', label: 'Ask', description: 'Get answers and explanations' },
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
