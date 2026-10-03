const mockCaptureException = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import {
  addSlackReaction,
  isSlackMissingScopeError,
  isSlackWebApiPlatformError,
  replaceSlackReaction,
} from './helpers';

function slackPlatformError(error: string) {
  return { code: 'slack_webapi_platform_error', data: { ok: false, error } };
}

function createAdapter() {
  return {
    addReaction: jest.fn(async () => {}),
    removeReaction: jest.fn(async () => {}),
  };
}

describe('Slack reactions', () => {
  beforeEach(() => {
    mockCaptureException.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('addSlackReaction', () => {
    it('adds the reaction to the triggering message', async () => {
      const adapter = createAdapter();

      await expect(
        addSlackReaction(adapter, 'slack:C123', '1700000000.000001', 'hourglass_flowing_sand')
      ).resolves.toBe(true);

      expect(adapter.addReaction).toHaveBeenCalledWith(
        'slack:C123',
        '1700000000.000001',
        'hourglass_flowing_sand'
      );
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('treats already_reacted as success', async () => {
      const adapter = createAdapter();
      adapter.addReaction.mockRejectedValueOnce(slackPlatformError('already_reacted'));

      await expect(
        addSlackReaction(adapter, 'slack:C123', '1700000000.000001', 'hourglass_flowing_sand')
      ).resolves.toBe(true);

      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('reports other failures to Sentry without throwing', async () => {
      const adapter = createAdapter();
      adapter.addReaction.mockRejectedValueOnce(slackPlatformError('missing_scope'));

      await expect(
        addSlackReaction(adapter, 'slack:C123', '1700000000.000001', 'hourglass_flowing_sand')
      ).resolves.toBe(false);

      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.objectContaining(slackPlatformError('missing_scope')),
        expect.objectContaining({
          tags: { component: 'kilo-bot', op: 'slack-reaction-add' },
        })
      );
    });
  });

  describe('replaceSlackReaction', () => {
    it('adds the replacement before removing the original reaction', async () => {
      const adapter = createAdapter();
      const order: string[] = [];
      adapter.addReaction.mockImplementationOnce(async () => {
        order.push('add');
      });
      adapter.removeReaction.mockImplementationOnce(async () => {
        order.push('remove');
      });

      await expect(
        replaceSlackReaction(
          adapter,
          'slack:C123',
          '1700000000.000001',
          'hourglass_flowing_sand',
          'white_check_mark'
        )
      ).resolves.toBe(true);

      expect(order).toEqual(['add', 'remove']);
      expect(adapter.addReaction).toHaveBeenCalledWith(
        'slack:C123',
        '1700000000.000001',
        'white_check_mark'
      );
      expect(adapter.removeReaction).toHaveBeenCalledWith(
        'slack:C123',
        '1700000000.000001',
        'hourglass_flowing_sand'
      );
    });

    it('does not remove the original reaction when the replacement fails', async () => {
      const adapter = createAdapter();
      adapter.addReaction.mockRejectedValueOnce(slackPlatformError('missing_scope'));

      await expect(
        replaceSlackReaction(
          adapter,
          'slack:C123',
          '1700000000.000001',
          'hourglass_flowing_sand',
          'white_check_mark'
        )
      ).resolves.toBe(false);

      expect(adapter.removeReaction).not.toHaveBeenCalled();
    });

    it('treats no_reaction on removal as success', async () => {
      const adapter = createAdapter();
      adapter.removeReaction.mockRejectedValueOnce(slackPlatformError('no_reaction'));

      await expect(
        replaceSlackReaction(
          adapter,
          'slack:C123',
          '1700000000.000001',
          'hourglass_flowing_sand',
          'white_check_mark'
        )
      ).resolves.toBe(true);

      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('reports removal failures to Sentry without throwing', async () => {
      const adapter = createAdapter();
      adapter.removeReaction.mockRejectedValueOnce(new Error('network down'));

      await expect(
        replaceSlackReaction(
          adapter,
          'slack:C123',
          '1700000000.000001',
          'hourglass_flowing_sand',
          'white_check_mark'
        )
      ).resolves.toBe(false);

      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { component: 'kilo-bot', op: 'slack-reaction-remove' },
        })
      );
    });
  });

  describe('Slack platform error guards', () => {
    it('detects Web API platform errors', () => {
      expect(isSlackWebApiPlatformError(slackPlatformError('already_reacted'))).toBe(true);
      expect(isSlackWebApiPlatformError(new Error('nope'))).toBe(false);
      expect(isSlackWebApiPlatformError(null)).toBe(false);
    });

    it('detects missing scope errors with a needed scope', () => {
      const error = {
        code: 'slack_webapi_platform_error',
        data: { ok: false, error: 'missing_scope', needed: 'reactions:write' },
      };
      expect(isSlackMissingScopeError(error)).toBe(true);
      expect(isSlackMissingScopeError(slackPlatformError('missing_scope'))).toBe(false);
    });
  });
});
