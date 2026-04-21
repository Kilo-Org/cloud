import { type AgentMode } from '@/components/agents/mode-selector';
import { type ModelOption } from '@/lib/hooks/use-available-models';

type ModelPickerBridge = {
  options: ModelOption[];
  currentValue: string;
  currentVariant: string;
  onSelect: (id: string, variant: string) => void;
};

type ModePickerBridge = {
  currentValue: AgentMode;
  onSelect: (mode: AgentMode) => void;
};

type RepoOption = {
  fullName: string;
  isPrivate: boolean;
};

type RepoPickerBridge = {
  repositories: RepoOption[];
  currentValue: string;
  onSelect: (repo: string) => void;
};

let modelBridge: ModelPickerBridge | null = null;
let modeBridge: ModePickerBridge | null = null;
let repoBridge: RepoPickerBridge | null = null;

export function setModelPickerBridge(bridge: ModelPickerBridge) {
  modelBridge = bridge;
}
export function getModelPickerBridge() {
  return modelBridge;
}
export function clearModelPickerBridge() {
  modelBridge = null;
}

export function setModePickerBridge(bridge: ModePickerBridge) {
  modeBridge = bridge;
}
export function getModePickerBridge() {
  return modeBridge;
}
export function clearModePickerBridge() {
  modeBridge = null;
}

export function setRepoPickerBridge(bridge: RepoPickerBridge) {
  repoBridge = bridge;
}
export function getRepoPickerBridge() {
  return repoBridge;
}
export function clearRepoPickerBridge() {
  repoBridge = null;
}
