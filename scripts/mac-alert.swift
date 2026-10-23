// macOS's own alerts, for the Mac CI's microphone check (scripts/mac-mic-check.sh); never shipped.
// Built on the runner with `swiftc -O scripts/mac-alert.swift -o "$RUNNER_TEMP/mac-alert"`.
//
//   mac-alert windows                 on-screen windows, front first: owner, layer, size (no titles:
//                                     those would need Screen Recording)
//   mac-alert texts <process>         that process's static texts and buttons, through Accessibility
//                                     (macOS's privacy prompt is UserNotificationCenter's alert)
//   mac-alert press <process> <title> press that button (a curly apostrophe matches a straight one)
//   mac-alert click <process> <title> a real mouse click on that button's centre (HID level), as a
//                                     person clicks: Typd's own dialogs (Electron's NSAlert in
//                                     runModal) ignored AXPress in CI
//
// Exit 0; "AX not trusted" when this runner may not use Accessibility (the check then says so).

import ApplicationServices
import Cocoa

let args = CommandLine.arguments

func attr(_ e: AXUIElement, _ n: String) -> String {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success, let x = v else { return "" }
    return (x as? String) ?? ""
}

func walk(_ e: AXUIElement, _ depth: Int, _ visit: (AXUIElement, String, String, String) -> Void) {
    let role = attr(e, kAXRoleAttribute)
    if role == "AXMenuBar" { return }
    visit(e, role, attr(e, kAXTitleAttribute), attr(e, kAXValueAttribute))
    var k: CFTypeRef?
    if depth < 10, AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &k) == .success, let kids = k as? [AXUIElement] {
        for c in kids { walk(c, depth + 1, visit) }
    }
}

func apps(_ name: String) -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { $0.localizedName == name || $0.bundleIdentifier == name }
}

switch args.count > 1 ? args[1] : "" {
case "windows":
    let skip = ["Window Server", "Dock", "Control Center", "SystemUIServer", "Wallpaper", "Notification Center", "Spotlight", "TextInputMenuAgent"]
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
    for w in list {
        let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
        let layer = w[kCGWindowLayer as String] as? Int ?? 0
        let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
        if layer >= 0 && layer < 25 && !skip.contains(owner) {
            print("window: \(owner) layer \(layer) \(b["Width"] ?? 0)x\(b["Height"] ?? 0)")
        }
    }
case "texts" where args.count > 2:
    if !AXIsProcessTrusted() { print("AX not trusted"); break }
    for a in apps(args[2]) {
        walk(AXUIElementCreateApplication(a.processIdentifier), 0) { _, role, title, value in
            if role == "AXStaticText" && !value.isEmpty { print("text: \(value)") }
            if role == "AXButton" && !title.isEmpty { print("button: \(title)") }
        }
    }
case "press" where args.count > 3:
    if !AXIsProcessTrusted() { print("AX not trusted"); break }
    let want = args[3].replacingOccurrences(of: "\u{2019}", with: "'")
    var done = false
    for a in apps(args[2]) where !done {
        walk(AXUIElementCreateApplication(a.processIdentifier), 0) { e, role, title, _ in
            if !done && role == "AXButton" && title.replacingOccurrences(of: "\u{2019}", with: "'") == want {
                print("pressed \(title): \(AXUIElementPerformAction(e, kAXPressAction as CFString).rawValue)")
                done = true
            }
        }
    }
    if !done { print("no button \(args[3])") }
case "click" where args.count > 3:
    if !AXIsProcessTrusted() { print("AX not trusted"); break }
    let want = args[3].replacingOccurrences(of: "\u{2019}", with: "'")
    // The button's centre on screen, or nil when the process shows no such button (any more).
    func find() -> CGPoint? {
        var at: CGPoint? = nil
        for a in apps(args[2]) where at == nil {
            walk(AXUIElementCreateApplication(a.processIdentifier), 0) { e, role, title, _ in
                guard at == nil, role == "AXButton", title.replacingOccurrences(of: "\u{2019}", with: "'") == want else { return }
                var pv: CFTypeRef?
                var sv: CFTypeRef?
                var p = CGPoint.zero
                var z = CGSize.zero
                if AXUIElementCopyAttributeValue(e, kAXPositionAttribute as CFString, &pv) == .success, let pv = pv,
                   AXUIElementCopyAttributeValue(e, kAXSizeAttribute as CFString, &sv) == .success, let sv = sv {
                    AXValueGetValue(pv as! AXValue, .cgPoint, &p)
                    AXValueGetValue(sv as! AXValue, .cgSize, &z)
                    at = CGPoint(x: p.x + z.width / 2, y: p.y + z.height / 2)
                }
            }
        }
        return at
    }
    // A menu-bar app's alert is often not in front: activate the app first (a click on a window of an
    // app that is not active only activates it), then click; click again while the button is still there.
    for a in apps(args[2]) { _ = a.activate(options: [.activateAllWindows]) }
    usleep(500_000)
    let src = CGEventSource(stateID: .hidSystemState)
    var tries = 0
    var last: CGPoint? = nil
    while tries < 3, let c = find() {
        tries += 1
        last = c
        CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: c, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(200_000)
        CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: c, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(90_000)
        CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: c, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(1_200_000)
    }
    if let c = last {
        print("clicked \(args[3]) at \(Int(c.x)),\(Int(c.y)) (\(tries) click\(tries == 1 ? "" : "s")); " + (find() == nil ? "it is gone" : "it is STILL there"))
    } else {
        print("no button \(args[3])")
    }
default:
    print("usage: mac-alert windows | texts <process> | press <process> <button> | click <process> <button>")
}
