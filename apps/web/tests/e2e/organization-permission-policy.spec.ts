import { expect, test } from '@chromatic-com/playwright';
import type { Browser, BrowserContext, Locator, Page, TestInfo } from '@playwright/test';
import type { PermissionPolicyExecutionOs } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
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

const policyNames = {
  browser: 'Browser approval',
  privacy: 'Privacy',
  unlinked: 'Unlinked tool policy',
  groupAllow: 'Group browser allow',
  telemetry: 'Telemetry only',
  dollarValues: 'Dollar values only',
  neutral: 'Neutral configuration',
  shared: 'Shared group policy',
} as const;

const browserDocument = {
  tools: { browser_open: 'ask' },
  by_os: { windows: { tools: { browser_open: 'deny' } } },
};
const privacyDocument = { disable_telemetry: true, hide_session_dollar_values: true };
const unlinkedDocument = { tools: { websearch: 'deny' } };
const groupAllowDocument = { tools: { browser_open: 'allow' } };
const telemetryDocument = { disable_telemetry: true };
const dollarValuesDocument = { hide_session_dollar_values: true };
const neutralDocument = {};
const sharedInitialDocument = { tools: { edit: 'ask' } };
const sharedEditedDocument = { tools: { edit: 'deny' } };

const browserAskLayer = { schema_version: 1, tools: { browser_open: 'ask' } };
const browserDenyLayer = { schema_version: 1, tools: { browser_open: 'deny' } };
const browserAllowLayer = { schema_version: 1, tools: { browser_open: 'allow' } };
const editDenyLayer = { schema_version: 1, tools: { edit: 'deny' } };
const bothClientFlags = { disable_telemetry: true, hide_session_dollar_values: true };

type NamedPolicyKind = 'agent_permissions' | 'client_configuration';
type Attachment = { type: 'default' } | { type: 'group'; groupId: string };
type NamedPolicyRecord = {
  id: string;
  name: string;
  kind: NamedPolicyKind;
  document: unknown;
  attachments: Attachment[];
};
type PolicyFixture = {
  readNamedPolicies: () => Promise<NamedPolicyRecord[]>;
  readRevision: () => Promise<number>;
};

const button = (scope: Page | Locator, name: string) =>
  scope.getByRole('button', { name, exact: true });
const activeDrawer = (page: Page) => page.getByRole('dialog', { name: 'Drawer panel' }).last();
const groupsPath = (organization: { id: string }) => `/organizations/${organization.id}/groups`;

async function signInAs(page: Page, email: string, callbackPath: string) {
  const signIn = new URLSearchParams({ fakeUser: email, callbackPath });
  await page.goto(`/users/sign_in?${signIn}`);
  await page.waitForURL(url => url.pathname === callbackPath, { timeout: 60_000 });
}

async function closeDrawer(page: Page) {
  await activeDrawer(page).getByRole('button', { name: 'Close drawer' }).click();
  await expect(page.getByRole('dialog', { name: 'Drawer panel' })).toHaveCount(0);
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await expect(activeDrawer(page).getByRole('button', { name: 'Close drawer' })).toBeInViewport({
    ratio: 1,
  });
  await page.screenshot({
    path,
    animations: 'disabled',
    style: '[data-sonner-toaster] { visibility: hidden; }',
  });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function openPolicyLibrary(page: Page) {
  await button(page, 'Policies').click();
  const drawer = activeDrawer(page);
  await expect(drawer.getByRole('heading', { name: 'Policies', exact: true })).toBeVisible();
  await expect(button(drawer, 'New policy')).toBeVisible();
  return drawer;
}

const policyRow = (drawer: Locator, name: string) => drawer.locator('li').filter({ hasText: name });

async function createNamedPolicy(
  drawer: Locator,
  name: string,
  kind: NamedPolicyKind,
  document: unknown
) {
  await button(drawer, 'New policy').click();
  await expect(drawer.getByRole('heading', { name: 'New policy', exact: true })).toBeVisible();
  await drawer.getByLabel('Name', { exact: true }).fill(name);
  await drawer.getByLabel('Kind', { exact: true }).selectOption(kind);
  await drawer.getByLabel('Policy JSON', { exact: true }).fill(JSON.stringify(document, null, 2));
  await button(drawer, 'Create policy').click();
  await expect(drawer.getByRole('heading', { name: 'New policy', exact: true })).toHaveCount(0);
  await expect(drawer.getByText(name, { exact: true })).toBeVisible();
}

async function selectNamedPolicy(drawer: Locator, label: string, name: string) {
  const select = drawer.getByLabel(label, { exact: true });
  await expect(select.getByRole('option', { name, exact: true })).toHaveCount(1);
  await select.selectOption({ label: name });
}

const attachmentKeys = (attachments: Attachment[]) =>
  attachments
    .map(attachment => (attachment.type === 'default' ? 'default' : `group:${attachment.groupId}`))
    .sort();

async function expectPolicyAttachments(
  fixture: PolicyFixture,
  name: string,
  expected: Attachment[]
) {
  await expect
    .poll(
      async () => {
        const policies = await fixture.readNamedPolicies();
        return attachmentKeys(policies.find(policy => policy.name === name)?.attachments ?? []);
      },
      { timeout: 20_000 }
    )
    .toEqual(attachmentKeys(expected));
}

type MemberPolicyClient = {
  context: BrowserContext;
  contextPage: Page;
  getPolicy: (os?: PermissionPolicyExecutionOs, etag?: string) => Promise<Response>;
};

async function createMemberPolicyClient(params: {
  browser: Browser;
  baseURL: string | undefined;
  email: string;
  pagePath: string;
  organization: { id: string };
}): Promise<MemberPolicyClient> {
  if (!params.baseURL) throw new Error('Playwright baseURL is required.');
  const baseURL = params.baseURL;
  const context = await params.browser.newContext({ baseURL });
  const contextPage = await context.newPage();
  await signInAs(contextPage, params.email, params.pagePath);
  await expect(contextPage.getByText('Your groups', { exact: true })).toBeVisible();

  const organizationApi = new URL(`/api/organizations/${params.organization.id}/`, baseURL);
  const tokenUrl = new URL('user-tokens', organizationApi);
  const cookies = await context.cookies(tokenUrl.href);
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

  return { context, contextPage, getPolicy };
}

async function expectMemberPolicyResponse(params: {
  response: Response;
  organization: { id: string };
  revision: number;
  layers: unknown[];
  clientConfiguration?: unknown;
}) {
  expect(params.response.status).toBe(200);
  expect(params.response.headers.get('cache-control')).toBe('private, no-store');
  const body = await params.response.json();
  expect(body).toMatchObject({
    schema_version: 1,
    organization_id: params.organization.id,
    managed: true,
    revision: params.revision,
    max_age_seconds: expect.any(Number),
  });
  const layers = body.policy.agent_permissions?.layers ?? [];
  expect(layers.map((layer: unknown) => JSON.stringify(layer)).sort()).toEqual(
    params.layers.map(layer => JSON.stringify(layer)).sort()
  );
  if (params.clientConfiguration) {
    expect(body.policy.client_configuration).toEqual(params.clientConfiguration);
  } else {
    expect(body.policy).not.toHaveProperty('client_configuration');
  }
  return {
    body,
    etag: z
      .string()
      .regex(/^"[^"]+"$/)
      .parse(params.response.headers.get('etag')),
  };
}

permissionPolicyTest.describe('Enterprise named permission policy editor', () => {
  permissionPolicyTest.use({ storageState: { cookies: [], origins: [] } });
  permissionPolicyTest.skip(
    process.env.E2E_ORGANIZATION_PERMISSION_POLICY !== 'true',
    'Requires the isolated Enterprise permission policy E2E invocation.'
  );

  permissionPolicyTest(
    'authors named policies and verifies resolved member delivery by OS',
    { tag: '@permission-policy-write' },
    async ({ baseURL, browser, page, permissionFixture }, testInfo) => {
      permissionPolicyTest.setTimeout(300_000);
      const { admin, member, managed, disabled, group, neutralGroup, disabledGroup } =
        permissionFixture;
      const managedPath = groupsPath(managed);
      const diagnosticValue = (drawer: Locator, label: string) =>
        drawer.locator('dl > div').filter({ hasText: label }).locator('dd');
      const policySource = (drawer: Locator, name: string) =>
        drawer.locator('section').filter({ hasText: name });

      await signInAs(page, admin.email, managedPath);
      await expect(button(page, 'Policies')).toBeVisible();

      await permissionPolicyTest.step(
        'Reject invalid JSON and duplicate keys without creating a policy',
        async () => {
          const before = await permissionFixture.readNamedPolicies();
          const drawer = await openPolicyLibrary(page);
          await button(drawer, 'New policy').click();
          await drawer.getByLabel('Name', { exact: true }).fill('Invalid draft');
          await drawer.getByLabel('Kind', { exact: true }).selectOption('agent_permissions');
          const json = drawer.getByLabel('Policy JSON', { exact: true });

          await json.fill('{"tools":{"browser_open":"ask",}}');
          await button(drawer, 'Create policy').click();
          await expect(drawer.getByRole('alert')).toHaveText(/Invalid JSON near offset \d+\./);

          await json.fill('{"tools":{"browser_open":"ask","browser_open":"deny"}}');
          await button(drawer, 'Create policy').click();
          await expect(drawer.getByRole('alert')).toHaveText(
            'Duplicate key "browser_open" is not allowed.'
          );

          await button(drawer, 'Cancel').click();
          await expect(drawer.getByText('Invalid draft', { exact: true })).toHaveCount(0);
          expect(await permissionFixture.readNamedPolicies()).toEqual(before);
          await closeDrawer(page);
        }
      );

      await permissionPolicyTest.step(
        'Create named Agent Permissions and Client Configuration policies',
        async () => {
          const drawer = await openPolicyLibrary(page);
          await createNamedPolicy(
            drawer,
            policyNames.browser,
            'agent_permissions',
            browserDocument
          );
          await createNamedPolicy(
            drawer,
            policyNames.privacy,
            'client_configuration',
            privacyDocument
          );
          await createNamedPolicy(
            drawer,
            policyNames.unlinked,
            'agent_permissions',
            unlinkedDocument
          );
          await createNamedPolicy(
            drawer,
            policyNames.groupAllow,
            'agent_permissions',
            groupAllowDocument
          );
          await createNamedPolicy(
            drawer,
            policyNames.telemetry,
            'client_configuration',
            telemetryDocument
          );
          await createNamedPolicy(
            drawer,
            policyNames.dollarValues,
            'client_configuration',
            dollarValuesDocument
          );
          await createNamedPolicy(
            drawer,
            policyNames.neutral,
            'client_configuration',
            neutralDocument
          );
          await createNamedPolicy(
            drawer,
            policyNames.shared,
            'agent_permissions',
            sharedInitialDocument
          );

          for (const name of Object.values(policyNames)) {
            await expect(policyRow(drawer, name)).toContainText('Unlinked');
          }
          await capture(page, testInfo, 'named-policy-library');

          const policies = await permissionFixture.readNamedPolicies();
          expect(policies.map(policy => policy.name).sort()).toEqual(
            Object.values(policyNames).sort()
          );
          expect(policies.every(policy => policy.attachments.length === 0)).toBe(true);
          await closeDrawer(page);
        }
      );

      await permissionPolicyTest.step(
        'Link one Agent Permissions default and one group configuration',
        async () => {
          await button(page, 'Group Defaults').click();
          let drawer = activeDrawer(page);
          await expect(
            drawer.getByRole('heading', { name: 'Group Defaults', exact: true })
          ).toBeVisible();
          await selectNamedPolicy(drawer, 'Agent permissions', policyNames.browser);
          await expectPolicyAttachments(permissionFixture, policyNames.browser, [
            { type: 'default' },
          ]);
          await closeDrawer(page);

          await button(page, `Permissions for ${group.name}`).click();
          drawer = activeDrawer(page);
          await selectNamedPolicy(drawer, 'Agent permissions', policyNames.groupAllow);
          await selectNamedPolicy(drawer, 'Client configuration', policyNames.privacy);
          await expectPolicyAttachments(permissionFixture, policyNames.groupAllow, [
            { type: 'group', groupId: group.id },
          ]);
          await expectPolicyAttachments(permissionFixture, policyNames.privacy, [
            { type: 'group', groupId: group.id },
          ]);
          await capture(page, testInfo, 'named-policy-group-assignments');
          await closeDrawer(page);
        }
      );

      await permissionPolicyTest.step(
        'Inspect Windows diagnostics with separate All OS and OS layers',
        async () => {
          await button(page, 'Inspect member policy').click();
          const drawer = activeDrawer(page);
          await drawer.getByLabel('Member', { exact: true }).selectOption(member.id);
          const revision = await permissionFixture.readRevision();
          await expect(drawer.getByText(`Revision ${revision}`, { exact: true })).toBeVisible();
          await expect(diagnosticValue(drawer, 'Auto-approval')).toHaveText('Allowed');
          await expect(diagnosticValue(drawer, 'Telemetry')).toHaveText('Disabled');
          await expect(diagnosticValue(drawer, 'Session dollar values')).toHaveText('Hidden');

          const details = drawer.locator('details');
          await details.locator('summary').click();
          await expect(details).toHaveAttribute('open', '');
          const readPolicy = async () =>
            JSON.parse((await details.locator('pre').textContent()) ?? '');
          const allOs = await readPolicy();
          expect(
            allOs.agent_permissions.layers.map((layer: unknown) => JSON.stringify(layer)).sort()
          ).toEqual(
            [browserAskLayer, browserAllowLayer].map(layer => JSON.stringify(layer)).sort()
          );
          expect(allOs.client_configuration).toEqual(bothClientFlags);

          await drawer.getByLabel('Execution OS', { exact: true }).selectOption('windows');
          await expect(diagnosticValue(drawer, 'Telemetry')).toHaveText('Disabled');
          await expect(details.locator('pre')).toContainText('"browser_open": "deny"');
          const windows = await readPolicy();
          expect(
            windows.agent_permissions.layers.map((layer: unknown) => JSON.stringify(layer)).sort()
          ).toEqual(
            [browserAskLayer, browserDenyLayer, browserAllowLayer]
              .map(layer => JSON.stringify(layer))
              .sort()
          );

          const defaultSource = policySource(drawer, 'Organization default');
          await expect(defaultSource).toContainText(policyNames.browser);
          const groupSource = policySource(drawer, group.name);
          await expect(groupSource).toContainText(policyNames.groupAllow);
          await expect(groupSource).toContainText(policyNames.privacy);
          await expect(drawer.getByText(policyNames.unlinked, { exact: true })).toHaveCount(0);
          await capture(page, testInfo, 'named-policy-diagnostics-windows');
          await closeDrawer(page);
        }
      );

      await permissionPolicyTest.step(
        'Verify the member bearer response and exact-scope ETags',
        async () => {
          const client = await createMemberPolicyClient({
            browser,
            baseURL,
            email: member.email,
            pagePath: managedPath,
            organization: managed,
          });
          try {
            await expect(button(client.contextPage, 'Inspect member policy')).toHaveCount(0);
            await expect(button(client.contextPage, 'Policies')).toHaveCount(0);
            const revision = await permissionFixture.readRevision();
            const expected = (layers: unknown[]) => ({
              organization: managed,
              revision,
              layers,
              clientConfiguration: bothClientFlags,
            });

            const omitted = await expectMemberPolicyResponse({
              ...expected([browserAskLayer, browserAllowLayer]),
              response: await client.getPolicy(),
            });
            const linux = await expectMemberPolicyResponse({
              ...expected([browserAskLayer, browserAllowLayer]),
              response: await client.getPolicy('linux'),
            });
            const other = await expectMemberPolicyResponse({
              ...expected([browserAskLayer, browserAllowLayer]),
              response: await client.getPolicy('other'),
            });
            const windows = await expectMemberPolicyResponse({
              ...expected([browserAskLayer, browserDenyLayer, browserAllowLayer]),
              response: await client.getPolicy('windows'),
            });
            expect(other.body.policy).toEqual(omitted.body.policy);
            expect(linux.body.policy).toEqual(omitted.body.policy);
            expect(windows.etag).not.toBe(linux.etag);

            const linuxAgain = await client.getPolicy('linux', linux.etag);
            expect(linuxAgain.status).toBe(304);
            expect(linuxAgain.headers.get('etag')).toBe(linux.etag);
            expect(linuxAgain.headers.get('cache-control')).toBe('private, no-store');
            expect(await linuxAgain.text()).toBe('');

            const windowsAgain = await client.getPolicy('windows', windows.etag);
            expect(windowsAgain.status).toBe(304);
            expect(windowsAgain.headers.get('etag')).toBe(windows.etag);

            const linuxFromWindowsEtag = await expectMemberPolicyResponse({
              ...expected([browserAskLayer, browserAllowLayer]),
              response: await client.getPolicy('linux', windows.etag),
            });
            expect(linuxFromWindowsEtag.etag).toBe(linux.etag);
          } finally {
            await client.context.close();
          }
        }
      );

      await permissionPolicyTest.step(
        'Resolve each Client Configuration flag from an independent policy',
        async () => {
          await button(page, `Permissions for ${group.name}`).click();
          let drawer = activeDrawer(page);
          await selectNamedPolicy(drawer, 'Client configuration', policyNames.telemetry);
          await expectPolicyAttachments(permissionFixture, policyNames.telemetry, [
            { type: 'group', groupId: group.id },
          ]);
          await closeDrawer(page);

          await button(page, `Permissions for ${neutralGroup.name}`).click();
          drawer = activeDrawer(page);
          await selectNamedPolicy(drawer, 'Client configuration', policyNames.dollarValues);
          await expectPolicyAttachments(permissionFixture, policyNames.dollarValues, [
            { type: 'group', groupId: neutralGroup.id },
          ]);
          await closeDrawer(page);
          await expectPolicyAttachments(permissionFixture, policyNames.privacy, []);

          await button(page, 'Inspect member policy').click();
          drawer = activeDrawer(page);
          await drawer.getByLabel('Member', { exact: true }).selectOption(member.id);
          await expect(diagnosticValue(drawer, 'Auto-approval')).toHaveText('Allowed');
          await expect(diagnosticValue(drawer, 'Telemetry')).toHaveText('Disabled');
          await expect(diagnosticValue(drawer, 'Session dollar values')).toHaveText('Hidden');

          const details = drawer.locator('details');
          await details.locator('summary').click();
          await expect(details).toHaveAttribute('open', '');
          const effective = JSON.parse((await details.locator('pre').textContent()) ?? '');
          expect(effective.client_configuration).toEqual(bothClientFlags);
          expect(effective.client_configuration).not.toHaveProperty('disable_auto_approve');
          await expect(policySource(drawer, group.name)).toContainText(policyNames.telemetry);
          await expect(policySource(drawer, neutralGroup.name)).toContainText(
            policyNames.dollarValues
          );
          await expect(drawer.getByText(policyNames.neutral, { exact: true })).toHaveCount(0);
          await expectPolicyAttachments(permissionFixture, policyNames.neutral, []);
          await closeDrawer(page);
        }
      );

      await permissionPolicyTest.step(
        'Reuse one agent policy in two groups, edit it once, and resolve the edit twice',
        async () => {
          await button(page, `Permissions for ${group.name}`).click();
          let drawer = activeDrawer(page);
          await selectNamedPolicy(drawer, 'Agent permissions', policyNames.shared);
          await closeDrawer(page);

          await button(page, `Permissions for ${neutralGroup.name}`).click();
          drawer = activeDrawer(page);
          await selectNamedPolicy(drawer, 'Agent permissions', policyNames.shared);
          await closeDrawer(page);
          await expectPolicyAttachments(permissionFixture, policyNames.shared, [
            { type: 'group', groupId: group.id },
            { type: 'group', groupId: neutralGroup.id },
          ]);

          drawer = await openPolicyLibrary(page);
          await expect(policyRow(drawer, policyNames.shared)).toContainText('2 attachments');
          await button(policyRow(drawer, policyNames.shared), 'Edit').click();
          await expect(
            drawer.getByRole('heading', { name: 'Edit policy', exact: true })
          ).toBeVisible();
          await expect(drawer.getByLabel('Name', { exact: true })).toHaveValue(policyNames.shared);
          await capture(page, testInfo, 'named-policy-editor');
          await drawer
            .getByLabel('Policy JSON', { exact: true })
            .fill(JSON.stringify(sharedEditedDocument, null, 2));
          await button(drawer, 'Save changes').click();
          await expect(
            drawer.getByRole('heading', { name: 'Edit policy', exact: true })
          ).toHaveCount(0);
          await expect(policyRow(drawer, policyNames.shared)).toContainText('2 attachments');
          await closeDrawer(page);

          const stored = (await permissionFixture.readNamedPolicies()).find(
            policy => policy.name === policyNames.shared
          );
          expect(stored?.document).toEqual(sharedEditedDocument);

          await button(page, 'Inspect member policy').click();
          drawer = activeDrawer(page);
          await drawer.getByLabel('Member', { exact: true }).selectOption(member.id);
          await expect(policySource(drawer, group.name)).toContainText(policyNames.shared);
          await expect(policySource(drawer, neutralGroup.name)).toContainText(policyNames.shared);
          const details = drawer.locator('details');
          await details.locator('summary').click();
          await expect(details.locator('pre')).toContainText('"edit": "deny"');
          await expect(details).toHaveAttribute('open', '');
          const effective = JSON.parse((await details.locator('pre').textContent()) ?? '');
          expect(
            effective.agent_permissions.layers.map((layer: unknown) => JSON.stringify(layer)).sort()
          ).toEqual([browserAskLayer, editDenyLayer].map(layer => JSON.stringify(layer)).sort());
          await closeDrawer(page);

          const client = await createMemberPolicyClient({
            browser,
            baseURL,
            email: member.email,
            pagePath: managedPath,
            organization: managed,
          });
          try {
            await expectMemberPolicyResponse({
              organization: managed,
              revision: await permissionFixture.readRevision(),
              layers: [browserAskLayer, editDenyLayer],
              clientConfiguration: bothClientFlags,
              response: await client.getPolicy('linux'),
            });
          } finally {
            await client.context.close();
          }
        }
      );

      await permissionPolicyTest.step(
        'Refuse deleting an attached policy, then unlink it and delete',
        async () => {
          let drawer = await openPolicyLibrary(page);
          await button(policyRow(drawer, policyNames.shared), 'Delete').click();
          const confirm = button(policyRow(drawer, policyNames.shared), 'Confirm delete');
          await expect(confirm).toBeDisabled();
          expect(
            (await permissionFixture.readNamedPolicies()).some(
              policy => policy.name === policyNames.shared
            )
          ).toBe(true);
          await closeDrawer(page);

          await button(page, `Permissions for ${group.name}`).click();
          drawer = activeDrawer(page);
          await selectNamedPolicy(drawer, 'Agent permissions', 'None');
          await closeDrawer(page);

          drawer = await openPolicyLibrary(page);
          await expect(policyRow(drawer, policyNames.shared)).toContainText('1 attachment');
          await button(policyRow(drawer, policyNames.shared), 'Delete').click();
          await expect(
            button(policyRow(drawer, policyNames.shared), 'Confirm delete')
          ).toBeDisabled();
          await closeDrawer(page);

          await button(page, `Permissions for ${neutralGroup.name}`).click();
          drawer = activeDrawer(page);
          await selectNamedPolicy(drawer, 'Agent permissions', 'None');
          await closeDrawer(page);
          await expectPolicyAttachments(permissionFixture, policyNames.shared, []);

          drawer = await openPolicyLibrary(page);
          await expect(policyRow(drawer, policyNames.shared)).toContainText('Unlinked');
          await button(policyRow(drawer, policyNames.shared), 'Delete').click();
          const enabledConfirm = button(policyRow(drawer, policyNames.shared), 'Confirm delete');
          await expect(enabledConfirm).toBeEnabled();
          await enabledConfirm.click();
          await expect(drawer.getByText(policyNames.shared, { exact: true })).toHaveCount(0);
          await closeDrawer(page);

          await expect
            .poll(async () =>
              (await permissionFixture.readNamedPolicies()).some(
                policy => policy.name === policyNames.shared
              )
            )
            .toBe(false);
          await expectPolicyAttachments(permissionFixture, policyNames.browser, [
            { type: 'default' },
          ]);
        }
      );

      await permissionPolicyTest.step(
        'Leave the disabled Enterprise tenant on the existing Groups UI',
        async () => {
          const [list] = await Promise.all([
            page.waitForResponse(response =>
              response.url().includes('organizations.groups.adminPermissionPolicy.list')
            ),
            page.goto(groupsPath(disabled)),
          ]);
          expect(await list.json()).toContainEqual({
            result: { data: expect.objectContaining({ managed: false, policies: [] }) },
          });

          await expect(
            page.getByText('Model access: All organization-approved models', { exact: true })
          ).toBeVisible();
          await expect(button(page, 'Manage defaults')).toBeVisible();
          await expect(page.getByText(disabledGroup.name, { exact: true })).toBeVisible();
          await expect(button(page, 'Group Defaults')).toHaveCount(0);
          await expect(button(page, 'Policies')).toHaveCount(0);
          await expect(button(page, 'Inspect member policy')).toHaveCount(0);
          await expect(button(page, `Permissions for ${disabledGroup.name}`)).toHaveCount(0);

          await button(page, 'Manage defaults').click();
          const drawer = activeDrawer(page);
          await expect(
            drawer.getByRole('heading', { name: 'Default policies', exact: true })
          ).toBeVisible();
          await expect(drawer.getByText('Model access', { exact: true })).toBeVisible();
          await expect(
            drawer.getByText('All organization-approved models', { exact: true })
          ).toBeVisible();
          await closeDrawer(page);
        }
      );
    }
  );
});
