// macOS's own alerts, for the Mac CI's microphone check (scripts/mac-mic-check.sh); never shipped.
// Built on the runner with `swiftc -O scripts/mac-alert.swift -o "$RUNNER_TEMP/mac-alert"`.
//
//   mac-alert windows                 on-screen windows, front first: owner, layer, size (no titles:
//                                     those would need Screen Recording)
//   mac-alert texts <process>         that process's static texts and buttons, through Accessibility
//                                     (macOS's privacy prompt is UserNotificationCenter's alert)
//   mac-alert press <process> <title> press that button (a curly apostrophe matches a straight one)
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
default:
    print("usage: mac-alert windows | texts <process> | press <process> <button>")
}
