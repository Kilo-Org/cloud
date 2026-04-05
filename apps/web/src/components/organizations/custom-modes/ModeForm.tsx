'use client';

import type { FormEvent } from 'react';
import { useState, useEffect } from 'react';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { OrganizationMode } from '@/lib/organizations/organization-modes';
import type { EditGroupConfig } from '@/lib/organizations/organization-types';
import { Save, FileText } from 'lucide-react';
import { useModeTemplates } from './useModeTemplates';

const availableGroups = [
  { value: 'read', label: 'Read Files' },
  { value: 'edit', label: 'Edit Files' },
  { value: 'browser', label: 'Use Browser' },
  { value: 'command', label: 'Run Commands' },
  { value: 'mcp', label: 'Use MCP' },
] as const;

const modeFormSchema = z.object({
  name: z
    .string()
    .min(1, 'Mode name is required')
    .max(100, 'Mode name must be less than 100 characters'),
  slug: z
    .string()
    .min(1, 'Mode slug is required')
    .max(50, 'Mode slug must be less than 50 characters')
    .regex(/^[a-z0-9-]+$/, 'Mode slug must contain only lowercase letters, numbers, and hyphens'),
  roleDefinition: z.string().min(1, 'Role definition is required'),
  description: z.string().optional(),
  whenToUse: z.string().optional(),
  groups: z.any(), // Will be validated separately
  customInstructions: z.string().optional(),
});

export type ModeFormData = z.infer<typeof modeFormSchema>;

type ModeFormProps = {
  mode?: OrganizationMode;
  onSubmit: (data: ModeFormData) => Promise<void>;
  isSubmitting: boolean;
  isEditingBuiltIn?: boolean;
  existingModes?: OrganizationMode[];
  onCancel?: () => void;
  renderButtons?: (props: { isDirty: boolean; isSubmitting: boolean }) => React.ReactNode;
};

// Helper to normalize groups from config to internal state
function normalizeGroups(groups: Array<string | ['edit', EditGroupConfig]>): {
  simpleGroups: string[];
  editConfig: EditGroupConfig | null;
} {
  const simpleGroups: string[] = [];
  let editConfig: EditGroupConfig | null = null;

  for (const group of groups) {
    if (Array.isArray(group) && group[0] === 'edit') {
      simpleGroups.push('edit');
      editConfig = group[1];
    } else if (typeof group === 'string') {
      simpleGroups.push(group);
    }
  }

  return { simpleGroups, editConfig };
}

// Helper to convert internal state back to config format
function denormalizeGroups(
  simpleGroups: string[],
  editConfig: EditGroupConfig | null
): Array<string | ['edit', EditGroupConfig]> {
  return simpleGroups.map(group => {
    if (group === 'edit' && editConfig && editConfig.fileRegex) {
      return ['edit', editConfig];
    }
    return group;
  });
}

export function ModeForm({
  mode,
  onSubmit,
  isSubmitting,
  isEditingBuiltIn = false,
  existingModes = [],
  onCancel,
  renderButtons,
}: ModeFormProps) {
  const [formData, setFormData] = useState({
    name: mode?.name || '',
    slug: mode?.slug || '',
    roleDefinition: mode?.config?.roleDefinition || '',
    description: mode?.config?.description || '',
    whenToUse: mode?.config?.whenToUse || '',
    customInstructions: mode?.config?.customInstructions || '',
  });
  const [selectedGroups, setSelectedGroups] = useState<string[]>(() => {
    const { simpleGroups } = normalizeGroups(mode?.config?.groups || []);
    return simpleGroups;
  });
  const [editGroupConfig, setEditGroupConfig] = useState<EditGroupConfig>(() => {
    const { editConfig } = normalizeGroups(mode?.config?.groups || []);
    return editConfig || { fileRegex: '', description: '' };
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [initialFormData, setInitialFormData] = useState({
    name: mode?.name || '',
    slug: mode?.slug || '',
    roleDefinition: mode?.config?.roleDefinition || '',
    description: mode?.config?.description || '',
    whenToUse: mode?.config?.whenToUse || '',
    customInstructions: mode?.config?.customInstructions || '',
  });
  const [initialGroups, setInitialGroups] = useState<string[]>(() => {
    const { simpleGroups } = normalizeGroups(mode?.config?.groups || []);
    return simpleGroups;
  });
  const [initialEditConfig, setInitialEditConfig] = useState<EditGroupConfig>(() => {
    const { editConfig } = normalizeGroups(mode?.config?.groups || []);
    return editConfig || { fileRegex: '', description: '' };
  });
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');

  // Fetch mode templates
  const { data: templates, isLoading: templatesLoading } = useModeTemplates();

  // Update form data when mode prop changes
  useEffect(() => {
    if (mode) {
      const newFormData = {
        name: mode.name || '',
        slug: mode.slug || '',
        roleDefinition: mode.config?.roleDefinition || '',
        description: mode.config?.description || '',
        whenToUse: mode.config?.whenToUse || '',
        customInstructions: mode.config?.customInstructions || '',
      };
      const { simpleGroups, editConfig } = normalizeGroups(mode.config?.groups || []);
      const newEditConfig = editConfig || { fileRegex: '', description: '' };

      setFormData(newFormData);
      setSelectedGroups(simpleGroups);
      setEditGroupConfig(newEditConfig);
      setInitialFormData(newFormData);
      setInitialGroups(simpleGroups);
      setInitialEditConfig(newEditConfig);
    }
  }, [mode]);

  // Check if form is dirty (has changes)
  const isDirty =
    formData.name !== initialFormData.name ||
    formData.slug !== initialFormData.slug ||
    formData.roleDefinition !== initialFormData.roleDefinition ||
    formData.description !== initialFormData.description ||
    formData.whenToUse !== initialFormData.whenToUse ||
    formData.customInstructions !== initialFormData.customInstructions ||
    JSON.stringify(selectedGroups.sort()) !== JSON.stringify(initialGroups.sort()) ||
    editGroupConfig.fileRegex !== initialEditConfig.fileRegex ||
    editGroupConfig.description !== initialEditConfig.description;

  // Auto-generate slug from name for new modes
  useEffect(() => {
    if (!mode && formData.name) {
      const slug = formData.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      setFormData(prev => ({ ...prev, slug }));
    }
  }, [formData.name, mode]);

  const handleGroupToggle = (group: string) => {
    setSelectedGroups(prev =>
      prev.includes(group) ? prev.filter(g => g !== group) : [...prev, group]
    );
  };

  const handleTemplateSelect = (templateId: string) => {
    setSelectedTemplate(templateId);

    if (!templateId) return;

    const template = templates?.find(t => t.id === templateId);
    if (!template) return;

    // Populate form with template data
    const newFormData = {
      name: template.config.name,
      slug: template.config.slug,
      roleDefinition: template.config.roleDefinition || '',
      description: template.config.description || '',
      whenToUse: template.config.whenToUse || '',
      customInstructions: template.config.customInstructions || '',
    };

    const { simpleGroups, editConfig } = normalizeGroups(template.config.groups || []);
    const newEditConfig = editConfig || { fileRegex: '', description: '' };

    setFormData(newFormData);
    setSelectedGroups(simpleGroups);
    setEditGroupConfig(newEditConfig);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});

    // Validate edit config if edit is selected and regex is provided
    const newErrors: Record<string, string> = {};
    if (selectedGroups.includes('edit') && editGroupConfig.fileRegex) {
      try {
        new RegExp(editGroupConfig.fileRegex);
      } catch {
        newErrors.editFileRegex = 'Invalid regular expression';
      }
    }

    // Check for duplicate slug
    const duplicateMode = existingModes.find(
      existingMode => existingMode.slug === formData.slug && existingMode.id !== mode?.id
    );
    if (duplicateMode) {
      newErrors.slug = `A mode with the slug "${formData.slug}" already exists`;
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    const groups = denormalizeGroups(
      selectedGroups,
      selectedGroups.includes('edit') && editGroupConfig.fileRegex ? editGroupConfig : null
    );

    const result = modeFormSchema.safeParse({
      ...formData,
      groups,
    });

    if (!result.success) {
      result.error.issues.forEach(issue => {
        if (issue.path[0]) {
          newErrors[issue.path[0].toString()] = issue.message;
        }
      });
      setErrors(newErrors);
      return;
    }

    await onSubmit(result.data);
  };

  const defaultButtons = (
    <>
      {onCancel && (
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
      )}
      <Button type="submit" variant="primary" disabled={isSubmitting || !isDirty}>
        <Save className="mr-2 h-4 w-4" />
        {isSubmitting ? 'Saving...' : mode ? 'Update Mode' : 'Create Mode'}
      </Button>
    </>
  );

  return (
    <form id="mode-form" onSubmit={handleSubmit}>
      <div className="space-y-6">
        {!mode && (
          <div className="flex items-center gap-2">
            <Label htmlFor="template-select" className="text-muted-foreground text-sm">
              Start from template:
            </Label>
            <Select
              value={selectedTemplate}
              onValueChange={handleTemplateSelect}
              disabled={templatesLoading || isSubmitting || !templates?.length}
            >
              <SelectTrigger id="template-select" className="w-[280px]">
                <SelectValue
                  placeholder={
                    templatesLoading
                      ? 'Loading templates...'
                      : templates?.length
                        ? 'Choose a template...'
                        : 'No templates available'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {templates?.map(template => (
                  <SelectItem key={template.id} value={template.id}>
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      <span>{template.name}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-6">
          {/* Mode Name */}
          <div className="space-y-2">
            <Label htmlFor="name">Mode Name</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
              placeholder="e.g., Code"
              disabled={isSubmitting || isEditingBuiltIn}
            />
            {isEditingBuiltIn && (
              <p className="text-muted-foreground text-xs">Built-in mode names cannot be changed</p>
            )}
            {errors.name && <p className="text-sm text-red-600">{errors.name}</p>}
          </div>

          {/* Mode Slug */}
          <div className="space-y-2">
            <Label htmlFor="slug">Mode Slug</Label>
            <Input
              id="slug"
              value={formData.slug}
              onChange={e => setFormData(prev => ({ ...prev, slug: e.target.value }))}
              placeholder="e.g., code"
              disabled={isSubmitting || isEditingBuiltIn}
            />
            <p className="text-muted-foreground text-xs">
              {isEditingBuiltIn
                ? 'Built-in mode slugs cannot be changed'
                : 'Unique identifier for this mode.'}
            </p>
            {errors.slug && <p className="text-sm text-red-600">{errors.slug}</p>}
          </div>

          {/* Role Definition */}
          <div className="space-y-2">
            <Label htmlFor="roleDefinition">Role Definition</Label>
            <Textarea
              id="roleDefinition"
              value={formData.roleDefinition}
              onChange={e => setFormData(prev => ({ ...prev, roleDefinition: e.target.value }))}
              placeholder="Define Kilo Code's expertise and personality for this mode. This description shapes how Kilo Code presents itself and approaches tasks."
              rows={6}
              disabled={isSubmitting}
            />
            <p className="text-muted-foreground text-xs">
              Define Kilo Code's expertise and personality for this mode
            </p>
            {errors.roleDefinition && (
              <p className="text-sm text-red-600">{errors.roleDefinition}</p>
            )}
          </div>

          {/* Short Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Short description (for humans)</Label>
            <Input
              id="description"
              value={formData.description}
              onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
              placeholder="A brief description shown in the mode selector dropdown"
              disabled={isSubmitting}
            />
            <p className="text-muted-foreground text-xs">
              A brief description shown in the mode selector dropdown
            </p>
          </div>

          {/* When to Use */}
          <div className="space-y-2">
            <Label htmlFor="whenToUse">When to Use (optional)</Label>
            <Textarea
              id="whenToUse"
              value={formData.whenToUse}
              onChange={e => setFormData(prev => ({ ...prev, whenToUse: e.target.value }))}
              placeholder="Guidance for Kilo Code for when this mode should be used. This helps the Orchestrator choose the right mode for a task."
              rows={4}
              disabled={isSubmitting}
            />
            <p className="text-muted-foreground text-xs">
              Guidance for Kilo Code for when this mode should be used
            </p>
          </div>

          {/* Mode-specific Custom Instructions */}
          <div className="space-y-2">
            <Label htmlFor="customInstructions">Mode-specific Custom Instructions (optional)</Label>
            <Textarea
              id="customInstructions"
              value={formData.customInstructions}
              onChange={e => setFormData(prev => ({ ...prev, customInstructions: e.target.value }))}
              placeholder="Add behavioral guidelines specific to this mode..."
              rows={6}
              disabled={isSubmitting}
            />
            <p className="text-muted-foreground text-xs">
              Add behavioral guidelines specific to this mode
            </p>
          </div>

          {/* Available Tools */}
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-medium">Available Tools</h3>
              <p className="text-muted-foreground mt-1 text-xs">
                Select which tools this mode can access
              </p>
            </div>
            <div className="space-y-4">
              {availableGroups.map(group => (
                <div key={group.value} className="space-y-3">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id={group.value}
                      checked={selectedGroups.includes(group.value)}
                      onCheckedChange={() => handleGroupToggle(group.value)}
                      disabled={isSubmitting}
                    />
                    <label
                      htmlFor={group.value}
                      className="text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                    >
                      {group.label}
                    </label>
                  </div>

                  {/* Edit Group Configuration */}
                  {group.value === 'edit' && selectedGroups.includes('edit') && (
                    <div className="border-muted ml-6 space-y-3 rounded-md border p-4">
                      <div className="space-y-2">
                        <Label htmlFor="editFileRegex" className="text-xs">
                          File Restriction (optional)
                        </Label>
                        <Input
                          id="editFileRegex"
                          value={editGroupConfig.fileRegex}
                          onChange={e =>
                            setEditGroupConfig(prev => ({
                              ...prev,
                              fileRegex: e.target.value,
                            }))
                          }
                          placeholder="e.g., \.md$ for markdown files only"
                          disabled={isSubmitting}
                          className="font-mono text-sm"
                        />
                        <p className="text-muted-foreground text-xs">
                          Regular expression to restrict which files can be edited
                        </p>
                        {errors.editFileRegex && (
                          <p className="text-sm text-red-600">{errors.editFileRegex}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="editDescription" className="text-xs">
                          Restriction Description (optional)
                        </Label>
                        <Input
                          id="editDescription"
                          value={editGroupConfig.description || ''}
                          onChange={e =>
                            setEditGroupConfig(prev => ({
                              ...prev,
                              description: e.target.value,
                            }))
                          }
                          placeholder="e.g., Markdown files only"
                          disabled={isSubmitting}
                        />
                        <p className="text-muted-foreground text-xs">
                          Human-readable description of the file restriction
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Render buttons if custom renderer provided, otherwise use default */}
      {!renderButtons && (
        <div className="mt-6 flex items-center justify-end gap-4">{defaultButtons}</div>
      )}
    </form>
  );
}
