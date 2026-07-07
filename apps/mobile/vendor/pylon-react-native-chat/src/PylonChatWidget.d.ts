import { ViewStyle } from "react-native";
import type { PylonChatViewRef } from "./PylonChatView";
import type { PylonChatListener, PylonConfig, PylonUser } from "./types";

export interface PylonChatWidgetProps {
  config: PylonConfig;
  user?: PylonUser;
  listener?: PylonChatListener;
  style?: ViewStyle;
  topInset?: number;
}

export const PylonChatWidget: React.ForwardRefExoticComponent<
  PylonChatWidgetProps & React.RefAttributes<PylonChatViewRef>
>;
