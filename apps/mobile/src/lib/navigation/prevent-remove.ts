// expo-router 57 vendors react-navigation and does not re-export usePreventRemove from
// its package root. One deep import here keeps a future expo-router change to one file.
export { usePreventRemove } from 'expo-router/build/react-navigation';
