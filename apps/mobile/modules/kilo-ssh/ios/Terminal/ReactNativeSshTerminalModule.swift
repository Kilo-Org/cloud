import ExpoModulesCore

public class ReactNativeSshTerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ReactNativeSshTerminal")

    Function("createFeedSource") { () -> FeedSource in
      FeedSource()
    }

    Class(FeedSource.self) {
      Property("sourceId") { (source: FeedSource) in
        source.id
      }

      Function("feed") { (source: FeedSource, bytes: Data) in
        source.feed(bytes)
      }

      Function("close") { (source: FeedSource, exitStatus: Int?, error: String?) in
        source.close(exitStatus: exitStatus, error: error)
      }
    }

    View(ReactNativeSshTerminalView.self) {
      Events(
        "onResize",
        "onLinkPress",
        "onBell",
        "onTitleChange",
        "onSelectionChange",
        "onFontSizeChange",
        "onClosed"
      )

      Prop("sourceId") { (view: ReactNativeSshTerminalView, sourceId: String?) in
        view.bindSource(sourceId)
      }

      Prop("autoFocus") { (view: ReactNativeSshTerminalView, autoFocus: Bool) in
        view.applyAutoFocus(autoFocus)
      }

      Prop("fontFamily") { (view: ReactNativeSshTerminalView, fontFamily: String?) in
        view.applyFontFamily(fontFamily)
      }

      Prop("fontSize") { (view: ReactNativeSshTerminalView, fontSize: Double) in
        view.applyFontSize(fontSize)
      }

      Prop("theme") { (view: ReactNativeSshTerminalView, theme: TerminalThemeRecord) in
        view.applyTheme(theme)
      }

      Prop("cursorStyle") { (view: ReactNativeSshTerminalView, cursorStyle: String) in
        view.applyCursorStyle(cursorStyle)
      }

      AsyncFunction("sendInput") { (view: ReactNativeSshTerminalView, base64: String) in
        view.sendInput(base64: base64)
      }.runOnQueue(.main)

      AsyncFunction("paste") { (view: ReactNativeSshTerminalView, text: String) in
        view.paste(text: text)
      }.runOnQueue(.main)

      AsyncFunction("pasteFromClipboard") { (view: ReactNativeSshTerminalView) in
        view.pasteFromClipboard()
      }.runOnQueue(.main)

      AsyncFunction("copySelection") { (view: ReactNativeSshTerminalView) in
        view.copySelection()
      }.runOnQueue(.main)

      AsyncFunction("scrollToBottom") { (view: ReactNativeSshTerminalView) in
        view.scrollToBottom()
      }.runOnQueue(.main)

      AsyncFunction("focus") { (view: ReactNativeSshTerminalView) in
        view.focus()
      }.runOnQueue(.main)

      AsyncFunction("blur") { (view: ReactNativeSshTerminalView) in
        view.blur()
      }.runOnQueue(.main)
    }
  }
}
