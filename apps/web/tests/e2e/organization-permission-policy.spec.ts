import { expect, test } from '@chromatic-com/playwright';
import type { Locator, Page, TestInfo } from '@playwright/test';
import type { OrganizationPermissionPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
import { readFile } from 'node:fs/promises';
import { permissionPolicyTest } from './organization-permission-policy-fixture';

const organizationId = '9d278969-5453-4ae3-a51f-a8d2274a7b56';

test.describe('organization permission policy API', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('authenticates before conditional policy validation', async ({ request }) => {
    const response = await request.get(`/api/organizations/${organizationId}/policy/permission`, {
      headers: { 'If-None-Match': '*' },
    });

    expect(response.status()).toBe(401);
    expect(response.headers()['cache-control']).toBe('private, no-store');
    expect(response.headers().etag).toBeUndefined();
  });
});

const trialConfig = `{
  // Synthetic local trial configuration; the importer must not include provider settings.
  "provider": { "example": { "options": { "baseURL": "https://provider.example.com" } } },
  "permission": {
    "websearch": "deny",
    "external_directory": { "/workspace/shared/*": "allow" },
    "bash": { "*": "deny", "git status*": "allow", "git diff*": "allow" },
  },
}`;

const defaultAgentPolicy = {
  type: 'agent_permissions',
  data: {
    schema_version: 1,
    tools: {
      websearch: 'deny',
      external_directory: {
        rules: [{ pattern: '/workspace/shared/*', action: 'allow' }],
        fallback: 'ask',
      },
    },
    shell: {
      bash: {
        fallback: 'ask',
        rules: [
          { pattern: '*', action: 'deny' },
          { pattern: 'git status*', action: 'allow' },
          { pattern: 'git diff*', action: 'allow' },
        ],
      },
    },
  },
} satisfies OrganizationPermissionPolicy;

const groupAgentPolicy = {
  type: 'agent_permissions',
  data: {
    schema_version: 1,
    tools: {
      external_directory: {
        rules: [{ pattern: '/workspace/shared/private/*', action: 'deny' }],
        fallback: 'deny',
      },
    },
  },
} satisfies OrganizationPermissionPolicy;

const clientPolicy = {
  type: 'client_access',
  data: {
    schema_version: 1,
    mode: 'allowlist',
    clients: [{ feature: 'cli', min_version: '7.2.1' }],
  },
} satisfies OrganizationPermissionPolicy;

const button = (scope: Page | Locator, name: string) =>
  scope.getByRole('button', { name, exact: true });
const groupsPath = (organization: { id: string }) => `/organizations/${organization.id}/groups`;

async function savePolicy(drawer: Locator) {
  await button(drawer, 'Save policy').click();
  await expect(
    drawer.getByRole('heading', { name: 'Permission policies', exact: true })
  ).toBeVisible();
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await expect(button(page.getByRole('dialog'), 'Close drawer')).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path,
    animations: 'disabled',
    style: '[data-sonner-toaster] { visibility: hidden; }',
  });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

permissionPolicyTest.describe('Enterprise permission policy editor', () => {
  permissionPolicyTest.use({ storageState: { cookies: [], origins: [] } });
  permissionPolicyTest.skip(
    process.env.E2E_ORGANIZATION_PERMISSION_POLICY !== 'true',
    'Requires the isolated Enterprise permission policy E2E invocation.'
  );

  permissionPolicyTest(
    'reviews a local policy, saves organization and group restrictions, and inspects member sources',
    { tag: '@permission-policy-write' },
    async ({ page, permissionFixture }, testInfo) => {
      permissionPolicyTest.setTimeout(180_000);
      const {
        admin,
        member,
        managed,
        disabled,
        group,
        disabledGroup,
        readDefault,
        readGroupPolicies,
      } = permissionFixture;
      const drawer = page.getByRole('dialog', { name: 'Drawer panel' });
      const resource = drawer.getByRole('group', { name: 'external_directory' });
      const agentPermissions = drawer.getByRole('button', { name: /^Agent permissions\b/ });
      const unmatched = resource.getByLabel('Unmatched calls');
      const save = button(drawer, 'Save policy');
      const managedPath = groupsPath(managed);
      const signIn = new URLSearchParams({ fakeUser: admin.email, callbackPath: managedPath });
      await page.goto(`/users/sign_in?${signIn}`);
      await page.waitForURL(url => url.pathname === managedPath, { timeout: 60_000 });
      const initial = await readDefault();

      await permissionPolicyTest.step(
        'Review local JSONC and explicitly choose a shell and fallback',
        async () => {
          await button(page, 'Default permissions').click();
          await agentPermissions.click();
          await button(drawer, 'Import JSON/JSONC').click();
          await drawer.getByLabel('Configuration JSON or JSONC').fill(trialConfig);
          await expect(save).toBeDisabled();
          await button(drawer, 'Preview import').click();
          const preview = drawer.getByLabel('Policy preview');
          await expect(preview.getByText(/other configuration fields were ignored/i)).toBeVisible();
          await expect(preview).not.toContainText('provider.example.com');
          const importShell = drawer.getByLabel('Shell for imported commands');
          const importFallback = drawer.getByLabel('Unlisted commands for imported shell');
          const useDraft = button(drawer, 'Use in editor');
          await expect(importShell).toHaveValue('');
          await expect(importFallback).toHaveValue('');
          await expect(useDraft).toBeDisabled();
          await importShell.selectOption('bash');
          await expect(importFallback).toHaveValue('');
          await expect(useDraft).toBeDisabled();
          await importFallback.selectOption('ask');
          await expect(useDraft).toBeEnabled();
          await useDraft.click();
          await expect(unmatched).toHaveValue('inherit');
          expect(await readDefault()).toEqual(initial);
        }
      );

      const defaultRevision = await permissionPolicyTest.step(
        'Validate an advanced JSON change and verify the default after reload',
        async () => {
          await button(drawer, 'Edit JSON').click();
          const json = drawer.getByLabel('Policy JSON');
          const imported = {
            ...defaultAgentPolicy,
            data: {
              ...defaultAgentPolicy.data,
              tools: {
                ...defaultAgentPolicy.data.tools,
                external_directory: {
                  rules: defaultAgentPolicy.data.tools.external_directory.rules,
                },
              },
            },
          };
          expect(JSON.parse(await json.inputValue())).toEqual(imported);
          await json.fill(JSON.stringify(defaultAgentPolicy, null, 2));
          await button(drawer, 'Validate JSON').click();
          await button(drawer, 'Use in editor').click();
          await expect(unmatched).toHaveValue('ask');
          await savePolicy(drawer);
          const persisted = await readDefault();
          if (!persisted) throw new Error('Saving did not create organization policy settings.');
          expect(persisted.default_policies).toContainEqual(defaultAgentPolicy);

          await page.reload();
          await button(page, 'Default permissions').click();
          await agentPermissions.click();
          await expect(unmatched).toHaveValue('ask');
          await drawer.getByRole('tab', { name: 'Shell', exact: true }).click();
          const bash = drawer.getByRole('group', { name: 'Bash', exact: true });
          await expect(bash.getByLabel('Unlisted commands')).toHaveValue('ask');
          await expect(bash.getByLabel('Command pattern 1')).toHaveValue('*');
          await expect(bash.getByLabel('Command pattern 2')).toHaveValue('git status*');
          await expect(bash.getByLabel('Command pattern 3')).toHaveValue('git diff*');
          const [download] = await Promise.all([
            page.waitForEvent('download'),
            button(drawer, 'Export JSON').click(),
          ]);
          expect(download.suggestedFilename()).toBe('agent_permissions.json');
          expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toEqual(
            defaultAgentPolicy
          );
          await capture(page, testInfo, 'managed-agent-permissions');
          await button(drawer, 'Back').click();
          return persisted.policy_revision;
        }
      );

      await permissionPolicyTest.step(
        'Save strict client access with a valid minimum version',
        async () => {
          await drawer.getByRole('button', { name: /^Client access\b/ }).click();
          const mode = drawer.getByLabel('Client access mode');
          await mode.selectOption('allowlist');
          await expect(
            drawer.getByText(/allowlist denies unknown and unlisted clients/i)
          ).toBeVisible();
          await expect(drawer.getByText(/empty allowlist blocks every client/i)).toBeVisible();
          await button(drawer, 'Add client').click();
          await drawer.getByLabel('Client 1', { exact: true }).selectOption('cli');
          const minimumVersion = drawer.getByLabel('Minimum version 1');
          await minimumVersion.fill('latest');
          await expect(save).toBeDisabled();
          await mode.selectOption('blocklist');
          await expect(minimumVersion).toBeHidden();
          await mode.selectOption('allowlist');
          await expect(minimumVersion).toHaveValue('');
          await minimumVersion.fill('7.2.1');
          await savePolicy(drawer);
          expect((await readDefault())?.default_policies).toContainEqual(clientPolicy);
          await button(drawer, 'Close drawer').click();
        }
      );

      await permissionPolicyTest.step(
        'Set an explicit group resource default in the narrow drawer',
        async () => {
          await page.setViewportSize({ width: 390, height: 844 });
          await button(page, `Permissions for ${group.name}`).click();
          await agentPermissions.click();
          await expect(
            resource.getByText(/Organization default: Require approval\./)
          ).toBeVisible();
          await resource.getByLabel('Tool decision').selectOption('rules');
          await expect(unmatched).toHaveValue('inherit');
          await button(resource, 'Add rule').click();
          await resource.getByLabel('Resource pattern 1').fill('/workspace/shared/private/*');
          await unmatched.selectOption('deny');
          await expect(unmatched).toHaveValue('deny');
          await save.scrollIntoViewIfNeeded();
          await expect(save).toBeInViewport();
          await capture(page, testInfo, 'managed-group-permissions-mobile');
          await savePolicy(drawer);
          expect(await readGroupPolicies()).toEqual([groupAgentPolicy]);
          await button(drawer, 'Close drawer').click();
        }
      );

      await permissionPolicyTest.step(
        'Inspect revision and actual default and group sources',
        async () => {
          await page.setViewportSize({ width: 1440, height: 980 });
          const saved = await readDefault();
          const expectedRevision = defaultRevision + 2;
          expect(saved?.policy_revision).toBe(expectedRevision);
          expect(saved?.default_policies.filter(policy => policy.type !== 'model_access')).toEqual([
            defaultAgentPolicy,
            clientPolicy,
          ]);
          await button(page, 'Inspect member policy').click();
          const memberSelect = drawer.getByLabel('Member', { exact: true });
          await memberSelect.selectOption(member.id);
          await expect(
            drawer.getByText(`Revision ${expectedRevision}`, { exact: true })
          ).toBeVisible();
          await expect(drawer.getByText('Organization default', { exact: true })).toBeVisible();
          await expect(drawer.getByText(group.name, { exact: true })).toBeVisible();
          await expect(
            drawer.getByText(`Revision ${expectedRevision}`, { exact: true })
          ).toBeInViewport({ ratio: 1 });
          await capture(page, testInfo, 'managed-member-policy-sources');
          const effective = drawer.getByText('Effective policy JSON', { exact: true });
          await effective.click();
          const policy = JSON.parse(await drawer.locator('details[open] pre').innerText());
          expect(policy).toEqual({
            agent_permissions: {
              layers: expect.arrayContaining([defaultAgentPolicy.data, groupAgentPolicy.data]),
            },
            client_access: { layers: [clientPolicy.data] },
          });
          expect(policy.agent_permissions.layers).toHaveLength(2);
          await memberSelect.selectOption(admin.id);
          await expect(drawer.getByText('No group policy contributions.')).toBeVisible();
          await expect(drawer.getByText('Organization default', { exact: true })).toBeVisible();
          await expect(drawer.getByText(group.name, { exact: true })).toBeHidden();
        }
      );

      await permissionPolicyTest.step(
        'Leave the disabled Enterprise tenant on its existing Groups UI',
        async () => {
          const [settings] = await Promise.all([
            page.waitForResponse(response =>
              response.url().includes('organizations.groups.adminPermissionPolicy.settings')
            ),
            page.goto(groupsPath(disabled)),
          ]);
          expect(await settings.json()).toContainEqual({
            result: {
              data: {
                managed: false,
                writesEnabled: false,
                policies: [],
                policyRevision: expect.any(Number),
              },
            },
          });
          await expect(button(page, 'Manage defaults')).toBeVisible();
          await expect(page.getByText(disabledGroup.name, { exact: true })).toBeVisible();
          await expect(button(page, 'Default permissions')).toHaveCount(0);
          await expect(button(page, 'Inspect member policy')).toHaveCount(0);
          await expect(button(page, `Permissions for ${disabledGroup.name}`)).toHaveCount(0);
        }
      );
    }
  );
});
