package expo.modules.localaccessprivacy;

public final class PrivacyVisibilityStateTests {
  private static int checks;

  private static void check(boolean value, String message) {
    if (!value) throw new AssertionError(message);
    checks += 1;
  }

  public static void main(String[] args) {
    PrivacyVisibilityState state = new PrivacyVisibilityState();
    check(!state.isCovered(), "Disarmed content must retain its old visibility");
    check(state.admitsAnnouncement(state.getGeneration(), false), "Disarmed announcements must work");
    check(!state.admitsForeground(), "A missing native foreground must deny effects");
    state.setForeground(true);
    state.arm();
    check(state.isCovered(), "Arming must cover before authenticated content mounts");
    check(!state.admitsForeground(), "Foreground alone must not authorize armed effects");
    check(!state.admitsAnnouncement(state.getGeneration(), false), "Protected speech must stay hidden");
    check(state.admitsAnnouncement(state.getGeneration(), true), "Non-sensitive gate speech must remain usable");
    long first = state.getGeneration();
    check(state.publish(first), "Current access publication must reveal content");
    check(!state.isCovered() && state.admitsForeground(), "Published content must admit effects");
    check(state.admitsAnnouncement(first, false), "Allowed content must permit speech");
    state.setForeground(true);
    check(state.getGeneration() == first && !state.isCovered(), "An app dialog retaining foreground must not revoke visibility");
    state.setForeground(false);
    check(state.isCovered() && !state.admitsForeground(), "Inactivity must cover synchronously");
    check(!state.admitsAnnouncement(first, false), "Queued speech must fail after inactivity");
    check(!state.admitsAnnouncement(state.getGeneration(), true), "A passive cover must not announce a gate over a prompt");
    check(!state.publish(state.getGeneration()), "Inactive publication must not expose content");
    state.setForeground(true);
    check(state.isCovered(), "Native foreground must never uncover on its own");
    check(!state.publish(first), "A stale visibility generation must never uncover");
    check(state.publish(state.getGeneration()), "A fresh readiness handshake must restore visibility");
    check(!state.admitsAnnouncement(first, false), "Unlock must never replay stale speech");
    long beforeOwnerChange = state.getGeneration();
    state.cover();
    check(!state.publish(beforeOwnerChange), "Owner revocation must invalidate old visibility");
    state.fail();
    check(state.isCovered() && !state.publish(state.getGeneration()), "Native failure must remain protected");
    check(!state.admitsForeground(), "Native failure must deny effects");
    check(state.admitsAnnouncement(state.getGeneration(), true), "Recovery speech must remain non-sensitive");
    long beforeDisarm = state.getGeneration();
    state.disarm();
    check(!state.isCovered() && state.admitsForeground(), "Unmounted content must release protection");
    check(!state.admitsAnnouncement(beforeDisarm, false), "Disarm must not deliver old account speech");
    check(state.admitsAnnouncement(state.getGeneration(), false), "Fresh disarmed speech must work");
    check(!state.publish(state.getGeneration()), "Publication cannot arm an empty shell");
    System.out.println("PrivacyVisibilityState Java: " + checks + " checks passed");
  }
}
