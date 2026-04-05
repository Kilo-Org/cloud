/**
 * Test script to hit the AI Attribution Worker's /admin/attributions endpoint
 *
 * Usage:
 *   pnpm script:run ai-attribution test-admin-attributions <organization_id> <project_id> <file_path> [branch]
 *
 * Example:
 *   pnpm script:run ai-attribution test-admin-attributions org-123 my-project src/index.ts
 *   pnpm script:run ai-attribution test-admin-attributions org-123 my-project src/index.ts main
 */

import { getEnvVariable } from '@/lib/dotenvx';

const AI_ATTRIBUTION_SERVICE_URL = 'https://ai-attribution.kiloapps.io';

export async function run(
  organization_id?: string,
  project_id?: string,
  file_path?: string,
  branch?: string
): Promise<void> {
  if (!organization_id || !project_id || !file_path) {
    console.error(
      'Usage: pnpm script:run ai-attribution test-admin-attributions <organization_id> <project_id> <file_path> [branch]'
    );
    console.error('');
    console.error('Arguments:');
    console.error('  organization_id  - The organization ID');
    console.error('  project_id       - The project ID');
    console.error('  file_path        - The file path to query');
    console.error('  branch           - (optional) Filter by specific branch');
    process.exit(1);
  }

  const adminSecret = getEnvVariable('AI_ATTRIBUTION_ADMIN_SECRET');
  if (!adminSecret) {
    console.error('Error: AI_ATTRIBUTION_ADMIN_SECRET environment variable is not set');
    process.exit(1);
  }

  const url = new URL('/admin/attributions', AI_ATTRIBUTION_SERVICE_URL);
  url.searchParams.set('organization_id', organization_id);
  url.searchParams.set('project_id', project_id);
  url.searchParams.set('file_path', file_path);
  if (branch) {
    url.searchParams.set('branch', branch);
  }

  console.log('Request URL:', url.toString());
  console.log('');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-Admin-Secret': adminSecret,
    },
  });

  console.log('Response Status:', response.status, response.statusText);
  console.log('');

  const json = await response.json();
  console.log('Response Body:');
  console.log(JSON.stringify(json, null, 2));

  if (!response.ok) {
    process.exit(1);
  }
}
