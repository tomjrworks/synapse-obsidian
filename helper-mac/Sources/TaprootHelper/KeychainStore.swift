import Foundation
import Security

enum KeychainError: Error, Equatable {
    case unhandled(OSStatus)
    case decodingFailed
}

/// Stores per-workspace bearer tokens in the macOS Keychain.
///
/// Account format: `workspace.<uuid>.bearer`. Accessibility is
/// `kSecAttrAccessibleAfterFirstUnlock` so reads after device unlock don't prompt
/// on every launch (per T11.1 risk register).
struct KeychainStore {
    let service: String

    init(service: String = "com.taproot.helper") {
        self.service = service
    }

    private func account(for workspaceID: UUID) -> String {
        return "workspace.\(workspaceID.uuidString).bearer"
    }

    func store(workspaceID: UUID, bearer: String) throws {
        guard let data = bearer.data(using: .utf8) else {
            throw KeychainError.decodingFailed
        }
        let acct = account(for: workspaceID)

        // Delete-then-add gives idempotent overwrite without errSecDuplicateItem.
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: acct,
        ]
        SecItemDelete(baseQuery as CFDictionary)

        var addAttrs = baseQuery
        addAttrs[kSecValueData as String] = data
        addAttrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let status = SecItemAdd(addAttrs as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.unhandled(status)
        }
    }

    func retrieve(workspaceID: UUID) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: workspaceID),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw KeychainError.unhandled(status)
        }
        guard let data = item as? Data,
              let bearer = String(data: data, encoding: .utf8) else {
            throw KeychainError.decodingFailed
        }
        return bearer
    }

    func delete(workspaceID: UUID) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: workspaceID),
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unhandled(status)
        }
    }

    /// Returns all `(workspaceID, bearer)` pairs stored under this service.
    /// Called by AppDelegate at launch to repopulate the in-memory `[Workspace]`.
    ///
    /// Two-pass: first fetch all account attributes under the service, then
    /// fetch each value via `retrieve`. Combining `kSecReturnAttributes` +
    /// `kSecReturnData` + `kSecMatchLimitAll` returns `errSecParam` on macOS.
    func retrieveAll() throws -> [(UUID, String)] {
        let attrQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var attrResult: CFTypeRef?
        let status = SecItemCopyMatching(attrQuery as CFDictionary, &attrResult)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else {
            throw KeychainError.unhandled(status)
        }
        guard let entries = attrResult as? [[String: Any]] else { return [] }

        var results: [(UUID, String)] = []
        for entry in entries {
            guard let acct = entry[kSecAttrAccount as String] as? String else { continue }
            // Account format: "workspace.<uuid>.bearer"
            let parts = acct.split(separator: ".")
            guard parts.count == 3,
                  parts[0] == "workspace",
                  parts[2] == "bearer",
                  let id = UUID(uuidString: String(parts[1])) else {
                continue
            }
            if let bearer = try retrieve(workspaceID: id) {
                results.append((id, bearer))
            }
        }
        return results
    }

    /// Test helper — deletes every entry under the configured service. Tests
    /// instantiate with a `.tests` service so this never touches production.
    func deleteAllForService() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unhandled(status)
        }
    }
}
