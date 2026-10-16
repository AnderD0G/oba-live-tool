import AppKit
import ApplicationServices
import Foundation

// The helper deliberately accepts no application name, key code or script from callers.
private let studioBundleID = "com.tiktok.livestudio.desktop"
private let hotkeyLabel = "Control+Option+M"

private struct State: Encodable {
    let supported = true
    let running: Bool
    let accessGranted: Bool
    let hotkey = hotkeyLabel
    let micState = "unknown"
    let sent: Bool?
    let message: String
}

private struct HelperError: Encodable {
    let code: String
    let message: String
}

private struct Result: Encodable {
    let ok: Bool
    let data: State?
    let error: HelperError?
}

private func emit(_ result: Result) {
    guard let data = try? JSONEncoder().encode(result), let json = String(data: data, encoding: .utf8) else { exit(1) }
    print(json)
}

private func fail(_ code: String, _ message: String) {
    emit(Result(ok: false, data: nil, error: HelperError(code: code, message: message)))
}

private func hasAccess() -> Bool {
    CGPreflightPostEventAccess() || AXIsProcessTrusted()
}

private func studioApplication() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: studioBundleID).first { !$0.isTerminated }
}

private func isFrontmost(_ application: NSRunningApplication) -> Bool {
    NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier
}

private func waitUntilFrontmost(_ application: NSRunningApplication) -> Bool {
    let deadline = Date().addingTimeInterval(1.5)
    repeat {
        if isFrontmost(application) { return true }
        if application.isTerminated { return false }
        RunLoop.current.run(until: Date().addingTimeInterval(0.025))
    } while Date() < deadline
    return isFrontmost(application)
}

private func main() {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard arguments.count == 1, ["--status", "--request-access", "--toggle"].contains(arguments[0]) else {
        fail("STUDIO_MIC_INVALID_COMMAND", "不支持的麦克风热键请求。")
        return
    }
    let action = arguments[0]
    if action == "--status" || action == "--request-access" {
        // Merely checking status never opens a permission prompt or sends an event.
        if action == "--request-access" && !hasAccess() { _ = CGRequestPostEventAccess() }
        let granted = hasAccess()
        let running = studioApplication() != nil
        let message = !running ? "请先打开 TikTok LIVE Studio。"
            : !granted ? "请在系统设置的隐私与安全性中允许 OBA 使用辅助功能，然后重新检查状态。"
            : "热键助手已就绪；请在 TikTok LIVE Studio 中确认麦克风状态。"
        emit(Result(ok: true, data: State(running: running, accessGranted: granted, sent: nil, message: message), error: nil))
        return
    }
    guard let studio = studioApplication() else {
        fail("STUDIO_MIC_NOT_RUNNING", "未找到正在运行的 TikTok LIVE Studio，未发送热键。")
        return
    }
    guard hasAccess() else {
        fail("STUDIO_MIC_PERMISSION_REQUIRED", "尚未获得系统辅助功能权限，未发送热键。请点击授权后重新检查状态。")
        return
    }
    let previousApplication = NSWorkspace.shared.frontmostApplication
    let needsActivation = !isFrontmost(studio)
    if needsActivation {
        _ = studio.activate(options: [.activateIgnoringOtherApps])
        guard waitUntilFrontmost(studio) else {
            fail("STUDIO_MIC_FOCUS_FAILED", "无法激活 TikTok LIVE Studio，未发送热键。")
            return
        }
    }
    // Studio can be configured to handle shortcuts only while focused. Recheck just before posting.
    guard isFrontmost(studio), !studio.isTerminated else {
        fail("STUDIO_MIC_FOCUS_FAILED", "TikTok LIVE Studio 已失去焦点，未发送热键。")
        return
    }
    guard let source = CGEventSource(stateID: .combinedSessionState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: 46, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 46, keyDown: false) else {
        fail("STUDIO_MIC_EVENT_FAILED", "无法创建麦克风热键事件，未发送热键。")
        return
    }
    let modifiers: CGEventFlags = [.maskControl, .maskAlternate]
    down.flags = modifiers
    up.flags = modifiers
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    RunLoop.current.run(until: Date().addingTimeInterval(0.15))
    // Restore the prior app only if the user has not switched elsewhere in the meantime.
    if needsActivation, isFrontmost(studio), let previous = previousApplication,
       !previous.isTerminated, previous.processIdentifier != studio.processIdentifier {
        _ = previous.activate(options: [.activateIgnoringOtherApps])
    }
    emit(Result(ok: true, data: State(running: true, accessGranted: true, sent: true,
        message: "已发送麦克风切换热键，请在 TikTok LIVE Studio 中确认是否已闭麦。"), error: nil))
}

main()
