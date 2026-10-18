// Real mouse clicks and key presses for the macOS CI checks (scripts/mac-tray-close-check.sh).
// Built on the runner with `swiftc -O scripts/mac-ui.swift -o "$RUNNER_TEMP/mac-ui"`; never shipped.
//
//   mac-ui click <x> <y>          move there, then a left click (global screen points, top-left origin,
//                                 the same space as Electron's getBounds())
//   mac-ui keys <code> [<code>...] key presses by virtual key code (31 o, 35 p, 14 e, 45 n, 36 Return,
//                                 53 Escape, 125 Down)
//   mac-ui where                  the pointer's position
//
// Posted at the HID level, so they reach the menu bar, a menu and a window's buttons as a real
// mouse and keyboard would -- and pass through Typd's own event tap on the way.

import CoreGraphics
import Foundation

let args = CommandLine.arguments
let source = CGEventSource(stateID: .hidSystemState)

func post(_ event: CGEvent?) {
    event?.post(tap: .cghidEventTap)
}

func click(_ x: Double, _ y: Double) {
    let p = CGPoint(x: x, y: y)
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    usleep(200_000)
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left))
    usleep(90_000)
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left))
    usleep(100_000)
}

func key(_ code: CGKeyCode) {
    post(CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true))
    usleep(40_000)
    post(CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false))
    usleep(80_000)
}

guard args.count >= 2 else {
    FileHandle.standardError.write("usage: mac-ui click <x> <y> | keys <code>... | where\n".data(using: .utf8)!)
    exit(2)
}

switch args[1] {
case "click":
    guard args.count == 4, let x = Double(args[2]), let y = Double(args[3]) else { exit(2) }
    click(x, y)
    print("clicked \(x),\(y)")
case "keys":
    for a in args.dropFirst(2) {
        guard let c = UInt16(a) else { exit(2) }
        key(CGKeyCode(c))
    }
    print("pressed \(args.dropFirst(2).joined(separator: " "))")
case "where":
    let p = CGEvent(source: nil)?.location ?? .zero
    print("\(p.x),\(p.y)")
default:
    exit(2)
}
