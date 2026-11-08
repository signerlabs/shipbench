//
//  KeychainStore.swift
//  PetBook
//
//  零依赖 Keychain 封装（纯 Security 框架）。
//  仅存两条字符串：accessToken / refreshToken。
//  token 必须落 Keychain 而非 UserDefaults —— 杀进程后复用、且系统级加密保护。
//

import Foundation
import Security

/// 极简 Keychain 字符串读写器。所有条目用同一 service，按 account（key）区分。
enum KeychainStore {

    /// Keychain service 标识（同一 app 内全局唯一即可）。
    private static let service = "com.example.PetBook.auth"

    /// 读取某个 key 对应的字符串；不存在返回 nil。
    static func read(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let str = String(data: data, encoding: .utf8) else {
            return nil
        }
        return str
    }

    /// 写入 / 更新某个 key 的字符串（upsert）。失败仅打印，不抛——token 存储失败不应使流程崩溃。
    static func save(_ value: String, for key: String) {
        guard let data = value.data(using: .utf8) else { return }

        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]

        // 先尝试更新已有条目
        let attributes: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)

        if updateStatus == errSecItemNotFound {
            // 不存在 → 新增
            var addQuery = baseQuery
            addQuery[kSecValueData as String] = data
            // 仅本设备、首次解锁后可读（不随 iCloud Keychain 同步，避免多设备 token 串号）
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            if addStatus != errSecSuccess {
                print("[Keychain] add failed for \(key): \(addStatus)")
            }
        } else if updateStatus != errSecSuccess {
            print("[Keychain] update failed for \(key): \(updateStatus)")
        }
    }

    /// 删除某个 key（登出 / token 失效时清理）。
    static func delete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - 固定 key 名

    enum Key {
        static let accessToken = "accessToken"
        static let refreshToken = "refreshToken"
    }
}
