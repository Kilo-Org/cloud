# mobile-android: tablet AVD renders the app as a centered column — gutter taps are swallowed

Symptom: W3C/adb taps at plausible coordinates silently no-op on
`kilo_pixel_tablet_api35` (2560x1600): action-sheet backdrop taps, modal
backdrop taps, button taps.

Cause: the app renders as a centered phone-width column (physical x about
680..1880) with black gutters on both sides. Taps in the gutters never reach
the app, and elements report bounds inside the column only. A tap at
(150, 250) — fine on a phone AVD — lands in dead space here.

Fix: derive every tap from the live `uiautomator` bounds (never remembered
coordinates), and keep ad-hoc backdrop taps inside the column: sheet backdrop
(1000, 600), RenameModal backdrop (1280, 900) with the keyboard closed. When a
tap "does nothing", screenshot first and check the column edges before blaming
the product.
