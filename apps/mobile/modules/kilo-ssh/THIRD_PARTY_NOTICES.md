# Third-party notices

## Termux terminal-emulator and terminal-view

`android/src/main/java/com/termux/**` and `android/src/main/res/{drawable,values}` contain source
files copied from [termux/termux-app](https://github.com/termux/termux-app) tag `v0.118.0`
(`terminal-emulator` and `terminal-view` modules), which are published under the Apache License 2.0
as an exception to the repository's GPLv3 license. See the upstream `LICENSE.md`.

Local changes: `TerminalSession` exchanges bytes through a `TerminalTransport` instead of spawning a
local pty through JNI, `TerminalView` gained `getSelectedText()` and `setSelectionColor()`,
`TerminalRenderer` paints a configurable selection background, and the two `textselection` files
import this library's `R`.

## SwiftTerm

The iOS terminal view is built on [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm)
(`exactVersion 1.10.1`), MIT licensed.
