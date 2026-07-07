export interface PylonConfig {
  appId: string;
  enableLogging?: boolean;
  primaryColor?: string;
  debugMode?: boolean;
  widgetBaseUrl?: string;
  widgetScriptUrl?: string;
}

export interface PylonUser {
  email: string;
  name: string;
  avatarUrl?: string;
  emailHash?: string;
  accountId?: string;
  accountExternalId?: string;
}

export interface InteractiveBound {
  selector: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PylonChatListener {
  onPylonLoaded?: () => void;
  onPylonInitialized?: () => void;
  onPylonReady?: () => void;
  onMessageReceived?: (message: string) => void;
  onChatOpened?: () => void;
  onChatClosed?: (wasOpen: boolean) => void;
  onPylonError?: (error: string) => void;
  onUnreadCountChanged?: (count: number) => void;
  onInteractiveBoundsChanged?: (bounds: InteractiveBound) => void;
}
