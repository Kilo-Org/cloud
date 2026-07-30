# mobile-e2e-android: Appium page source uses class-named tags, not <node>; TODAY headers are text-only

Two parser traps that each produced hours of false "row missing" reads on
Android (UiAutomator2):

1. `driver.getPageSource()` returns tags named by widget class
   (`<android.widget.FrameLayout>`, `<android.view.ViewGroup>`), NOT `<node>`.
   `adb shell uiautomator dump` DOES use `<node>`. A regex shared between the
   two (`/<node[^>]*>/g`) silently matches nothing in Appium sources — every
   iteration then reports zero rows. Parse with
   `/<[a-zA-Z][a-zA-Z0-9.]*[^>]*>/g` and pull attributes per tag.

2. History section headers ("TODAY", "ACTIVE NOW") render as plain
   `android.widget.TextView` nodes with a `text` attribute and NO
   `content-desc`. Region-scoping that parses only `content-desc` finds no
   tray-bottom anchor; the fallback anchor (+inf) then counts HISTORY rows as
   TRAY rows on departure assertions — the exact failure mode
   `mobile-e2e-tray-vs-history-region-scoped-assertions.md` warns about, one
   level down. Parse BOTH attributes and anchor on the header's text.

Bounds order reminder: `bounds="[x1,y1][x2,y2]"` — group 2 is x1, group 3 is
y1. Reading group 2 as y ranks every row by its left edge.
