export interface NativeSidePanelApi {
  setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void> | void;
}

export const enableActionClickSidePanel = async (sidePanel?: NativeSidePanelApi): Promise<void> => {
  await sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });
};
