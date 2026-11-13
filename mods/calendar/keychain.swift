import AppKit
import Security

let service = "herdr-calendar-feed"
let account = NSUserName()
let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
if CommandLine.arguments.contains("save") {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    // A standalone AppKit process needs an Edit menu for standard keyboard
    // shortcuts such as Command-V to reach the field editor.
    let menu = NSMenu()
    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editItem.submenu = editMenu
    menu.addItem(editItem)
    app.mainMenu = menu
    let alert = NSAlert()
    alert.messageText = "Link Google Calendar"
    alert.informativeText = "Paste the secret iCal address. It will be saved in your macOS Keychain."
    alert.addButton(withTitle: "Save")
    alert.addButton(withTitle: "Cancel")
    let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 420, height: 26))
    alert.accessoryView = field
    alert.window.initialFirstResponder = field
    app.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { exit(2) }
    let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: value), url.scheme == "https", url.host == "calendar.google.com", url.path.contains("/ical/") else { fputs("Enter a Google Calendar HTTPS iCal address.\n", stderr); exit(1) }
    let data = Data(value.utf8)
    let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData as String] = data
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { exit(1) }
    } else if status != errSecSuccess { exit(1) }
} else if CommandLine.arguments.contains("delete") {
    let status = SecItemDelete(query as CFDictionary)
    if status != errSecSuccess && status != errSecItemNotFound { exit(1) }
} else {
    var get = query
    get[kSecReturnData as String] = true
    get[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(get as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { exit(2) }
    FileHandle.standardOutput.write(data)
}
