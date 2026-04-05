import { useQuery } from '@tanstack/react-query';
import { load } from 'js-yaml';
import * as z from 'zod';
import { OrganizationModeConfigSchema } from '@/lib/organizations/organization-types';
import type { OrganizationModeConfig } from '@/lib/organizations/organization-types';

// Schema for the mode config within the content field
const ModeConfigContentSchema = z.object({
  slug: z.string(),
  name: z.string(),
  roleDefinition: z.string(),
  whenToUse: z.string().optional(),
  description: z.string().optional(),
  customInstructions: z.string().optional(),
  groups: z.array(z.any()), // Validated by OrganizationModeConfigSchema
});

// Schema for individual template items in the YAML
const ModeTemplateYamlSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  content: z.string(),
  // Ignore author, tags, and source fields
});

// Schema for the entire YAML structure
const ModeTemplatesYamlSchema = z.object({
  items: z.array(ModeTemplateYamlSchema),
});

export type ModeTemplate = {
  id: string;
  name: string;
  description: string;
  config: OrganizationModeConfig & {
    slug: string;
    name: string;
  };
};

async function fetchModeTemplates(): Promise<ModeTemplate[]> {
  const response = await fetch('/api/marketplace/modes');
  if (!response.ok) {
    throw new Error(`Failed to fetch mode templates: ${response.statusText}`);
  }

  const yamlText = await response.text();
  const yamlParsed = load(yamlText);

  // Validate the YAML structure
  const yamlResult = ModeTemplatesYamlSchema.safeParse(yamlParsed);
  if (!yamlResult.success) {
    console.error('Failed to parse modes.yaml structure:', yamlResult.error);
    throw new Error('Invalid modes.yaml structure');
  }

  const templates: ModeTemplate[] = [];

  for (const item of yamlResult.data.items) {
    // Parse the content field which contains the actual mode config
    const contentYaml = load(item.content);

    // Validate the content structure
    const contentResult = ModeConfigContentSchema.safeParse(contentYaml);
    if (!contentResult.success) {
      console.error(`Failed to parse content for template ${item.id}:`, contentResult.error);
      continue;
    }

    // Validate the mode config
    const configResult = OrganizationModeConfigSchema.safeParse(contentResult.data);

    if (!configResult.success) {
      console.error(`Failed to validate config for template ${item.id}:`, configResult.error);
      continue;
    }

    templates.push({
      id: item.id,
      name: item.name,
      description: item.description,
      config: {
        ...configResult.data,
        slug: contentResult.data.slug,
        name: contentResult.data.name,
      },
    });
  }

  return templates;
}

export function useModeTemplates() {
  return useQuery({
    queryKey: ['mode-templates'],
    queryFn: fetchModeTemplates,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
  });
}
