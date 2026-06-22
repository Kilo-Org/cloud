const GET_SIDEBAR_STATE_MESSAGE_TYPE = 'kilo.sidebar.getState';
const SIDEBAR_STATE_MESSAGE_TYPE = 'kilo.sidebar.state';
const TOGGLE_SIDEBAR_MESSAGE_TYPE = 'kilo.sidebar.toggle';

interface ToggleSidebarMessage {
  readonly type: typeof TOGGLE_SIDEBAR_MESSAGE_TYPE;
}

interface GetSidebarStateMessage {
  readonly type: typeof GET_SIDEBAR_STATE_MESSAGE_TYPE;
}

interface SidebarStateMessage {
  readonly isOpen: boolean;
  readonly type: typeof SIDEBAR_STATE_MESSAGE_TYPE;
}

export type SidebarRequestMessage = GetSidebarStateMessage | ToggleSidebarMessage;

export const createToggleSidebarMessage = (): ToggleSidebarMessage => ({
  type: TOGGLE_SIDEBAR_MESSAGE_TYPE,
});

export const createGetSidebarStateMessage = (): GetSidebarStateMessage => ({
  type: GET_SIDEBAR_STATE_MESSAGE_TYPE,
});

export const createSidebarStateMessage = (isOpen: boolean): SidebarStateMessage => ({
  isOpen,
  type: SIDEBAR_STATE_MESSAGE_TYPE,
});

export const isToggleSidebarMessage = (value: unknown): value is ToggleSidebarMessage =>
  isObjectWithType(value, TOGGLE_SIDEBAR_MESSAGE_TYPE);

export const isGetSidebarStateMessage = (value: unknown): value is GetSidebarStateMessage =>
  isObjectWithType(value, GET_SIDEBAR_STATE_MESSAGE_TYPE);

export const isSidebarStateMessage = (value: unknown): value is SidebarStateMessage =>
  isRecord(value) &&
  value['type'] === SIDEBAR_STATE_MESSAGE_TYPE &&
  typeof value['isOpen'] === 'boolean';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isObjectWithType = <TType extends string>(
  value: unknown,
  type: TType
): value is { readonly type: TType } => isRecord(value) && value['type'] === type;

export type { GetSidebarStateMessage, SidebarStateMessage, ToggleSidebarMessage };
export { GET_SIDEBAR_STATE_MESSAGE_TYPE, SIDEBAR_STATE_MESSAGE_TYPE, TOGGLE_SIDEBAR_MESSAGE_TYPE };
