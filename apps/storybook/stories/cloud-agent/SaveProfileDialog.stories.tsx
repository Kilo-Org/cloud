import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import { Save, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';

/**
 * SaveProfileDialogPresentation - A presentation-only version of SaveProfileDialog
 * for Storybook stories. The actual component uses useProfileMutations() hook internally,
 * so we recreate the UI with all state passed as props.
 */
type EnvVar = {
  key: string;
  value: string;
  isSecret?: boolean;
};

type SaveProfileDialogPresentationProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  envVars: EnvVar[];
  setupCommands: string[];
  name: string;
  onNameChange: (name: string) => void;
  description: string;
  onDescriptionChange: (description: string) => void;
  setAsDefault: boolean;
  onSetAsDefaultChange: (value: boolean) => void;
  onSave: () => void;
  isSaving: boolean;
  errors?: { name?: string; description?: string };
  trigger?: React.ReactNode;
};

function SaveProfileDialogPresentation({
  open,
  onOpenChange,
  envVars,
  setupCommands,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  setAsDefault,
  onSetAsDefaultChange,
  onSave,
  isSaving,
  errors = {},
  trigger,
}: SaveProfileDialogPresentationProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Save className="mr-2 h-4 w-4" />
            Save as Profile
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Save as Profile</DialogTitle>
          <DialogDescription>
            Save the current environment variables and setup commands as a reusable profile.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="profileName">Profile Name *</Label>
            <Input
              id="profileName"
              value={name}
              onChange={e => onNameChange(e.target.value)}
              placeholder="My AWS Profile"
              aria-invalid={!!errors.name}
            />
            {errors.name && <p className="text-destructive text-sm">{errors.name}</p>}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="profileDescription">Description</Label>
            <Textarea
              id="profileDescription"
              value={description}
              onChange={e => onDescriptionChange(e.target.value)}
              placeholder="Optional description for this profile..."
              rows={3}
              aria-invalid={!!errors.description}
            />
            {errors.description && <p className="text-destructive text-sm">{errors.description}</p>}
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="setAsDefault"
              checked={setAsDefault}
              onCheckedChange={checked => onSetAsDefaultChange(checked === true)}
            />
            <Label htmlFor="setAsDefault" className="cursor-pointer">
              Set as default profile
            </Label>
          </div>

          {/* Summary of what will be saved */}
          <div className="bg-muted rounded-md p-3 text-sm">
            <p className="font-medium">This profile will include:</p>
            <ul className="text-muted-foreground mt-1 list-inside list-disc">
              <li>
                {envVars.length} environment variable{envVars.length !== 1 ? 's' : ''}
              </li>
              <li>
                {setupCommands.length} setup command{setupCommands.length !== 1 ? 's' : ''}
              </li>
            </ul>
            {envVars.some(v => v.isSecret) && (
              <p className="text-muted-foreground mt-2 text-xs">
                ⚠️ Secrets will be encrypted before storage.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                Save Profile
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Wrapper component to handle state
function SaveProfileDialogWrapper({
  initialOpen = false,
  envVars = [],
  setupCommands = [],
  isSaving = false,
  errors = {},
}: {
  initialOpen?: boolean;
  envVars?: EnvVar[];
  setupCommands?: string[];
  isSaving?: boolean;
  errors?: { name?: string; description?: string };
}) {
  const [open, setOpen] = useState(initialOpen);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [setAsDefault, setSetAsDefault] = useState(false);

  return (
    <SaveProfileDialogPresentation
      open={open}
      onOpenChange={setOpen}
      envVars={envVars}
      setupCommands={setupCommands}
      name={name}
      onNameChange={setName}
      description={description}
      onDescriptionChange={setDescription}
      setAsDefault={setAsDefault}
      onSetAsDefaultChange={setSetAsDefault}
      onSave={() => console.log('Save clicked', { name, description, setAsDefault })}
      isSaving={isSaving}
      errors={errors}
    />
  );
}

const meta: Meta<typeof SaveProfileDialogPresentation> = {
  title: 'Cloud Agent/SaveProfileDialog',
  component: SaveProfileDialogPresentation,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Just the trigger button visible (dialog closed)
 */
export const Trigger: Story = {
  render: () => <SaveProfileDialogWrapper />,
};

/**
 * Dialog open with no env vars or commands (empty session)
 */
export const Empty: Story = {
  render: () => <SaveProfileDialogWrapper initialOpen envVars={[]} setupCommands={[]} />,
};

/**
 * Dialog open with some environment variables
 */
export const WithEnvVars: Story = {
  render: () => (
    <SaveProfileDialogWrapper
      initialOpen
      envVars={[
        { key: 'NODE_ENV', value: 'production' },
        { key: 'API_URL', value: 'https://api.example.com' },
        { key: 'DEBUG', value: 'false' },
      ]}
      setupCommands={[]}
    />
  ),
};

/**
 * Dialog open with secrets and commands
 */
export const WithSecretsAndCommands: Story = {
  render: () => (
    <SaveProfileDialogWrapper
      initialOpen
      envVars={[
        { key: 'AWS_ACCESS_KEY_ID', value: '***', isSecret: true },
        { key: 'AWS_SECRET_ACCESS_KEY', value: '***', isSecret: true },
        { key: 'AWS_REGION', value: 'us-east-1' },
        { key: 'DATABASE_URL', value: '***', isSecret: true },
        { key: 'NODE_ENV', value: 'production' },
      ]}
      setupCommands={['npm install', 'npm run build', 'npm run migrate']}
    />
  ),
};

/**
 * Dialog showing validation errors
 */
export const FormValidation: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <SaveProfileDialogPresentation
        open={open}
        onOpenChange={setOpen}
        envVars={[{ key: 'API_KEY', value: '***', isSecret: true }]}
        setupCommands={[]}
        name=""
        onNameChange={() => {}}
        description={'x'.repeat(600)}
        onDescriptionChange={() => {}}
        setAsDefault={false}
        onSetAsDefaultChange={() => {}}
        onSave={() => {}}
        isSaving={false}
        errors={{
          name: 'Name is required',
          description: 'Description too long',
        }}
      />
    );
  },
};

/**
 * Dialog in saving state
 */
export const Saving: Story = {
  render: () => (
    <SaveProfileDialogWrapper
      initialOpen
      envVars={[
        { key: 'API_KEY', value: '***', isSecret: true },
        { key: 'API_URL', value: 'https://api.example.com' },
      ]}
      setupCommands={['npm install']}
      isSaving
    />
  ),
};

/**
 * Dialog with custom trigger button
 */
export const CustomTrigger: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [setAsDefault, setSetAsDefault] = useState(false);

    return (
      <SaveProfileDialogPresentation
        open={open}
        onOpenChange={setOpen}
        envVars={[{ key: 'TEST', value: 'value' }]}
        setupCommands={[]}
        name={name}
        onNameChange={setName}
        description={description}
        onDescriptionChange={setDescription}
        setAsDefault={setAsDefault}
        onSetAsDefaultChange={setSetAsDefault}
        onSave={() => console.log('Save')}
        isSaving={false}
        trigger={
          <Button variant="secondary" size="lg">
            💾 Save Configuration
          </Button>
        }
      />
    );
  },
};

/**
 * Dialog with many environment variables
 */
export const ManyEnvVars: Story = {
  render: () => (
    <SaveProfileDialogWrapper
      initialOpen
      envVars={Array.from({ length: 15 }, (_, i) => ({
        key: `ENV_VAR_${i + 1}`,
        value: `value_${i + 1}`,
        isSecret: i % 3 === 0,
      }))}
      setupCommands={['npm install', 'npm run build', 'npm run test', 'npm run deploy']}
    />
  ),
};
