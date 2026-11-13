package ai.kilo.reactnativessh.terminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ReactNativeSshTerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ReactNativeSshTerminal")

    OnCreate {
      TerminalViewEvents.install(appContext.eventEmitter(this@ReactNativeSshTerminalModule))
    }

    OnDestroy {
      TerminalViewEvents.install(null)
    }

    Function("createFeedSource") {
      FeedSource(appContext)
    }

    Class(FeedSource::class) {
      Constructor { FeedSource(appContext) }

      Events("onInput", "onResize")

      Property("sourceId").get { source -> source.id }

      Function("feed") { source: FeedSource, bytes: ByteArray ->
        source.feed(bytes)
      }

      Function("close") { source: FeedSource, exitStatus: Int?, error: String? ->
        source.close(exitStatus, error)
      }
    }

    View(ReactNativeSshTerminalView::class) {
      Events(
        "onResize",
        "onLinkPress",
        "onBell",
        "onTitleChange",
        "onSelectionChange",
        "onFontSizeChange",
        "onClosed",
      )

      Prop("sourceId") { view: ReactNativeSshTerminalView, sourceId: String? ->
        view.bindSource(sourceId)
      }

      Prop("fontFamily") { view: ReactNativeSshTerminalView, fontFamily: String? ->
        view.applyFontFamily(fontFamily)
      }

      Prop("fontSize") { view: ReactNativeSshTerminalView, fontSize: Double ->
        view.applyFontSize(fontSize)
      }

      Prop("theme") { view: ReactNativeSshTerminalView, theme: TerminalTheme ->
        view.applyTheme(theme)
      }

      Prop("cursorStyle") { view: ReactNativeSshTerminalView, cursorStyle: String ->
        view.applyCursorStyle(cursorStyle)
      }

      AsyncFunction("sendInput") { view: ReactNativeSshTerminalView, base64: String ->
        view.sendInput(base64)
      }

      AsyncFunction("paste") { view: ReactNativeSshTerminalView, text: String ->
        view.sendText(text)
      }

      AsyncFunction("pasteFromClipboard") { view: ReactNativeSshTerminalView ->
        view.pasteFromClipboard()
      }

      AsyncFunction("copySelection") { view: ReactNativeSshTerminalView ->
        view.copySelection()
      }

      AsyncFunction("scrollToBottom") { view: ReactNativeSshTerminalView ->
        view.scrollToBottom()
      }
    }
  }
}
