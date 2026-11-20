import { expect, test } from '@chromatic-com/playwright';
import type { Locator, Page, TestInfo } from '@playwright/test';
import type {
  OrganizationPermissionPolicy,
  PermissionPolicyExecutionOs,
} from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
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

const allOsAgentPolicy = {
  ...defaultAgentPolicy,
  data: {
    ...defaultAgentPolicy.data,
    tools: { ...defaultAgentPolicy.data.tools, browser_open: 'ask' },
  },
} satisfies OrganizationPermissionPolicy;

const windowsPermissions = { tools: { browser_open: 'deny' } } as const;
const osScopedDefaultAgentPolicy = {
  ...allOsAgentPolicy,
  data: { ...allOsAgentPolicy.data, by_os: { windows: windowsPermissions } },
} satisfies OrganizationPermissionPolicy;

const restrictiveDefaultAgentPolicy = {
  ...osScopedDefaultAgentPolicy,
  data: { ...osScopedDefaultAgentPolicy.data, auto_approve: 'deny' },
} satisfies OrganizationPermissionPolicy;

const groupAgentPolicy = {
  type: 'agent_permissions',
  data: {
    schema_version: 1,
    auto_approve: 'deny',
    tools: {
      browser_open: 'allow',
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

const hiddenDollarValuesPolicy = {
  type: 'client_configuration',
  data: { schema_version: 1, show_session_dollar_values: false },
} satisfies OrganizationPermissionPolicy;

const visibleDollarValuesPolicy = {
  ...hiddenDollarValuesPolicy,
  data: { ...hiddenDollarValuesPolicy.data, show_session_dollar_values: true },
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
    'authors organization and group policies and verifies delivered member layers by OS',
    { tag: '@permission-policy-write' },
    async ({ baseURL, browser, page, permissionFixture }, testInfo) => {
      permissionPolicyTest.setTimeout(300_000);
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
      const diagnosticValue = (label: string) =>
        drawer
          .locator('dl')
          .filter({ has: page.getByRole('term').and(page.getByText(label, { exact: true })) })
          .getByRole('definition');
      const autoApproveStatus = diagnosticValue(autoApproveLabel);
      const dollarVisibility = diagnosticValue('Session dollar visibility');
      const policySource = (name: string) =>
        drawer.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
      const defaultSource = policySource('Organization default');
      const permissionSet = drawer.getByRole('combobox', { name: 'Permission set', exact: true });
      const executionOs = drawer.getByRole('combobox', { name: 'Execution OS', exact: true });
      const addWindows = button(drawer, 'Add Windows permissions');
      const removeWindows = button(drawer, 'Remove Windows permissions');
      const clientConfiguration = drawer.getByRole('tab', {
        name: 'Client Configuration',
        exact: true,
      });
      const showDollarValues = drawer.getByRole('switch', {
        name: 'Show session dollar values',
        exact: true,
      });
      const tool = drawer.getByLabel('Tool', { exact: true });
      const browserPermission = drawer.getByRole('group', { name: 'browser_open', exact: true });
      const browserDecision = browserPermission.getByLabel('Tool decision');
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
              tools: { websearch: 'ask', browser_open: 'allow' },
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
      const hiddenGroupRevision = neutralGroupRevision + 1;
      const groupConfigurationRevision = hiddenGroupRevision + 1;
      const groupRemovalRevision = groupConfigurationRevision + 1;
      const restrictiveDefaultRevision = groupRemovalRevision + 1;
      const hiddenDefaultRevision = restrictiveDefaultRevision + 1;

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
        'Validate an advanced JSON change to the imported All OS draft',
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
        }
      );

      await permissionPolicyTest.step(
        'Author an independent Windows addition and round-trip the whole native document',
        async () => {
          await expect(permissionSet).toHaveValue('all');
          await tool.selectOption('browser_open');
          await browserDecision.selectOption('ask');
          await permissionSet.selectOption('windows');
          await addWindows.click();
          await tool.selectOption('browser_open');
          await expect(browserDecision).toHaveValue('inherit');
          await browserDecision.selectOption('deny');
          await savePolicy(drawer, defaultRevision);
          const persisted = await readDefault();
          expect(persisted?.policy_revision).toBe(defaultRevision);
          expect(persisted?.default_policies).toContainEqual(osScopedDefaultAgentPolicy);

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
          await capture(page, testInfo, 'managed-agent-permissions');

          await drawer.getByRole('tab', { name: 'Tools', exact: true }).click();
          await permissionSet.selectOption('windows');
          await tool.selectOption('browser_open');
          await expect(browserDecision).toHaveValue('deny');
          await browserDecision.scrollIntoViewIfNeeded();
          await capture(page, testInfo, 'managed-windows-permissions');
          const [download] = await Promise.all([
            page.waitForEvent('download'),
            button(drawer, 'Export JSON').click(),
          ]);
          expect(download.suggestedFilename()).toBe('agent_permissions.json');
          const exportedPolicy = await readFile(await download.path(), 'utf8');
          expect(JSON.parse(exportedPolicy)).toEqual(osScopedDefaultAgentPolicy);

          await removeWindows.click();
          await expect(addWindows).toBeVisible();
          await permissionSet.selectOption('all');
          await tool.selectOption('browser_open');
          await expect(browserDecision).toHaveValue('ask');
          await permissionSet.selectOption('windows');
          await button(drawer, 'Import JSON/JSONC').click();
          await drawer.getByLabel('Configuration JSON or JSONC').fill(`{
            "permission": { "browser_open": "ask" },
          }`);
          await button(drawer, 'Preview import').click();
          await expect(drawer.getByLabel('Policy preview')).toContainText('in Windows only.');
          await button(drawer, 'Use in editor').click();
          await button(drawer, 'Edit JSON').click();
          const json = drawer.getByLabel('Policy JSON');
          expect(JSON.parse(await json.inputValue())).toEqual({
            ...allOsAgentPolicy,
            data: {
              ...allOsAgentPolicy.data,
              by_os: { windows: { tools: { browser_open: 'ask' } } },
            },
          });
          await json.fill(exportedPolicy);
          await button(drawer, 'Validate JSON').click();
          await button(drawer, 'Use in editor').click();
          await permissionSet.selectOption('windows');
          await tool.selectOption('browser_open');
          await expect(browserDecision).toHaveValue('deny');
          await expect(save).toBeDisabled();
          expect(await readDefault()).toEqual(persisted);
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

          await tool.selectOption('browser_open');
          await expect(
            browserPermission.getByText(/Organization default: Require approval\./)
          ).toBeVisible();
          await expect(browserDecision).toHaveValue('allow');

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
          await page.setViewportSize({ width: 1440, height: 1120 });
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

      await permissionPolicyTest.step(
        'Save conflicting client configuration in the two assigned groups',
        async () => {
          await groupPermissions.click();
          await clientConfiguration.click();
          await expect(showDollarValues).toBeChecked();
          await showDollarValues.click();
          await expect(showDollarValues).not.toBeChecked();
          await savePolicy(drawer, hiddenGroupRevision);
          expect(await readGroupPolicies(group.id)).toEqual([
            groupAgentPolicy,
            hiddenDollarValuesPolicy,
          ]);
          await button(drawer, 'Close drawer').click();

          await neutralGroupPermissions.click();
          await clientConfiguration.click();
          await expect(showDollarValues).toBeChecked();
          await showDollarValues.click();
          await showDollarValues.click();
          await expect(showDollarValues).toBeChecked();
          await savePolicy(drawer, groupConfigurationRevision);
          expect(await readGroupPolicies(neutralGroup.id)).toEqual([
            neutralGroupAgentPolicy,
            visibleDollarValuesPolicy,
          ]);
          await button(drawer, 'Close drawer').click();
        }
      );

      const diagnosedPolicies = await permissionPolicyTest.step(
        'Inspect Windows and All OS layers, scoped auto-approve, and conflicting group values',
        async () => {
          const saved = await readDefault();
          expect(saved?.policy_revision).toBe(groupConfigurationRevision);
          expect(saved?.default_policies.filter(policy => policy.type !== 'model_access')).toEqual([
            osScopedDefaultAgentPolicy,
          ]);
          await inspectMemberPolicy.click();
          await expect(executionOs).toHaveValue('all');
          await memberSelect.selectOption(member.id);
          const revision = drawer.getByText(`Revision ${groupConfigurationRevision}`, {
            exact: true,
          });
          await expect(revision).toBeVisible();
          await expect(autoApproveStatus).toHaveText('Disabled');
          await expect(dollarVisibility).toHaveText('Hidden');
          await expect(defaultSource).toBeVisible();
          await expect(defaultSource).not.toContainText(autoApproveSummary);
          await expect(defaultSource).not.toContainText('Windows permissions');
          await expect(policySource(group.name)).toContainText(autoApproveSummary);
          await expect(policySource(group.name)).toContainText('Session dollar values hidden');
          await expect(policySource(neutralGroup.name)).toContainText(
            'Session dollar values visible'
          );
          await expect(policySource(neutralGroup.name)).not.toContainText(autoApproveSummary);
          await expect(drawer.getByText(/client access/i)).toHaveCount(0);
          await capture(page, testInfo, 'managed-member-policy-sources');
          const details = drawer.locator('details').filter({
            has: page.getByText('Effective policy JSON', { exact: true }),
          });
          const effective = details.getByText('Effective policy JSON', { exact: true });
          async function readSelectedPolicy(layers: unknown[]) {
            await effective.click();
            const policy = JSON.parse(await details.locator('pre').innerText());
            expect(policy).toEqual({
              agent_permissions: { layers: expect.arrayContaining(layers) },
              client_configuration: { show_session_dollar_values: false },
            });
            expect(policy.agent_permissions.layers).toHaveLength(layers.length);
            await effective.click();
            return policy;
          }
          const allOsLayers = [
            allOsAgentPolicy.data,
            groupAgentPolicy.data,
            neutralGroupAgentPolicy.data,
          ];
          const allOs = await readSelectedPolicy(allOsLayers);

          await executionOs.selectOption('windows');
          const windowsSource = defaultSource.getByText('Windows permissions', { exact: true });
          await expect(defaultSource).toContainText('All OS');
          await expect(autoApproveStatus).toHaveText('Disabled');
          await expect(dollarVisibility).toHaveText('Hidden');
          await windowsSource.click();
          await capture(page, testInfo, 'managed-windows-member-policy-sources');
          await windowsSource.click();
          const windows = await readSelectedPolicy([
            ...allOsLayers,
            { schema_version: 1, ...windowsPermissions },
          ]);

          await executionOs.selectOption('linux');
          await expect(defaultSource).not.toContainText('Windows permissions');
          expect(await readSelectedPolicy(allOsLayers)).toEqual(allOs);

          await executionOs.selectOption('all');
          await memberSelect.selectOption(admin.id);
          await expect(autoApproveStatus).toHaveText('No organization restriction');
          await expect(dollarVisibility).toHaveText('Visible');
          await expect(drawer.getByText('No group policy contributions.')).toBeVisible();
          await expect(defaultSource).toBeVisible();
          await expect(policySource(group.name)).toHaveCount(0);
          await expect(policySource(neutralGroup.name)).toHaveCount(0);
          return { allOs, windows };
        }
      );

      await permissionPolicyTest.step(
        'Retrieve only the selected anonymous layers and validate the exact Windows ETag',
        async () => {
          const memberContext = await browser.newContext({ baseURL });
          try {
            const memberPage = await memberContext.newPage();
            await signInAs(memberPage, member.email, managedPath);
            await expect(memberPage.getByText('Your groups', { exact: true })).toBeVisible();
            await expect(button(memberPage, 'Default permissions')).toHaveCount(0);
            await expect(button(memberPage, 'Inspect member policy')).toHaveCount(0);
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
            function getPolicy(os?: PermissionPolicyExecutionOs, etag?: string) {
              const url = new URL('policy/permission', organizationApi);
              if (os) url.searchParams.set('os', os);
              const headers = new Headers({ Authorization: `Bearer ${token}` });
              if (etag) headers.set('If-None-Match', etag);
              return fetch(url, {
                headers,
                redirect: 'error',
                signal: AbortSignal.timeout(30_000),
              });
            }
            async function expectPolicyResponse(response: Response, policy: unknown) {
              expect(response.status).toBe(200);
              expect(response.headers.get('cache-control')).toBe('private, no-store');
              expect(await response.json()).toEqual({
                schema_version: 1,
                organization_id: managed.id,
                managed: true,
                revision: groupConfigurationRevision,
                max_age_seconds: expect.any(Number),
                policy,
              });
              return z
                .string()
                .regex(/^"[^"]+"$/)
                .parse(response.headers.get('etag'));
            }
            const omitted = await expectPolicyResponse(await getPolicy(), diagnosedPolicies.allOs);
            const linux = await expectPolicyResponse(
              await getPolicy('linux'),
              diagnosedPolicies.allOs
            );
            const other = await expectPolicyResponse(
              await getPolicy('other'),
              diagnosedPolicies.allOs
            );
            const windows = await expectPolicyResponse(
              await getPolicy('windows'),
              diagnosedPolicies.windows
            );
            expect(new Set([omitted, linux, other, windows]).size).toBe(4);

            const unchanged = await getPolicy('windows', windows);
            expect(unchanged.status).toBe(304);
            expect(unchanged.headers.get('etag')).toBe(windows);
            expect(unchanged.headers.get('cache-control')).toBe('private, no-store');
            expect(await unchanged.text()).toBe('');
            const differentOs = await getPolicy('linux', windows);
            expect(await expectPolicyResponse(differentOs, diagnosedPolicies.allOs)).toBe(linux);
          } finally {
            await memberContext.close();
          }
        }
      );

      await permissionPolicyTest.step(
        'Remove the group agent policy without changing client configuration or the default',
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
          expect(await readGroupPolicies(group.id)).toEqual([hiddenDollarValuesPolicy]);
          expect(await readGroupPolicies(neutralGroup.id)).toEqual([
            neutralGroupAgentPolicy,
            visibleDollarValuesPolicy,
          ]);
          expect((await readDefault())?.default_policies).toContainEqual(
            osScopedDefaultAgentPolicy
          );
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
        'Apply default client configuration independently of agent permissions',
        async () => {
          await defaultPermissions.click();
          await clientConfiguration.click();
          await expect(showDollarValues).toBeChecked();
          await showDollarValues.click();
          await savePolicy(drawer, hiddenDefaultRevision);
          expect((await readDefault())?.default_policies).toEqual([
            { type: 'model_access', data: { mode: 'all' } },
            restrictiveDefaultAgentPolicy,
            hiddenDollarValuesPolicy,
          ]);
          await button(drawer, 'Close drawer').click();

          await neutralGroupPermissions.click();
          await clientConfiguration.click();
          await expect(showDollarValues).not.toBeChecked();
          await expect(showDollarValues).toBeDisabled();
          await expect(showDollarValues).toHaveAccessibleDescription(
            'Hidden by the organization default. A group cannot make them visible.'
          );
          await expect(
            drawer.getByText('Saved at this scope: Visible.', { exact: true })
          ).toBeVisible();
          await capture(page, testInfo, 'managed-client-configuration-inherited');
          await button(drawer, 'Close drawer').click();

          await inspectMemberPolicy.click();
          await memberSelect.selectOption(ungroupedMember.id);
          await expect(dollarVisibility).toHaveText('Hidden');
          await expect(drawer.getByText('No group policy contributions.')).toBeVisible();
          await button(drawer, 'Close drawer').click();

          await defaultPermissions.click();
          await clientConfiguration.click();
          await expect(showDollarValues).not.toBeChecked();
          await showDollarValues.click();
          await savePolicy(drawer, hiddenDefaultRevision + 1);
          expect((await readDefault())?.default_policies).toEqual([
            { type: 'model_access', data: { mode: 'all' } },
            restrictiveDefaultAgentPolicy,
            visibleDollarValuesPolicy,
          ]);
          await button(drawer, 'Close drawer').click();

          await inspectMemberPolicy.click();
          await memberSelect.selectOption(ungroupedMember.id);
          await expect(dollarVisibility).toHaveText('Visible');
          await expect(autoApproveStatus).toHaveText('Disabled');
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
