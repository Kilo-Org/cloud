import { expect, test } from '@chromatic-com/playwright';
import type { Locator, Page, TestInfo } from '@playwright/test';
import type { OrganizationPermissionPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
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
  "autoApprove": true,
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
    unrestricted_mode: 'deny',
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

const restrictiveDefaultAgentPolicy = {
  ...defaultAgentPolicy,
  data: { ...defaultAgentPolicy.data, auto_approve: 'deny' },
} satisfies OrganizationPermissionPolicy;

const groupAgentPolicy = {
  type: 'agent_permissions',
  data: {
    schema_version: 1,
    auto_approve: 'deny',
    tools: {
      external_directory: {
        rules: [{ pattern: '/workspace/shared/private/*', action: 'deny' }],
        fallback: 'deny',
      },
    },
  },
} satisfies OrganizationPermissionPolicy;

const neutralGroupAgentPolicy = {
  type: 'agent_permissions',
  data: { schema_version: 1, tools: { edit: 'ask' } },
} satisfies OrganizationPermissionPolicy;

const retiredClientPolicy = {
  type: 'client_access',
  data: {
    schema_version: 1,
    mode: 'allowlist',
    clients: [{ feature: 'cli', min_version: '7.2.1' }],
  },
};

const button = (scope: Page | Locator, name: string) =>
  scope.getByRole('button', { name, exact: true });
const groupsPath = (organization: { id: string }) => `/organizations/${organization.id}/groups`;
const autoApproveLabel = 'Auto-approve for managed actions';
const autoApproveSummary = 'Auto-approve disabled for managed actions';

async function signInAs(page: Page, email: string, callbackPath: string) {
  const signIn = new URLSearchParams({ fakeUser: email, callbackPath });
  await page.goto(`/users/sign_in?${signIn}`);
  await page.waitForURL(url => url.pathname === callbackPath, { timeout: 60_000 });
}

async function savePolicy(drawer: Locator, revision: number) {
  const save = button(drawer, 'Save policy');
  await save.click();
  await expect(drawer.getByText(`Revision ${revision}`, { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(button(drawer, 'Back')).toHaveCount(0);
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
    async ({ baseURL, browser, page, permissionFixture }, testInfo) => {
      permissionPolicyTest.setTimeout(180_000);
      const {
        admin,
        member,
        ungroupedMember,
        managed,
        disabled,
        group,
        neutralGroup,
        disabledGroup,
        readDefault,
        readGroupPolicies,
      } = permissionFixture;
      const drawer = page.getByRole('dialog', { name: 'Drawer panel' });
      const agentHeading = drawer.getByRole('heading', { name: 'Agent permissions', exact: true });
      const defaultPermissions = button(page, 'Default permissions');
      const groupPermissions = button(page, `Permissions for ${group.name}`);
      const neutralGroupPermissions = button(page, `Permissions for ${neutralGroup.name}`);
      const inspectMemberPolicy = button(page, 'Inspect member policy');
      const memberSelect = drawer.getByLabel('Member', { exact: true });
      const autoApprove = drawer.getByLabel(autoApproveLabel, { exact: true });
      const autoApproveStatus = drawer
        .locator('dl')
        .filter({
          has: page.getByRole('term').and(page.getByText(autoApproveLabel, { exact: true })),
        })
        .getByRole('definition');
      const policySource = (name: string) =>
        drawer.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
      const defaultSource = policySource('Organization default');
      const tool = drawer.getByLabel('Tool', { exact: true });
      const resource = drawer.getByRole('group', { name: 'external_directory' });
      const unmatched = resource.getByLabel('Unmatched calls');
      const editDecision = drawer
        .getByRole('group', { name: 'edit', exact: true })
        .getByLabel('Tool decision');
      const save = button(drawer, 'Save policy');
      const managedPath = groupsPath(managed);
      await signInAs(page, admin.email, managedPath);

      const existingGroupRevision = ((await readDefault())?.policy_revision ?? 0) + 1;
      await permissionPolicyTest.step(
        'Save existing group decisions before tightening the organization default',
        async () => {
          const existingGroupPolicy = {
            type: 'agent_permissions',
            data: {
              schema_version: 1,
              unrestricted_mode: 'allow',
              tools: { websearch: 'ask' },
              shell: {
                powershell: {
                  fallback: 'ask',
                  rules: [{ pattern: 'Get-ChildItem*', action: 'allow' }],
                },
              },
            },
          } satisfies OrganizationPermissionPolicy;
          await groupPermissions.click();
          await expect(agentHeading).toBeVisible();
          await button(drawer, 'Edit JSON').click();
          await drawer.getByLabel('Policy JSON').fill(JSON.stringify(existingGroupPolicy, null, 2));
          await button(drawer, 'Validate JSON').click();
          await button(drawer, 'Use in editor').click();
          await savePolicy(drawer, existingGroupRevision);
          expect(await readGroupPolicies(group.id)).toEqual([existingGroupPolicy]);
          await button(drawer, 'Close drawer').click();
        }
      );

      const initial = await readDefault();
      const defaultRevision = existingGroupRevision + 1;
      const groupRevision = defaultRevision + 1;
      const neutralGroupRevision = groupRevision + 1;
      const groupRemovalRevision = neutralGroupRevision + 1;
      const restrictiveDefaultRevision = groupRemovalRevision + 1;

      await permissionPolicyTest.step(
        'Reject a retired policy and invalid tool key, then review local JSONC',
        async () => {
          await defaultPermissions.click();
          await expect(agentHeading).toBeVisible();
          await expect(drawer.getByRole('button', { name: /^Client access\b/i })).toHaveCount(0);
          await expect(drawer.getByLabel('Client access mode')).toHaveCount(0);

          await tool.selectOption('websearch');
          await drawer.getByLabel('Custom tool key').fill('__proto__');
          await button(drawer, 'Select tool').click();
          await expect(drawer.getByRole('alert')).toHaveText('Enter a valid tool key.');
          await expect(tool).toHaveValue('websearch');

          await button(drawer, 'Import JSON/JSONC').click();
          const config = drawer.getByLabel('Configuration JSON or JSONC');
          const previewImport = button(drawer, 'Preview import');
          const preview = drawer.getByLabel('Policy preview');
          const useDraft = button(drawer, 'Use in editor');
          await config.fill(JSON.stringify(retiredClientPolicy, null, 2));
          await previewImport.click();
          await expect(drawer.getByRole('alert')).toContainText(
            'Expected an agent_permissions policy document.'
          );
          await expect(preview).toHaveCount(0);
          await expect(useDraft).toHaveCount(0);
          await expect(save).toBeDisabled();

          await config.fill(trialConfig);
          await previewImport.click();
          await expect(preview.getByText(/other configuration fields were ignored/i)).toBeVisible();
          await expect(preview).not.toContainText('provider.example.com');
          await expect(preview).not.toContainText(/autoApprove|auto_approve/);
          const importShell = drawer.getByLabel('Shell for imported commands');
          const importFallback = drawer.getByLabel('Unlisted commands for imported shell');
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
          await expect(autoApprove).toHaveValue('inherit');
          expect(await readDefault()).toEqual(initial);
        }
      );

      await permissionPolicyTest.step(
        'Validate an advanced JSON change and verify the default after reload',
        async () => {
          await drawer.getByLabel('Unrestricted mode').selectOption('deny');
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
          await savePolicy(drawer, defaultRevision);
          const persisted = await readDefault();
          expect(persisted?.policy_revision).toBe(defaultRevision);
          expect(persisted?.default_policies).toContainEqual(defaultAgentPolicy);

          await page.reload();
          await defaultPermissions.click();
          await expect(agentHeading).toBeVisible();
          await expect(
            drawer.getByText(`Revision ${defaultRevision}`, { exact: true })
          ).toBeVisible();
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
          await button(drawer, 'Close drawer').click();
        }
      );

      await permissionPolicyTest.step(
        'Clear blocked group restrictions and save an explicit resource default in the narrow drawer',
        async () => {
          await page.setViewportSize({ width: 390, height: 844 });
          await groupPermissions.click();
          await expect(agentHeading).toBeVisible();

          const unrestricted = drawer.getByLabel('Unrestricted mode');
          await expect(unrestricted).toHaveValue('allow');
          await expect(
            unrestricted.getByRole('option', { name: 'Allow', exact: true })
          ).toBeDisabled();
          await unrestricted.selectOption('inherit');
          await expect(unrestricted).toBeDisabled();

          await expect(autoApprove).toHaveValue('inherit');
          await autoApprove.selectOption({ label: 'Disable auto-approve' });
          await expect(autoApprove).toHaveValue('deny');

          await tool.selectOption('websearch');
          const websearch = drawer.getByRole('group', { name: 'websearch', exact: true });
          await expect(websearch.getByText(/Organization default: Block\./)).toBeVisible();
          const decision = websearch.getByLabel('Tool decision');
          const inherit = { name: 'Use inherited policy', exact: true };
          await expect(decision).toHaveValue('ask');
          await expect(decision).toBeEnabled();
          await expect(decision.getByRole('option', inherit)).toBeEnabled();
          for (const name of ['Allow', 'Require approval', 'Block', 'Resource rules']) {
            await expect(decision.getByRole('option', { name, exact: true })).toBeDisabled();
          }
          await decision.selectOption({ label: inherit.name });
          await expect(decision).toHaveValue('inherit');

          await drawer.getByRole('tab', { name: 'Shell', exact: true }).click();
          const powerShell = drawer.getByRole('group', { name: 'PowerShell', exact: true });
          await expect(powerShell.getByLabel('Unlisted commands')).toBeDisabled();
          await expect(powerShell.getByLabel('Command pattern 1')).toBeDisabled();
          const removePowerShell = button(powerShell, 'Remove PowerShell profile');
          await expect(removePowerShell).toBeEnabled();
          await removePowerShell.click();
          await expect(removePowerShell).toHaveCount(0);
          const shellPolicy = drawer.getByLabel('Shell profile policy');
          await expect(shellPolicy).toHaveValue('configure');
          await shellPolicy.selectOption('inherit');
          await expect(shellPolicy).toHaveValue('inherit');

          await drawer.getByRole('tab', { name: 'Tools', exact: true }).click();
          await tool.selectOption('external_directory');
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
          await savePolicy(drawer, groupRevision);
          expect(await readGroupPolicies(group.id)).toEqual([groupAgentPolicy]);
          await button(drawer, 'Close drawer').click();
        }
      );

      await permissionPolicyTest.step(
        'Save a tool rule in the second group without adding an auto-approve restriction',
        async () => {
          await page.setViewportSize({ width: 1440, height: 980 });
          await neutralGroupPermissions.click();
          await expect(agentHeading).toBeVisible();
          await expect(autoApprove).toBeEnabled();
          await expect(autoApprove).toHaveValue('inherit');
          await tool.selectOption('edit');
          await editDecision.selectOption('ask');
          await savePolicy(drawer, neutralGroupRevision);
          expect(await readGroupPolicies(neutralGroup.id)).toEqual([neutralGroupAgentPolicy]);
          await button(drawer, 'Close drawer').click();
        }
      );

      const diagnosedPolicy = await permissionPolicyTest.step(
        'Inspect independent sources and see the restriction only for the grouped member',
        async () => {
          const saved = await readDefault();
          expect(saved?.policy_revision).toBe(neutralGroupRevision);
          expect(saved?.default_policies.filter(policy => policy.type !== 'model_access')).toEqual([
            defaultAgentPolicy,
          ]);
          await inspectMemberPolicy.click();
          await memberSelect.selectOption(member.id);
          const revision = drawer.getByText(`Revision ${neutralGroupRevision}`, { exact: true });
          await expect(revision).toBeVisible();
          await expect(autoApproveStatus).toHaveText('Disabled');
          await expect(defaultSource).toBeVisible();
          await expect(defaultSource).not.toContainText(autoApproveSummary);
          await expect(policySource(group.name)).toContainText(autoApproveSummary);
          await expect(policySource(neutralGroup.name)).toBeVisible();
          await expect(policySource(neutralGroup.name)).not.toContainText(autoApproveSummary);
          await expect(drawer.getByText(/client access/i)).toHaveCount(0);
          await expect(revision).toBeInViewport({ ratio: 1 });
          await capture(page, testInfo, 'managed-member-policy-sources');
          const effective = drawer.getByText('Effective policy JSON', { exact: true });
          await effective.click();
          const policy = JSON.parse(await drawer.locator('details[open] pre').innerText());
          const layers = [
            defaultAgentPolicy.data,
            groupAgentPolicy.data,
            neutralGroupAgentPolicy.data,
          ];
          expect(policy).toEqual({
            agent_permissions: { layers: expect.arrayContaining(layers) },
          });
          expect(policy.agent_permissions.layers).toHaveLength(layers.length);
          await memberSelect.selectOption(admin.id);
          await expect(autoApproveStatus).toHaveText('No organization restriction');
          await expect(drawer.getByText('No group policy contributions.')).toBeVisible();
          await expect(defaultSource).toBeVisible();
          await expect(policySource(group.name)).toHaveCount(0);
          await expect(policySource(neutralGroup.name)).toHaveCount(0);
          return policy;
        }
      );

      await permissionPolicyTest.step(
        'Retrieve the same anonymous layers with the grouped member’s credential',
        async () => {
          const memberContext = await browser.newContext({ baseURL });
          try {
            const memberPage = await memberContext.newPage();
            await signInAs(memberPage, member.email, managedPath);
            const organizationApi = new URL(`/api/organizations/${managed.id}/`, baseURL);
            const tokenUrl = new URL('user-tokens', organizationApi);
            const cookies = await memberContext.cookies(tokenUrl.href);
            const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
            // Keep the short-lived bearer out of Playwright's HTTP traces.
            const credential = await fetch(tokenUrl, {
              method: 'POST',
              headers: { Cookie: cookie },
              redirect: 'error',
              signal: AbortSignal.timeout(30_000),
            });
            expect(credential.status).toBe(200);
            const { token } = z.object({ token: z.string().min(1) }).parse(await credential.json());
            const response = await fetch(new URL('policy/permission', organizationApi), {
              headers: { Authorization: `Bearer ${token}` },
              redirect: 'error',
              signal: AbortSignal.timeout(30_000),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
              schema_version: 1,
              organization_id: managed.id,
              managed: true,
              revision: neutralGroupRevision,
              max_age_seconds: expect.any(Number),
              policy: diagnosedPolicy,
            });
          } finally {
            await memberContext.close();
          }
        }
      );

      await permissionPolicyTest.step(
        'Remove the group policy without changing the default',
        async () => {
          await button(drawer, 'Close drawer').click();
          await groupPermissions.click();
          await button(drawer, 'Remove policy').click();
          await button(drawer, 'Remove').click();
          await expect(
            drawer.getByText(`Revision ${groupRemovalRevision}`, { exact: true })
          ).toBeVisible();
          await expect(button(drawer, 'Remove policy')).toHaveCount(0);
          await expect(save).toBeDisabled();
          expect(await readGroupPolicies(group.id)).toEqual([]);
          expect(await readGroupPolicies(neutralGroup.id)).toEqual([neutralGroupAgentPolicy]);
          expect((await readDefault())?.default_policies).toContainEqual(defaultAgentPolicy);
          await button(drawer, 'Close drawer').click();
        }
      );

      await permissionPolicyTest.step(
        'Disable auto-approve at the organization default and verify the inherited lock',
        async () => {
          await defaultPermissions.click();
          await expect(autoApprove).toHaveValue('inherit');
          await autoApprove.selectOption('deny');
          await savePolicy(drawer, restrictiveDefaultRevision);
          expect((await readDefault())?.default_policies).toContainEqual(
            restrictiveDefaultAgentPolicy
          );
          await button(drawer, 'Close drawer').click();

          await neutralGroupPermissions.click();
          await expect(autoApprove).toHaveValue('inherit');
          await expect(autoApprove).toBeDisabled();
          await expect(autoApprove).toHaveAccessibleDescription(
            /^Disabled by the organization default\./
          );
          await tool.selectOption('edit');
          await expect(editDecision).toHaveValue('ask');
          await expect(autoApprove).toBeInViewport({ ratio: 1 });
          await capture(page, testInfo, 'managed-auto-approve-inherited');
          await button(drawer, 'Close drawer').click();

          await inspectMemberPolicy.click();
          for (const { id } of [admin, ungroupedMember]) {
            await memberSelect.selectOption(id);
            await expect(
              drawer.getByText(`Revision ${restrictiveDefaultRevision}`, { exact: true })
            ).toBeVisible();
            await expect(autoApproveStatus).toHaveText('Disabled');
            await expect(defaultSource).toContainText(autoApproveSummary);
            await expect(drawer.getByText('No group policy contributions.')).toBeVisible();
          }
          await button(drawer, 'Close drawer').click();
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
