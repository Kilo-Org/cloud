import ExpoModulesCore
import SwiftTerm
import UIKit

private let transcriptRows = 10_000
private let defaultFontSize: CGFloat = 13
private let minFontSize: CGFloat = 7
private let maxFontSize: CGFloat = 36
private let zoomStep: CGFloat = 1.15

final class SshTerminalView: TerminalView {
  var onSelectionChanged: ((Bool) -> Void)?
  var acceptsFocus = true

  override var canBecomeFirstResponder: Bool {
    return acceptsFocus && super.canBecomeFirstResponder
  }

  override func selectionChanged(source: Terminal) {
    super.selectionChanged(source: source)
    onSelectionChanged?(selectionActive)
  }
}

public final class ReactNativeSshTerminalView: ExpoView, TerminalViewDelegate, TerminalSink {
  public let onResize = EventDispatcher()
  public let onLinkPress = EventDispatcher()
  public let onBell = EventDispatcher()
  public let onTitleChange = EventDispatcher()
  public let onSelectionChange = EventDispatcher()
  public let onFontSizeChange = EventDispatcher()
  public let onClosed = EventDispatcher()

  private var terminalView: SshTerminalView!
  private var sourceId: String?
  private var source: TerminalByteSource?
  private var listenerToken: UUID?
  private var theme = TerminalTheme.default
  private var fontFamily: String?
  private var fontSize = defaultFontSize
  private var cursorStyle: CursorStyle = .steadyBlock
  private var scaleAccumulator: CGFloat = 1
  private var appliedCols = 0
  private var appliedRows = 0
  private var transportClosed = false
  private var autoFocus = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    installTerminal()

    let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch))
    addGestureRecognizer(pinch)
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()

    if window == nil {
      if let listenerToken {
        TerminalSourceRegistry.shared.removeListener(listenerToken)
        self.listenerToken = nil
      }
      source?.setSink(nil)
      source = nil
      terminalView.acceptsFocus = false
      _ = terminalView.resignFirstResponder()
      return
    }

    if listenerToken == nil {
      listenerToken = TerminalSourceRegistry.shared.addListener { [weak self] in
        self?.rebindSource()
      }
    }
    rebindSource()
    updateFocus()
  }

  func bindSource(_ sourceId: String?) {
    self.sourceId = sourceId
    rebindSource()
  }

  func applyAutoFocus(_ value: Bool) {
    guard autoFocus != value else {
      return
    }
    autoFocus = value
    updateFocus()
  }

  func focus() {
    requestTerminalFocus()
  }

  func blur() {
    _ = terminalView.resignFirstResponder()
  }

  func applyFontFamily(_ family: String?) {
    fontFamily = family.flatMap { $0.isEmpty ? nil : $0 }
    applyFont()
  }

  func applyFontSize(_ size: Double) {
    fontSize = CGFloat(size).clamped(to: minFontSize...maxFontSize)
    applyFont()
  }

  func applyTheme(_ record: TerminalThemeRecord) {
    theme = TerminalTheme(record: record)
    theme.apply(to: terminalView)
  }

  func applyCursorStyle(_ name: String) {
    switch name {
    case "bar":
      cursorStyle = .steadyBar
    case "underline":
      cursorStyle = .steadyUnderline
    default:
      cursorStyle = .steadyBlock
    }
    applyCursorStyleValue()
  }

  func sendInput(base64: String) {
    guard let bytes = Data(base64Encoded: base64) else {
      return
    }
    terminalView.send(data: ArraySlice(bytes))
  }

  func paste(text: String) {
    terminalView.send(txt: text)
  }

  func pasteFromClipboard() {
    guard let text = UIPasteboard.general.string, !text.isEmpty else {
      return
    }
    terminalView.send(txt: text)
  }

  func copySelection() {
    guard
      let text = terminalView.getSelection()?.trimmingCharacters(in: .whitespacesAndNewlines),
      !text.isEmpty
    else {
      return
    }
    UIPasteboard.general.string = text
    terminalView.selectNone()
  }

  func scrollToBottom() {
    terminalView.scroll(toPosition: 1)
  }

  public func onData(_ bytes: Data) {
    DispatchQueue.main.async { [weak self] in
      self?.terminalView.feed(byteArray: ArraySlice(bytes))
    }
  }

  public func onClosed(exitStatus: Int?, error: String?) {
    DispatchQueue.main.async { [weak self] in
      self?.closeTransport(exitStatus: exitStatus, error: error)
    }
  }

  public func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    guard terminalView.bounds.width > 0, terminalView.bounds.height > 0 else {
      return
    }
    guard newCols != appliedCols || newRows != appliedRows else {
      return
    }

    appliedCols = newCols
    appliedRows = newRows
    self.source?.resize(cols: newCols, rows: newRows)
    onResize(["cols": newCols, "rows": newRows])
  }

  public func setTerminalTitle(source: TerminalView, title: String) {
    let value: Any = title.isEmpty ? NSNull() : title
    onTitleChange(["title": value])
  }

  public func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {
  }

  public func send(source: TerminalView, data: ArraySlice<UInt8>) {
    write(Data(data))
  }

  public func scrolled(source: TerminalView, position: Double) {
  }

  public func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
    onLinkPress(["url": link])
  }

  public func bell(source: TerminalView) {
    onBell()
  }

  public func clipboardCopy(source: TerminalView, content: Data) {
    UIPasteboard.general.string = String(decoding: content, as: UTF8.self)
  }

  public func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {
  }

  public func rangeChanged(source: TerminalView, startY: Int, endY: Int) {
  }

  @objc private func handlePinch(_ recognizer: UIPinchGestureRecognizer) {
    guard recognizer.state == .changed else {
      return
    }
    scaleAccumulator *= recognizer.scale
    recognizer.scale = 1

    if scaleAccumulator >= zoomStep {
      changeFontSize(by: 1)
    } else if scaleAccumulator <= 1 / zoomStep {
      changeFontSize(by: -1)
    }
  }

  @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
    guard recognizer.state == .ended else {
      return
    }
    if let url = link(at: recognizer.location(in: terminalView)) {
      onLinkPress(["url": url])
      return
    }
    requestTerminalFocus()
  }

  private func link(at point: CGPoint) -> String? {
    let terminal = terminalView.getTerminal()
    let cols = terminal.cols
    let rows = terminal.rows
    guard cols > 0, rows > 0 else {
      return nil
    }

    let cellWidth = terminalView.bounds.width / CGFloat(cols)
    let cellHeight = terminalView.bounds.height / CGFloat(rows)
    guard cellWidth > 0, cellHeight > 0 else {
      return nil
    }

    let column = min(max(Int(point.x / cellWidth), 0), cols - 1)
    let row = min(max(Int(point.y / cellHeight), 0), rows - 1)

    var line = ""
    line.reserveCapacity(cols)
    for index in 0..<cols {
      line.append(terminal.getCharacter(col: index, row: row) ?? " ")
    }
    return UrlDetector.find(line, column: column)
  }

  private func write(_ bytes: Data) {
    // A closed transport stays closed until a new source is bound: later writes
    // are dropped here, because the close notice and event already went out.
    if transportClosed {
      return
    }
    guard let source else {
      closeTransport(exitStatus: nil, error: "terminal source '\(sourceId ?? "")' is not bound")
      return
    }
    source.write(bytes)
  }

  private func closeTransport(exitStatus: Int?, error: String?) {
    guard !transportClosed else {
      return
    }
    transportClosed = true
    updateFocus()
    feedCloseNotice(exitStatus: exitStatus, error: error)
    let errorValue: Any = error.map { $0 as Any } ?? NSNull()
    onClosed(["exitStatus": exitStatus ?? 0, "error": errorValue])
  }

  private func feedCloseNotice(exitStatus: Int?, error: String?) {
    var description = "\r\n[Connection closed"
    if let error {
      description += ": \(error)"
    } else if let exitStatus, exitStatus != 0 {
      description += " (code \(exitStatus))"
    }
    description += "]\r\n"
    terminalView.feed(text: description)
  }

  private func changeFontSize(by delta: CGFloat) {
    let next = (fontSize + delta).clamped(to: minFontSize...maxFontSize)
    guard next != fontSize else {
      return
    }

    fontSize = next
    applyFont()
    onFontSizeChange(["fontSize": Int(next.rounded())])
    scaleAccumulator = 1
  }

  private func applyFont() {
    let font = fontFamily.flatMap { UIFont(name: $0, size: fontSize) }
      ?? UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    terminalView.font = font
  }

  private func applyCursorStyleValue() {
    let terminal = terminalView.getTerminal()
    terminal.options.cursorStyle = cursorStyle
    terminalView.cursorStyleChanged(source: terminal, newStyle: cursorStyle)
  }

  private func installTerminal() {
    let view = SshTerminalView(frame: .zero)
    view.translatesAutoresizingMaskIntoConstraints = false
    view.inputAccessoryView = nil
    view.getTerminal().changeHistorySize(transcriptRows)
    terminalView = view

    addSubview(view)
    NSLayoutConstraint.activate([
      view.leadingAnchor.constraint(equalTo: leadingAnchor),
      view.trailingAnchor.constraint(equalTo: trailingAnchor),
      view.topAnchor.constraint(equalTo: topAnchor),
      view.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])

    let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
    tap.cancelsTouchesInView = false
    view.addGestureRecognizer(tap)

    appliedCols = 0
    appliedRows = 0
    applyFont()
    applyCursorStyleValue()
    theme.apply(to: view)

    view.onSelectionChanged = { [weak self] selecting in
      self?.onSelectionChange(["selecting": selecting])
    }
    view.terminalDelegate = self
  }

  private func replaceTerminal() {
    terminalView.removeFromSuperview()
    terminalView.terminalDelegate = nil
    installTerminal()
  }

  private func rebindSource() {
    let next = sourceId.flatMap { TerminalSourceRegistry.shared.find($0) }
    if next === source {
      return
    }

    source?.setSink(nil)
    source = next
    next?.setSink(self)

    if next != nil, transportClosed {
      transportClosed = false
      replaceTerminal()
    }

    if next != nil, appliedCols > 0 {
      next?.resize(cols: appliedCols, rows: appliedRows)
    }
    updateFocus()
  }

  private func updateFocus() {
    let accepting = canAcceptInput()
    terminalView.acceptsFocus = accepting
    if autoFocus, accepting {
      requestTerminalFocus()
    } else {
      _ = terminalView.resignFirstResponder()
    }
  }

  private func canAcceptInput() -> Bool {
    return source != nil && !transportClosed
  }

  private func requestTerminalFocus() {
    guard canAcceptInput(), window != nil, !terminalView.isFirstResponder else {
      return
    }
    _ = terminalView.becomeFirstResponder()
  }
}

private extension CGFloat {
  func clamped(to range: ClosedRange<CGFloat>) -> CGFloat {
    return Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
  }
}
