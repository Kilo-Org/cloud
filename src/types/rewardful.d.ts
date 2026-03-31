// Extend the Window interface to include the Rewardful tracking function.
// Loaded conditionally by rw.js when NEXT_PUBLIC_REWARDFUL_ID is set.
declare global {
  interface Window {
    rewardful?: (...args: unknown[]) => void;
  }
}
