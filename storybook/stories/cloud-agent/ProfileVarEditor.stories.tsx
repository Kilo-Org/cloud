import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Lock,
  Loader2,
  AlertCircle,
  Terminal,
  Key,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import type { ProfileVar, ProfileCommand, ProfileDetails } from '@/hooks/useCloudAgentProfiles';
import {
  mockProfileDetails,
  mockEmptyProfileDetails,
  mockLocalDevProfileDetails,
  mockStagingProfileDetails,
} from '../../src/mockData/profiles';

/**
 * ProfileVarEditorPresentation - A presentation-only version of ProfileVarEditor
 * for Storybook stories. The actual component uses useProfile() and useProfileMutations()
 * hooks internally, so we recreate the UI with all state passed as props.
 */
type ProfileVarEditorPresentationProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBack?: () => void;
  profile: ProfileDetails | null;
  isLoading?: boolean;
  error?: boolean;
  activeTab: 'vars' | 'commands';
  onTabChange: (tab: 'vars' | 'commands') => void;
  // Add variable state
  isAddingVar: boolean;
  newVarKey: string;
  newVarValue: string;
  newVarIsSecret: boolean;
  showNewVarValue: boolean;
  onStartAddVar: () => void;
  onCancelAddVar: () => void;
  onNewVarKeyChange: (key: string) => void;
  onNewVarValueChange: (value: string) => void;
  onNewVarIsSecretChange: (isSecret: boolean) => void;
  onToggleShowNewVarValue: () => void;
  onAddVar: () => void;
  // Edit variable state
  editingVarKey: string | null;
  editingVarValue: string;
  showEditingVarValue: boolean;
  onStartEditVar: (varItem: ProfileVar) => void;
  onCancelEditVar: () => void;
  onEditingVarValueChange: (value: string) => void;
  onToggleShowEditingVarValue: () => void;
  onSaveVar: (varItem: ProfileVar) => void;
  onDeleteVar: (key: string) => void;
  // Add command state
  isAddingCommand: boolean;
  newCommand: string;
  onStartAddCommand: () => void;
  onCancelAddCommand: () => void;
  onNewCommandChange: (command: string) => void;
  onAddCommand: () => void;
  onDeleteCommand: (index: number) => void;
  // Loading states
  savingVarKey: string | null;
  deletingVarKey: string | null;
  savingCommands: boolean;
};

function ProfileVarEditorPresentation({
  open,
  onOpenChange,
  onBack,
  profile,
  isLoading = false,
  error = false,
  activeTab,
  onTabChange,
  isAddingVar,
  newVarKey,
  newVarValue,
  newVarIsSecret,
  showNewVarValue,
  onStartAddVar,
  onCancelAddVar,
  onNewVarKeyChange,
  onNewVarValueChange,
  onNewVarIsSecretChange,
  onToggleShowNewVarValue,
  onAddVar,
  editingVarKey,
  editingVarValue,
  showEditingVarValue,
  onStartEditVar,
  onCancelEditVar,
  onEditingVarValueChange,
  onToggleShowEditingVarValue,
  onSaveVar,
  onDeleteVar,
  isAddingCommand,
  newCommand,
  onStartAddCommand,
  onCancelAddCommand,
  onNewCommandChange,
  onAddCommand,
  onDeleteCommand,
  savingVarKey,
  deletingVarKey,
  savingCommands,
}: ProfileVarEditorPresentationProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            {onBack && (
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <div>
              <DialogTitle>{isLoading ? 'Loading...' : profile?.name || 'Profile'}</DialogTitle>
              <DialogDescription>
                {profile?.description || 'Edit environment variables and startup commands'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Tab navigation */}
        <div className="flex gap-1 border-b">
          <button
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'vars'
                ? 'border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground border-transparent'
            }`}
            onClick={() => onTabChange('vars')}
          >
            <Key className="mr-1.5 inline-block h-4 w-4" />
            Variables ({profile?.vars.length || 0})
          </button>
          <button
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'commands'
                ? 'border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground border-transparent'
            }`}
            onClick={() => onTabChange('commands')}
          >
            <Terminal className="mr-1.5 inline-block h-4 w-4" />
            Commands ({profile?.commands.length || 0})
          </button>
        </div>

        <div className="max-h-[400px] overflow-y-auto py-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : error ? (
            <div className="text-destructive flex items-center justify-center gap-2 py-8">
              <AlertCircle className="h-5 w-5" />
              <span>Failed to load profile</span>
            </div>
          ) : activeTab === 'vars' ? (
            /* Variables Tab */
            <div className="space-y-2">
              {profile?.vars.map(varItem => (
                <div
                  key={varItem.key}
                  className="hover:bg-accent/50 rounded-lg border p-3 transition-colors"
                >
                  {editingVarKey === varItem.key ? (
                    // Edit mode
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <code className="bg-muted rounded px-2 py-1 font-mono text-sm">
                          {varItem.key}
                        </code>
                        {varItem.isSecret && <Lock className="text-muted-foreground h-4 w-4" />}
                      </div>
                      <div className="relative">
                        <Input
                          type={showEditingVarValue ? 'text' : 'password'}
                          value={editingVarValue}
                          onChange={e => onEditingVarValueChange(e.target.value)}
                          placeholder={varItem.isSecret ? 'Enter new secret value' : 'Value'}
                          className="pr-10"
                        />
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
                          onClick={onToggleShowEditingVarValue}
                        >
                          {showEditingVarValue ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={onCancelEditVar}
                          disabled={savingVarKey === varItem.key}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => onSaveVar(varItem)}
                          disabled={savingVarKey === varItem.key}
                        >
                          {savingVarKey === varItem.key ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            'Save'
                          )}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    // View mode
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <code className="bg-muted shrink-0 rounded px-2 py-1 font-mono text-sm">
                          {varItem.key}
                        </code>
                        {varItem.isSecret ? (
                          <span className="text-muted-foreground flex items-center gap-1 text-sm">
                            <Lock className="h-3 w-3" />
                            •••••••
                          </span>
                        ) : (
                          <span className="text-muted-foreground truncate text-sm">
                            {varItem.value}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onStartEditVar(varItem)}
                          disabled={deletingVarKey === varItem.key}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive h-8 w-8"
                          onClick={() => onDeleteVar(varItem.key)}
                          disabled={deletingVarKey === varItem.key}
                        >
                          {deletingVarKey === varItem.key ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* Add new variable form */}
              {isAddingVar ? (
                <div className="space-y-3 rounded-lg border border-dashed p-3">
                  <div className="grid gap-2">
                    <Label htmlFor="new-var-key">Variable Name</Label>
                    <Input
                      id="new-var-key"
                      value={newVarKey}
                      onChange={e =>
                        onNewVarKeyChange(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))
                      }
                      placeholder="API_KEY"
                      className="font-mono"
                      autoFocus
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="new-var-value">Value</Label>
                    <div className="relative">
                      <Input
                        id="new-var-value"
                        type={showNewVarValue ? 'text' : 'password'}
                        value={newVarValue}
                        onChange={e => onNewVarValueChange(e.target.value)}
                        placeholder={newVarIsSecret ? 'Secret value (encrypted)' : 'Value'}
                        className="pr-10"
                      />
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
                        onClick={onToggleShowNewVarValue}
                      >
                        {showNewVarValue ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="new-var-secret"
                      checked={newVarIsSecret}
                      onCheckedChange={checked => onNewVarIsSecretChange(checked === true)}
                    />
                    <Label
                      htmlFor="new-var-secret"
                      className="flex cursor-pointer items-center gap-1"
                    >
                      <Lock className="h-3 w-3" />
                      Store as encrypted secret
                    </Label>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onCancelAddVar}
                      disabled={savingVarKey === '__new__'}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" onClick={onAddVar} disabled={savingVarKey === '__new__'}>
                      {savingVarKey === '__new__' ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        'Add Variable'
                      )}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" className="w-full border-dashed" onClick={onStartAddVar}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Variable
                </Button>
              )}

              {profile?.vars.length === 0 && !isAddingVar && (
                <p className="text-muted-foreground py-4 text-center text-sm">
                  No environment variables yet.
                </p>
              )}
            </div>
          ) : (
            /* Commands Tab */
            <div className="space-y-2">
              {profile?.commands.map((cmd, index) => (
                <div
                  key={`${cmd.sequence}-${index}`}
                  className="hover:bg-accent/50 flex items-center gap-2 rounded-lg border p-3 transition-colors"
                >
                  <span className="text-muted-foreground w-6 shrink-0 text-xs">{index + 1}.</span>
                  <code className="bg-muted flex-1 truncate rounded px-2 py-1 font-mono text-sm">
                    {cmd.command}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive h-8 w-8 shrink-0"
                    onClick={() => onDeleteCommand(index)}
                    disabled={savingCommands}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}

              {/* Add new command form */}
              {isAddingCommand ? (
                <div className="space-y-3 rounded-lg border border-dashed p-3">
                  <div className="grid gap-2">
                    <Label htmlFor="new-command">Command</Label>
                    <Input
                      id="new-command"
                      value={newCommand}
                      onChange={e => onNewCommandChange(e.target.value)}
                      placeholder="npm install"
                      className="font-mono"
                      autoFocus
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onCancelAddCommand}
                      disabled={savingCommands}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" onClick={onAddCommand} disabled={savingCommands}>
                      {savingCommands ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        'Add Command'
                      )}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  className="w-full border-dashed"
                  onClick={onStartAddCommand}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add Command
                </Button>
              )}

              {profile?.commands.length === 0 && !isAddingCommand && (
                <p className="text-muted-foreground py-4 text-center text-sm">
                  No startup commands yet. Commands run in order when the session starts.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Wrapper component to handle state
function ProfileVarEditorWrapper({
  profile = mockProfileDetails,
  isLoading = false,
  error = false,
  initialTab = 'vars' as const,
  initialIsAddingVar = false,
  initialEditingVarKey = null as string | null,
  initialIsAddingCommand = false,
}: {
  profile?: ProfileDetails;
  isLoading?: boolean;
  error?: boolean;
  initialTab?: 'vars' | 'commands';
  initialIsAddingVar?: boolean;
  initialEditingVarKey?: string | null;
  initialIsAddingCommand?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<'vars' | 'commands'>(initialTab);

  // Add variable state
  const [isAddingVar, setIsAddingVar] = useState(initialIsAddingVar);
  const [newVarKey, setNewVarKey] = useState('');
  const [newVarValue, setNewVarValue] = useState('');
  const [newVarIsSecret, setNewVarIsSecret] = useState(false);
  const [showNewVarValue, setShowNewVarValue] = useState(false);

  // Edit variable state
  const [editingVarKey, setEditingVarKey] = useState<string | null>(initialEditingVarKey);
  const [editingVarValue, setEditingVarValue] = useState('');
  const [showEditingVarValue, setShowEditingVarValue] = useState(false);

  // Add command state
  const [isAddingCommand, setIsAddingCommand] = useState(initialIsAddingCommand);
  const [newCommand, setNewCommand] = useState('');

  const handleStartEditVar = (varItem: ProfileVar) => {
    setEditingVarKey(varItem.key);
    setEditingVarValue(varItem.isSecret ? '' : varItem.value);
    setShowEditingVarValue(!varItem.isSecret);
  };

  return (
    <ProfileVarEditorPresentation
      open={open}
      onOpenChange={setOpen}
      onBack={() => console.log('Back clicked')}
      profile={profile}
      isLoading={isLoading}
      error={error}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      isAddingVar={isAddingVar}
      newVarKey={newVarKey}
      newVarValue={newVarValue}
      newVarIsSecret={newVarIsSecret}
      showNewVarValue={showNewVarValue}
      onStartAddVar={() => setIsAddingVar(true)}
      onCancelAddVar={() => {
        setIsAddingVar(false);
        setNewVarKey('');
        setNewVarValue('');
        setNewVarIsSecret(false);
      }}
      onNewVarKeyChange={setNewVarKey}
      onNewVarValueChange={setNewVarValue}
      onNewVarIsSecretChange={setNewVarIsSecret}
      onToggleShowNewVarValue={() => setShowNewVarValue(!showNewVarValue)}
      onAddVar={() => console.log('Add var:', { newVarKey, newVarValue, newVarIsSecret })}
      editingVarKey={editingVarKey}
      editingVarValue={editingVarValue}
      showEditingVarValue={showEditingVarValue}
      onStartEditVar={handleStartEditVar}
      onCancelEditVar={() => setEditingVarKey(null)}
      onEditingVarValueChange={setEditingVarValue}
      onToggleShowEditingVarValue={() => setShowEditingVarValue(!showEditingVarValue)}
      onSaveVar={varItem => console.log('Save var:', varItem.key)}
      onDeleteVar={key => console.log('Delete var:', key)}
      isAddingCommand={isAddingCommand}
      newCommand={newCommand}
      onStartAddCommand={() => setIsAddingCommand(true)}
      onCancelAddCommand={() => {
        setIsAddingCommand(false);
        setNewCommand('');
      }}
      onNewCommandChange={setNewCommand}
      onAddCommand={() => console.log('Add command:', newCommand)}
      onDeleteCommand={index => console.log('Delete command at index:', index)}
      savingVarKey={null}
      deletingVarKey={null}
      savingCommands={false}
    />
  );
}

const meta: Meta<typeof ProfileVarEditorPresentation> = {
  title: 'Cloud Agent/ProfileVarEditor',
  component: ProfileVarEditorPresentation,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Variables tab - empty state
 */
export const VariablesTabEmpty: Story = {
  render: () => <ProfileVarEditorWrapper profile={mockEmptyProfileDetails} initialTab="vars" />,
};

/**
 * Variables tab with mixed vars and secrets
 */
export const VariablesTabWithVars: Story = {
  render: () => <ProfileVarEditorWrapper initialTab="vars" />,
};

/**
 * Variables tab - adding a new variable
 */
export const VariablesTabAddNew: Story = {
  render: () => <ProfileVarEditorWrapper initialTab="vars" initialIsAddingVar />,
};

/**
 * Variables tab - editing a variable
 */
export const VariablesTabEditVar: Story = {
  render: () => <ProfileVarEditorWrapper initialTab="vars" initialEditingVarKey="AWS_REGION" />,
};

/**
 * Variables tab with local dev profile (no secrets)
 */
export const VariablesTabLocalDev: Story = {
  render: () => <ProfileVarEditorWrapper profile={mockLocalDevProfileDetails} initialTab="vars" />,
};

/**
 * Commands tab - empty state
 */
export const CommandsTabEmpty: Story = {
  render: () => <ProfileVarEditorWrapper profile={mockEmptyProfileDetails} initialTab="commands" />,
};

/**
 * Commands tab with commands
 */
export const CommandsTabWithCommands: Story = {
  render: () => <ProfileVarEditorWrapper initialTab="commands" />,
};

/**
 * Commands tab with staging profile (more commands)
 */
export const CommandsTabStaging: Story = {
  render: () => (
    <ProfileVarEditorWrapper profile={mockStagingProfileDetails} initialTab="commands" />
  ),
};

/**
 * Commands tab - adding a new command
 */
export const CommandsTabAddNew: Story = {
  render: () => <ProfileVarEditorWrapper initialTab="commands" initialIsAddingCommand />,
};

/**
 * Loading state
 */
export const Loading: Story = {
  render: () => <ProfileVarEditorWrapper isLoading />,
};

/**
 * Error state
 */
export const Error: Story = {
  render: () => <ProfileVarEditorWrapper error />,
};

/**
 * Saving a variable
 */
export const SavingVar: Story = {
  render: () => {
    const [open, setOpen] = useState(true);

    return (
      <ProfileVarEditorPresentation
        open={open}
        onOpenChange={setOpen}
        profile={mockProfileDetails}
        activeTab="vars"
        onTabChange={() => {}}
        isAddingVar={false}
        newVarKey=""
        newVarValue=""
        newVarIsSecret={false}
        showNewVarValue={false}
        onStartAddVar={() => {}}
        onCancelAddVar={() => {}}
        onNewVarKeyChange={() => {}}
        onNewVarValueChange={() => {}}
        onNewVarIsSecretChange={() => {}}
        onToggleShowNewVarValue={() => {}}
        onAddVar={() => {}}
        editingVarKey="AWS_REGION"
        editingVarValue="eu-west-1"
        showEditingVarValue={true}
        onStartEditVar={() => {}}
        onCancelEditVar={() => {}}
        onEditingVarValueChange={() => {}}
        onToggleShowEditingVarValue={() => {}}
        onSaveVar={() => {}}
        onDeleteVar={() => {}}
        isAddingCommand={false}
        newCommand=""
        onStartAddCommand={() => {}}
        onCancelAddCommand={() => {}}
        onNewCommandChange={() => {}}
        onAddCommand={() => {}}
        onDeleteCommand={() => {}}
        savingVarKey="AWS_REGION"
        deletingVarKey={null}
        savingCommands={false}
      />
    );
  },
};

/**
 * Deleting a variable
 */
export const DeletingVar: Story = {
  render: () => {
    const [open, setOpen] = useState(true);

    return (
      <ProfileVarEditorPresentation
        open={open}
        onOpenChange={setOpen}
        profile={mockProfileDetails}
        activeTab="vars"
        onTabChange={() => {}}
        isAddingVar={false}
        newVarKey=""
        newVarValue=""
        newVarIsSecret={false}
        showNewVarValue={false}
        onStartAddVar={() => {}}
        onCancelAddVar={() => {}}
        onNewVarKeyChange={() => {}}
        onNewVarValueChange={() => {}}
        onNewVarIsSecretChange={() => {}}
        onToggleShowNewVarValue={() => {}}
        onAddVar={() => {}}
        editingVarKey={null}
        editingVarValue=""
        showEditingVarValue={false}
        onStartEditVar={() => {}}
        onCancelEditVar={() => {}}
        onEditingVarValueChange={() => {}}
        onToggleShowEditingVarValue={() => {}}
        onSaveVar={() => {}}
        onDeleteVar={() => {}}
        isAddingCommand={false}
        newCommand=""
        onStartAddCommand={() => {}}
        onCancelAddCommand={() => {}}
        onNewCommandChange={() => {}}
        onAddCommand={() => {}}
        onDeleteCommand={() => {}}
        savingVarKey={null}
        deletingVarKey="DATABASE_URL"
        savingCommands={false}
      />
    );
  },
};

/**
 * Saving commands (reorder/add/delete)
 */
export const SavingCommands: Story = {
  render: () => {
    const [open, setOpen] = useState(true);

    return (
      <ProfileVarEditorPresentation
        open={open}
        onOpenChange={setOpen}
        profile={mockProfileDetails}
        activeTab="commands"
        onTabChange={() => {}}
        isAddingVar={false}
        newVarKey=""
        newVarValue=""
        newVarIsSecret={false}
        showNewVarValue={false}
        onStartAddVar={() => {}}
        onCancelAddVar={() => {}}
        onNewVarKeyChange={() => {}}
        onNewVarValueChange={() => {}}
        onNewVarIsSecretChange={() => {}}
        onToggleShowNewVarValue={() => {}}
        onAddVar={() => {}}
        editingVarKey={null}
        editingVarValue=""
        showEditingVarValue={false}
        onStartEditVar={() => {}}
        onCancelEditVar={() => {}}
        onEditingVarValueChange={() => {}}
        onToggleShowEditingVarValue={() => {}}
        onSaveVar={() => {}}
        onDeleteVar={() => {}}
        isAddingCommand={false}
        newCommand=""
        onStartAddCommand={() => {}}
        onCancelAddCommand={() => {}}
        onNewCommandChange={() => {}}
        onAddCommand={() => {}}
        onDeleteCommand={() => {}}
        savingVarKey={null}
        deletingVarKey={null}
        savingCommands={true}
      />
    );
  },
};

/**
 * With back button (when opened from ProfilesListDialog)
 */
export const WithBackButton: Story = {
  render: () => <ProfileVarEditorWrapper />,
};

/**
 * Without back button (standalone)
 */
export const WithoutBackButton: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    const [activeTab, setActiveTab] = useState<'vars' | 'commands'>('vars');

    return (
      <ProfileVarEditorPresentation
        open={open}
        onOpenChange={setOpen}
        profile={mockProfileDetails}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isAddingVar={false}
        newVarKey=""
        newVarValue=""
        newVarIsSecret={false}
        showNewVarValue={false}
        onStartAddVar={() => {}}
        onCancelAddVar={() => {}}
        onNewVarKeyChange={() => {}}
        onNewVarValueChange={() => {}}
        onNewVarIsSecretChange={() => {}}
        onToggleShowNewVarValue={() => {}}
        onAddVar={() => {}}
        editingVarKey={null}
        editingVarValue=""
        showEditingVarValue={false}
        onStartEditVar={() => {}}
        onCancelEditVar={() => {}}
        onEditingVarValueChange={() => {}}
        onToggleShowEditingVarValue={() => {}}
        onSaveVar={() => {}}
        onDeleteVar={() => {}}
        isAddingCommand={false}
        newCommand=""
        onStartAddCommand={() => {}}
        onCancelAddCommand={() => {}}
        onNewCommandChange={() => {}}
        onAddCommand={() => {}}
        onDeleteCommand={() => {}}
        savingVarKey={null}
        deletingVarKey={null}
        savingCommands={false}
      />
    );
  },
};

/**
 * Many variables - scrolling behavior
 */
export const ManyVariables: Story = {
  render: () => {
    const manyVarsProfile: ProfileDetails = {
      id: 'profile-many',
      name: 'Many Variables',
      description: 'A profile with many variables to test scrolling',
      isDefault: false,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      vars: Array.from({ length: 20 }, (_, i) => ({
        key: `ENV_VAR_${i + 1}`,
        value: i % 3 === 0 ? '***' : `value_${i + 1}`,
        isSecret: i % 3 === 0,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      })),
      commands: [],
    };
    return <ProfileVarEditorWrapper profile={manyVarsProfile} initialTab="vars" />;
  },
};

/**
 * Many commands - scrolling behavior
 */
export const ManyCommands: Story = {
  render: () => {
    const manyCommandsProfile: ProfileDetails = {
      id: 'profile-many-cmds',
      name: 'Many Commands',
      description: 'A profile with many commands to test scrolling',
      isDefault: false,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      vars: [],
      commands: Array.from({ length: 15 }, (_, i) => ({
        sequence: i,
        command: `command-${i + 1} --option=${i} --verbose`,
      })),
    };
    return <ProfileVarEditorWrapper profile={manyCommandsProfile} initialTab="commands" />;
  },
};
