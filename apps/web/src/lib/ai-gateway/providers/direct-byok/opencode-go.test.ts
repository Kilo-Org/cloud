import { getAiSdkProvider } from '../model-settings';
import { isOpenCodeGoMessagesModel } from './opencode-go';

describe('isOpenCodeGoMessagesModel', () => {
  test.each(['opencode-go/minimax-m3', 'opencode-go/qwen3.7-plus'])(
    'matches OpenCode Go Messages model %s',
    model => {
      expect(isOpenCodeGoMessagesModel(model)).toBe(true);
      expect(getAiSdkProvider(model)).toBe('anthropic');
    }
  );

  test.each(['opencode-go/deepseek-v4-flash', 'other-provider/qwen3.7-plus'])(
    'does not match %s',
    model => {
      expect(isOpenCodeGoMessagesModel(model)).toBe(false);
    }
  );
});
