import { Bug, Code, HelpCircle, type LucideIcon, NotebookPen, Workflow } from 'lucide-react-native';

import { type AgentMode } from '@/components/agents/mode-selector';

export type ModeOption = {
  value: AgentMode;
  label: string;
  description: string;
};

export const MODE_OPTIONS: ModeOption[] = [
  { value: 'code', label: 'Code', description: 'Write and modify code' },
  { value: 'plan', label: 'Plan', description: 'Plan and design solutions' },
  { value: 'debug', label: 'Debug', description: 'Find and fix issues' },
  { value: 'orchestrator', label: 'Orchestrator', description: 'Coordinate complex tasks' },
  { value: 'ask', label: 'Ask', description: 'Get answers and explanations' },
];

const MODE_ICONS: Record<AgentMode, LucideIcon> = {
  code: Code,
  plan: NotebookPen,
  debug: Bug,
  orchestrator: Workflow,
  ask: HelpCircle,
};

export function normalizeAgentMode(mode: string | null | undefined): AgentMode {
  if (mode === 'build') {
    return 'code';
  }
  if (mode === 'architect') {
    return 'plan';
  }
  if (
    mode === 'code' ||
    mode === 'plan' ||
    mode === 'debug' ||
    mode === 'orchestrator' ||
    mode === 'ask'
  ) {
    return mode;
  }

  return 'code';
}

export function getModeIcon(mode: string | null | undefined): LucideIcon {
  return MODE_ICONS[normalizeAgentMode(mode)];
}
