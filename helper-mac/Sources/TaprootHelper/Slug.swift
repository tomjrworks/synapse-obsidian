import Foundation

enum Slug {
    static func from(_ name: String) -> String? {
        let allowed: Set<Character> = Set("abcdefghijklmnopqrstuvwxyz0123456789")
        let lowered = name.lowercased()
        var out = ""
        var lastWasDash = false
        for ch in lowered {
            if allowed.contains(ch) {
                out.append(ch)
                lastWasDash = false
            } else if ch.isASCII {
                if !lastWasDash && !out.isEmpty {
                    out.append("-")
                    lastWasDash = true
                }
            }
            // Non-ASCII characters are stripped silently (Stage 1 simplification).
        }
        while out.hasSuffix("-") { out.removeLast() }
        return out.isEmpty ? nil : out
    }
}
