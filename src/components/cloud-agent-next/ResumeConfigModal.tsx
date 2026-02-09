'use client';

import { useState, useMemo, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { EnvVarsDialog } from './EnvVarsDialog';
import { SetupCommandsDialog } from './SetupCommandsDialog';
import { extractRepoFromGitUrl } from './utils/git-utils';
import type { ResumeConfig } from './types';
import { GitBranch, Cloud } from 'lucide-react';

// Re-export ResumeConfig for backwards compatibility
export type { ResumeConfig };

type ResumeConfigModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (config: ResumeConfig) => void;
  session: {
    session_id: string;
    git_url: string | null;
    title: string | null;
  };
  gitState?: {
    branch?: string;
  } | null;
  /** Available models to select from */
  modelOptions: ModelOption[];
  /** Whether models are still loading */
  isLoadingModels?: boolean;
  /** Default mode to select (from session's last_mode) */
  defaultMode?: ResumeConfig['mode'];
  /** Default model to select (from session's last_model or org default) */
  defaultModel?: string;
};

export const MODES = [
  { value: 'build', label: 'Build' },
  { value: 'plan', label: 'Plan' },
] as const;

/** Valid mode values for validation */
export const VALID_MODE_VALUES = MODES.map(m => m.value);

/**
 * Modal for collecting configuration when resuming a CLI session
 * that has never run in cloud-agent (no cloud_agent_session_id).
 *
 * Collects:
 * - Mode (required)
 * - Model (required)
 * - Environment Variables (optional)
 * - Setup Commands (optional)
 */
export function ResumeConfigModal({
  isOpen,
  onClose,
  onConfirm,
  session,
  gitState,
  modelOptions,
  isLoadingModels = false,
  defaultMode,
  defaultModel,
}: ResumeConfigModalProps) {
  // Form state
  const [mode, setMode] = useState<ResumeConfig['mode']>(defaultMode || 'build');
  const [model, setModel] = useState<string>(defaultModel || '');
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [setupCommands, setSetupCommands] = useState<string[]>([]);

  // Sync mode when defaultMode prop changes (e.g., when session data loads or modal opens for different session)
  // Always sync to handle both truthy values and reset to fallback when undefined/null
  useEffect(() => {
    setMode(defaultMode || 'build');
  }, [defaultMode]);

  // Sync model when defaultModel prop changes (e.g., when session data loads or modal opens for different session)
  // Always sync to handle both truthy values and reset to fallback when undefined/null
  useEffect(() => {
    setModel(defaultModel || '');
  }, [defaultModel]);

  // Auto-select first model if none selected and models are available
  const effectiveModel = useMemo(() => {
    if (model) return model;
    if (defaultModel && modelOptions.some(m => m.id === defaultModel)) return defaultModel;
    return modelOptions[0]?.id || '';
  }, [model, defaultModel, modelOptions]);

  // Parse repository from git URL
  const repository = useMemo(
    () => extractRepoFromGitUrl(session.git_url) || 'Unknown repository',
    [session.git_url]
  );

  // Get branch name
  const branch = gitState?.branch || 'default';

  const handleConfirm = () => {
    const config: ResumeConfig = {
      mode,
      model: effectiveModel,
    };

    // Only include optional fields if they have values
    if (Object.keys(envVars).length > 0) {
      config.envVars = envVars;
    }
    if (setupCommands.length > 0) {
      config.setupCommands = setupCommands;
    }

    onConfirm(config);
  };

  const isFormValid = effectiveModel.length > 0;

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="h-5 w-5" />
            Resume Session in Cloud
          </DialogTitle>
          <DialogDescription>
            Configure the cloud agent to continue this session. This session was started in Kilo
            Code and needs configuration to run in the cloud.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Read-only session info */}
          <div className="rounded-md border border-gray-700 bg-gray-800/50 p-3">
            <div className="space-y-2 text-sm">
              <div className="flex items-start justify-between gap-2">
                <span className="text-muted-foreground">Repository:</span>
                <span className="text-right font-medium">{repository}</span>
              </div>
              <div className="flex items-start justify-between gap-2">
                <span className="text-muted-foreground flex items-center gap-1">
                  <GitBranch className="h-3 w-3" />
                  Branch:
                </span>
                <span className="text-right font-medium">{branch}</span>
              </div>
              {session.title && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-muted-foreground">Session:</span>
                  <span className="max-w-[250px] truncate text-right font-medium">
                    {session.title}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Required: Mode selector */}
          <div className="space-y-2">
            <Label htmlFor="mode">
              Mode <span className="text-red-400">*</span>
            </Label>
            <Select value={mode} onValueChange={val => setMode(val as ResumeConfig['mode'])}>
              <SelectTrigger id="mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map(m => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">Select the agent mode for this session</p>
          </div>

          {/* Required: Model selector */}
          <ModelCombobox
            label="Model"
            models={modelOptions}
            value={effectiveModel}
            onValueChange={setModel}
            isLoading={isLoadingModels}
            required
            helperText="Select the AI model to use"
          />

          {/* Optional: Advanced Configuration */}
          <div className="space-y-2">
            <Label>Advanced Configuration (Optional)</Label>
            <div className="flex flex-wrap gap-2">
              <EnvVarsDialog value={envVars} onChange={setEnvVars} />
              <SetupCommandsDialog value={setupCommands} onChange={setSetupCommands} />
            </div>
            <p className="text-muted-foreground text-xs">
              Configure environment variables and setup commands for the agent
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!isFormValid}>
            <Cloud className="mr-2 h-4 w-4" />
            Resume in Cloud
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
