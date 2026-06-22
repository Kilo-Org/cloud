import { enableActionClickSidePanel } from '@/src/shared/side-panel';

export default defineBackground(() => {
  const sidePanel = (
    globalThis as typeof globalThis & {
      chrome?: {
        sidePanel?: Parameters<typeof enableActionClickSidePanel>[0];
      };
    }
  ).chrome?.sidePanel;

  void enableActionClickSidePanel(sidePanel);
});
