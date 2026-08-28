package expo.modules.localaccessprivacy;

// Java keeps this UI-independent state executable with the JDK, without an Android runtime.
// Authentication and background timing stay in the shared TypeScript service.
final class PrivacyVisibilityState {
  private boolean armed;
  private boolean foreground;
  private boolean visible;
  private boolean failed;
  private long generation;

  boolean isArmed() { return armed; }
  boolean isForeground() { return foreground; }
  boolean isFailed() { return failed; }
  long getGeneration() { return generation; }
  boolean isCovered() { return armed && (!foreground || !visible || failed); }
  boolean admitsForeground() { return foreground && (!armed || (!isCovered() && !failed)); }

  void arm() {
    armed = true;
    failed = false;
    cover();
  }

  void disarm() {
    armed = false;
    failed = false;
    cover();
  }

  void cover() {
    visible = false;
    generation += 1;
  }

  void setForeground(boolean value) {
    if (foreground != value) {
      foreground = value;
      cover();
    }
  }

  void fail() {
    failed = true;
    cover();
  }

  boolean publish(long expectedGeneration) {
    if (!armed || !foreground || failed || expectedGeneration != generation) {
      return false;
    }
    visible = true;
    return true;
  }

  boolean admitsAnnouncement(long expectedGeneration, boolean gate) {
    return expectedGeneration == generation
        && (!armed || (foreground && (gate || (!failed && visible))));
  }
}
