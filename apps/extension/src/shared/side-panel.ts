export interface NativeSidePanelApi {
  setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void> | void;
}

export const enableActionClickSidePanel = async (sidePanel?: NativeSidePanelApi): Promise<void> => {
  await sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });
};

export const ADD_TO_MEMORY_MENU_ID = 'kilo-add-to-memory';

export interface NativeContextMenusCreateOptions {
  id: string;
  title: string;
  contexts: ['selection'];
}

export interface NativeContextMenusOnClickData {
  menuItemId: string | number;
  selectionText?: string | undefined;
  pageUrl?: string | undefined;
}

export interface NativeContextMenusTab {
  title?: string | undefined;
  url?: string | undefined;
  windowId?: number | undefined;
}

export type NativeContextMenusClickListener = (
  info: NativeContextMenusOnClickData,
  tab?: NativeContextMenusTab
) => void;

export interface NativeContextMenusApi {
  create(options: NativeContextMenusCreateOptions): unknown;
  remove?(menuItemId: string): Promise<void> | void;
  onClicked: {
    addListener(listener: NativeContextMenusClickListener): void;
  };
}

export interface NativeSidePanelOpenApi {
  open(options: { windowId: number }): Promise<void> | void;
}

export interface NativeSidebarActionApi {
  open(): Promise<void> | void;
}

export const registerAddToMemoryMenu = async (menusApi?: NativeContextMenusApi): Promise<void> => {
  if (menusApi === undefined) {
    return;
  }

  const options: NativeContextMenusCreateOptions = {
    contexts: ['selection'],
    id: ADD_TO_MEMORY_MENU_ID,
    title: 'Add to memory',
  };

  if (typeof menusApi.remove === 'function') {
    try {
      await menusApi.remove(ADD_TO_MEMORY_MENU_ID);
    } catch {
      // Item may not exist yet on a fresh service-worker start.
    }
  }

  try {
    menusApi.create(options);
  } catch {
    // Swallow duplicate-id errors when remove is unavailable or races.
  }
};

export const openSidePanelInWindow = ({
  sidePanelOpen,
  sidebarAction,
  windowId,
}: {
  sidePanelOpen?: NativeSidePanelOpenApi | undefined;
  sidebarAction?: NativeSidebarActionApi | undefined;
  windowId: number;
}): Promise<void> | void => {
  if (sidePanelOpen !== undefined) {
    return sidePanelOpen.open({ windowId });
  }

  if (sidebarAction !== undefined) {
    return sidebarAction.open();
  }
};
