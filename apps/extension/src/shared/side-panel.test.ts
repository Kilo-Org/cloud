import { describe, expect, it } from 'vitest';
import { enableActionClickSidePanel } from './side-panel';

describe('side panel behavior', () => {
  it('opens the native side panel from the extension action click', async () => {
    const calls: { openPanelOnActionClick: boolean }[] = [];

    await enableActionClickSidePanel({
      setPanelBehavior: options => {
        calls.push(options);
      },
    });

    expect(calls).toStrictEqual([{ openPanelOnActionClick: true }]);
  });

  it('ignores browsers without the native side panel API', async () => {
    await expect(enableActionClickSidePanel()).resolves.toBeUndefined();
  });
});
