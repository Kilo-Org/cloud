import { type Href } from 'expo-router';

/**
 * The structural subset of Expo Router's router used by the agent-chat
 * navigation helpers. Importing the full `Router` type from `expo-router`
 * pulls in native modules; this shape keeps the helpers unit-testable with
 * a plain mock.
 */
export type AgentSessionRouterLike = {
  replace: (href: Href) => void;
};
