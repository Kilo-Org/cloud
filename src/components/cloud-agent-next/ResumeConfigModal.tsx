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
import { Input } from '@/components/ui/input';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { RepositoryCombobox, type RepositoryOption } from '@/components/shared/RepositoryCombobox';
import { EnvVarsDialog } from './EnvVarsDialog';
import { SetupCommandsDialog } from './SetupCommandsDialog';
import type { ResumeConfig } from './types';
import type { DbSessionDetails } from './store/db-session-atoms';
import { extractRepoFromGitUrl } from './utils/git-utils';
import { Cloud } from 'lucide-react';

// Re-export ResumeConfig for backwards compatibility
export type { ResumeConfig };

type ResumeConfigModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (config: ResumeConfig) => void;
  /** The session being configured — source for title, git_url, git_branch, last_mode, last_model */
  session: DbSessionDetails;
  /** Available repositories to select from */
  repositories: RepositoryOption[];
  /** Whether repositories are loading */
  isLoadingRepos?: boolean;
  /** Available models to select from */
  modelOptions: ModelOption[];
  /** Whether models are still loading */
  isLoadingModels?: boolean;
  /** Organization default model (fallback when session has no last_model) */
  orgDefaultModel?: string;
};

export const MODES = [
  { value: 'build', label: 'Build' },
  { value: 'plan', label: 'Plan' },
] as const;

/** Valid mode values for validation */
export const VALID_MODE_VALUES = MODES.map(m => m.value);

function isValidMode(value: string): value is ResumeConfig['mode'] {
  return (VALID_MODE_VALUES as readonly string[]).includes(value);
}

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
  repositories,
  isLoadingRepos = false,
  modelOptions,
  isLoadingModels = false,
  orgDefaultModel,
}: ResumeConfigModalProps) {
  // Derive defaults from session
  const sessionGitUrl = session.git_url;
  const sessionGitBranch = session.git_branch;
  const sessionTitle = session.title;
  const defaultRepo = sessionGitUrl ? extractRepoFromGitUrl(sessionGitUrl) : undefined;
  const defaultBranch = sessionGitBranch ?? undefined;
  const defaultMode =
    session.last_mode && isValidMode(session.last_mode) ? session.last_mode : undefined;
  const defaultModel =
    session.last_model && modelOptions.some(m => m.id === session.last_model)
      ? session.last_model
      : orgDefaultModel;

  // Form state
  const [mode, setMode] = useState<ResumeConfig['mode']>(defaultMode || 'build');
  const [model, setModel] = useState<string>(defaultModel || '');
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [setupCommands, setSetupCommands] = useState<string[]>([]);
  const [githubRepo, setGithubRepo] = useState<string>(
    sessionGitUrl ? (extractRepoFromGitUrl(sessionGitUrl) ?? '') : defaultRepo || ''
  );
  const [branch, setBranch] = useState<string>(
    sessionGitBranch ? sessionGitBranch : defaultBranch || ''
  );

  // Sync mode when session changes (e.g., modal opens for different session)
  useEffect(() => {
    setMode(defaultMode || 'build');
  }, [defaultMode]);

  // Sync model when session changes
  useEffect(() => {
    setModel(defaultModel || '');
  }, [defaultModel]);

  useEffect(() => {
    if (sessionGitUrl) {
      setGithubRepo(extractRepoFromGitUrl(sessionGitUrl) ?? '');
    } else {
      setGithubRepo(defaultRepo || '');
    }
  }, [defaultRepo, sessionGitUrl]);

  useEffect(() => {
    if (sessionGitBranch) {
      setBranch(sessionGitBranch);
    } else {
      setBranch(defaultBranch || '');
    }
  }, [defaultBranch, sessionGitBranch]);

  // Auto-select first model if none selected and models are available
  const effectiveModel = useMemo(() => {
    if (model) return model;
    if (defaultModel && modelOptions.some(m => m.id === defaultModel)) return defaultModel;
    return modelOptions[0]?.id || '';
  }, [model, defaultModel, modelOptions]);

  const handleConfirm = () => {
    const config: ResumeConfig = {
      mode,
      model: effectiveModel,
      githubRepo,
    };

    if (branch) {
      config.branch = branch;
    }

    // Only include optional fields if they have values
    if (Object.keys(envVars).length > 0) {
      config.envVars = envVars;
    }
    if (setupCommands.length > 0) {
      config.setupCommands = setupCommands;
    }

    onConfirm(config);
  };

  const isFormValid = effectiveModel.length > 0 && githubRepo.length > 0;

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
          {/* Session title if available */}
          {sessionTitle && (
            <div className="rounded-md border border-gray-700 bg-gray-800/50 p-3">
              <div className="text-sm">
                <span className="text-muted-foreground">Session:</span>{' '}
                <span className="font-medium">{sessionTitle}</span>
              </div>
            </div>
          )}

          {/* Repository selector */}
          {sessionGitUrl ? (
            <div className="space-y-2">
              <Label>
                Repository <span className="text-red-400">*</span>
              </Label>
              <p className="text-muted-foreground text-sm">{githubRepo}</p>
            </div>
          ) : (
            <RepositoryCombobox
              label="Repository"
              repositories={repositories}
              value={githubRepo}
              onValueChange={setGithubRepo}
              isLoading={isLoadingRepos}
              required
              helperText="Select the repository for this session"
              groupByPlatform
            />
          )}

          {/* Branch input */}
          <div className="space-y-2">
            <Label htmlFor="branch">Branch</Label>
            {sessionGitBranch ? (
              <p className="text-muted-foreground text-sm">{branch}</p>
            ) : (
              <>
                <Input
                  id="branch"
                  value={branch}
                  onChange={e => setBranch(e.target.value)}
                  placeholder="main"
                  className="font-mono"
                />
                <p className="text-muted-foreground text-xs">
                  Branch to use (leave empty for default branch)
                </p>
              </>
            )}
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
