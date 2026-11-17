import { browserPrepareChat, CLOUD_AGENT_RELAY_CHAT_FLAG } from './browser-relay-enrollment';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';

jest.mock('@kilocode/web-shared/lib/posthog-feature-flags', () => ({
  isReleaseToggleEnabled: jest.fn(),
}));
const enabled = jest.mocked(isReleaseToggleEnabled);
const getSandboxSelectionOptions = jest.fn();
const input = {
  userId: 'synthetic-user',
  repository: { githubRepo: 'synthetic/repository' },
  client: { getSandboxSelectionOptions },
};
beforeEach(() => {
  jest.resetAllMocks();
});

test('strict flag false adds no Worker capability request', async () => {
  enabled.mockResolvedValue(false);
  expect(await browserPrepareChat(input)).toBeUndefined();
  expect(getSandboxSelectionOptions).not.toHaveBeenCalled();
  expect(enabled).toHaveBeenCalledWith(CLOUD_AGENT_RELAY_CHAT_FLAG, input.userId);
});
test.each([undefined, false, true])('uses only an explicit eligible capability: %s', capability => {
  enabled.mockResolvedValue(true);
  getSandboxSelectionOptions.mockResolvedValue({ relayChatForBrowserPrepare: capability });
  return expect(browserPrepareChat(input)).resolves.toEqual(
    capability === true ? { transport: 'relay' } : undefined
  );
});
test.each(['mobile', 'desktop', 'agent-manager'])('does not enroll other caller %s', caller => {
  enabled.mockResolvedValue(true);
  return browserPrepareChat({ ...input, headers: new Headers({ 'x-kilo-client': caller }) }).then(
    chat => {
      expect(chat).toBeUndefined();
      expect(enabled).not.toHaveBeenCalled();
      expect(getSandboxSelectionOptions).not.toHaveBeenCalled();
    }
  );
});
test('keeps organization authorization failures instead of creating stream', async () => {
  enabled.mockResolvedValue(true);
  const denied = new Error('FORBIDDEN');
  getSandboxSelectionOptions.mockRejectedValue(denied);
  await expect(
    browserPrepareChat({ ...input, organizationId: 'synthetic-organization' })
  ).rejects.toBe(denied);
  expect(getSandboxSelectionOptions).toHaveBeenCalledWith({
    kilocodeOrganizationId: 'synthetic-organization',
    repositoryType: 'github',
    repositoryFullName: 'synthetic/repository',
  });
});
