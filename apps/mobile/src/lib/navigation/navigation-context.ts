// expo-router 57 vendors react-navigation and does not re-export
// NavigationContext from its package root. The concrete compiled module is
// plain CJS (`React.createContext(undefined)`); importing it here keeps a
// future expo-router change to one file (same pattern as prevent-remove.ts).
// Reading focus through this context instead of `useNavigation()` lets a
// caller outside a navigator (and a harness with a partial expo-router mock)
// mount without throwing: `useContext` returns undefined, never throws.
export { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext';
