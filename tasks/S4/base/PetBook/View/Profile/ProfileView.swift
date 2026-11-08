//
//  ProfileView.swift
//  PetBook
//
//  Profile tab —— 轻账号设置。
//  从上到下：身份头条（缩写/爪印头像 + Edit profile/Sign in；用户信息字段收进 Edit profile sheet）
//  → ABOUT（条款外链）→ Built with ShipSwift（推广位 + 产品矩阵案例）→ 危险区（删除账号，二次确认）。
//  设置行参考另一个 App 的设置页：每行带彩色 SF Symbol（生动）；条款跳外链；底部 ShipSwift 引流。
//  Home type 驱动 HDB 合规判定，是 P0 唯一必须真实可写的字段；其余文本字段走通用编辑 sheet。
//  （Emergency contact / 语言切换字段已移除——非 P0；见 PRD §1.3 / §4.7。）
//

import SwiftUI
import AuthenticationServices
import CryptoKit

struct ProfileView: View {
    @Environment(PetBookStore.self) private var store
    @Environment(\.openURL) private var openURL

    // 「Edit profile」整合编辑 sheet（用户信息字段集中到这里）
    @State private var editingProfile = false

    // 访客态「Sign in」打开的登录 sheet（内含原生 Sign in with Apple 按钮）
    @State private var showSignInSheet = false

    var body: some View {
        Form {
            identityHeader
            aboutSection
            supportSection
            shipSwiftSection
            theEnd
        }
        .scrollContentBackground(.hidden)
        .background(Color.ppBackground.ignoresSafeArea())
        .scrollIndicators(.hidden)
        .navigationBarTitleDisplayMode(.inline)
        .ppBellToolbar()
        .ppShowsRootTabBar()
        .sheet(isPresented: $editingProfile) { EditProfileSheet() }
        .sheet(isPresented: $showSignInSheet) { SignInSheet() }
    }

    // MARK: - 身份头条

    private var identityHeader: some View {
        Section {
            Group {
                if store.owner.hasLinkedAppleID {
                    // 已登录：缩写头像 + 名字 + 邮箱 + 「Edit profile」编辑入口
                    identityCard(
                        avatar: identityAvatar(initials: initials),
                        title: displayNameOrFallback,
                        subtitle: store.owner.email,
                        actionLabel: "Edit profile",
                        action: { editingProfile = true }
                    )
                } else {
                    // 访客模式：爪印头像 + 引导文案 + 「Sign in」触发 Apple 登录
                    identityCard(
                        avatar: identityAvatar(initials: nil),
                        title: "Guest mode",
                        subtitle: "Sign in to sync your records to the cloud.",
                        actionLabel: "Sign in",
                        action: { showSignInSheet = true }
                    )
                }
            }
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: PPSpacing.xxxl,
                                  leading: 0,
                                  bottom: PPSpacing.xxxl,
                                  trailing: 0))
    }

    /// 身份卡（登录态 / 访客态共用）：圆形头像 + 标题 + 副标题 + 橙色动作链接，整体白卡。
    @ViewBuilder
    private func identityCard<A: View>(
        avatar: A,
        title: String,
        subtitle: String?,
        actionLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        HStack(spacing: PPSpacing.lg) {
            avatar
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.title2)
                    .fontWeight(.bold)
                    .foregroundStyle(Color.ppTextPrimary)
                    .lineLimit(1)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(Color.ppTextSecondary)
                        .lineLimit(1)
                }
                Button(action: action) {
                    HStack(spacing: 2) {
                        Text(actionLabel)
                            .font(.subheadline)
                            .fontWeight(.semibold)
                        Image(systemName: "chevron.right")
                            .font(.caption2)
                            .fontWeight(.semibold)
                    }
                    .foregroundStyle(Color.ppPrimary)
                }
                .buttonStyle(.plain)
                .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }

    /// 圆形头像：浅橙底 + 橙色描边圈；有缩写显缩写，否则显爪印（访客）。
    @ViewBuilder
    private func identityAvatar(initials: String?) -> some View {
        ZStack {
            Circle().fill(Color.ppPrimary.opacity(0.15))
            if let initials, !initials.isEmpty {
                Text(initials)
                    .font(.title2)
                    .fontWeight(.bold)
                    .foregroundStyle(Color.ppPrimary)
            } else {
                Image(systemName: "pawprint.fill")
                    .font(.title2)
                    .foregroundStyle(Color.ppPrimary)
            }
        }
        .frame(width: 72, height: 72)
        .overlay(Circle().strokeBorder(Color.ppPrimary, lineWidth: 3))
    }

    /// 名字首字母缩写（最多两段，如 "Jane Doe" → "JD"）；无名字则 nil（头像退回爪印）。
    private var initials: String? {
        let chars = store.owner.displayName
            .split(separator: " ")
            .prefix(2)
            .compactMap { $0.first }
        return chars.isEmpty ? nil : String(chars).uppercased()
    }

    /// 登录态名字：空则兜底 "Pet parent"（Apple 未回名字时不至于空白）。
    private var displayNameOrFallback: String {
        let name = store.owner.displayName.trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? "Pet parent" : name
    }

    // MARK: - ABOUT（条款外链，占位域名）

    private var aboutSection: some View {
        Section("About") {
            ProfileRow(label: "Privacy Policy", icon: "hand.raised.fill", iconColor: .teal, isExternalLink: true) {
                openURL(URL(string: "https://shipswift.app/petbook/privacy")!)
            }
            ProfileRow(label: "Terms of Service", icon: "doc.text.fill", iconColor: .indigo, isExternalLink: true, isLast: true) {
                openURL(URL(string: "https://shipswift.app/petbook/terms")!)
            }
        }
        .listRowBackground(Color.ppSurface)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
    }

    // MARK: - Support PetBook（分享 app + 评分）

    private static let appStoreURL = URL(string: "https://apps.apple.com/app/id0000000000")!
    private static let reviewURL = URL(string: "https://apps.apple.com/app/id0000000000?action=write-review")!
    private static let shareMessage = "PetBook — everything you need to have a pet in Singapore. Pet records, reminders, HDB/PALS licensing help, and 300+ AVS-licensed vets & pet services. 🐾"

    private var supportSection: some View {
        Section("Support PetBook") {
            // 分享 app（原生 ShareLink，分享 App Store 链接 + 文案）
            ShareLink(item: Self.appStoreURL, subject: Text("PetBook"), message: Text(Self.shareMessage)) {
                shareRowLabel
            }
            .buttonStyle(.plain)

            // 给我们评分（跳 App Store 评价页）
            ProfileRow(label: "Rate PetBook", icon: "star.fill", iconColor: .yellow, isExternalLink: true, isLast: true) {
                openURL(Self.reviewURL)
            }
        }
        .listRowBackground(Color.ppSurface)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
    }

    /// 分享行 label（模仿 ProfileRow 外观：彩色 icon + 文字 + chevron + 底分隔线）。
    private var shareRowLabel: some View {
        VStack(spacing: 0) {
            HStack(spacing: PPSpacing.md) {
                Image(systemName: "square.and.arrow.up")
                    .foregroundStyle(Color.ppPrimary)
                    .frame(width: 36, height: 36)
                    .background(Color.ppPrimary.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                Text("Share PetBook")
                    .foregroundStyle(Color.ppTextPrimary)
                Spacer(minLength: PPSpacing.md)
                Image(systemName: "chevron.right")
                    .foregroundStyle(Color.ppTextSecondary)
            }
            .padding(.horizontal, PPSpacing.md)
            .padding(.vertical, PPSpacing.md)
            Rectangle()
                .fill(Color.ppBorder)
                .frame(height: 1)
                .padding(.leading, PPSpacing.md)
        }
        .contentShape(.rect)
    }

    // MARK: - Built with ShipSwift（推广位）

    private var shipSwiftSection: some View {
        Section("Built with ShipSwift") {
            AppPromoRow(
                logo: .shipSwiftLogo,
                name: "ShipSwift",
                subtitle: "Ship production-ready iOS apps faster",
                isLast: true
            ) {
                openURL(URL(string: "https://apps.apple.com/app/id6759209764")!)
            }
        }
        .listRowBackground(Color.ppSurface)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
    }

    private var theEnd: some View {
        Section {
            HStack {
                Spacer()
                Rectangle()
                    .frame(width: 80, height: 0.5)
                Text("The End")
                Rectangle()
                    .frame(width: 80, height: 0.5)
                Spacer()
            }
            .padding(.bottom, 150)
        }
        .foregroundStyle(.ppTextSecondary)
        .font(.footnote)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
    }

}

// MARK: - Sign in sheet（访客态「Sign in」打开，内置原生 Sign in with Apple）

/// 登录 sheet：原生 SignInWithAppleButton + nonce 防重放，回调 store.linkApple（双路径）。
/// 用官方按钮（替代此前自写的协调器 class），最合规、最省事；登录成功后自动 dismiss。
private struct SignInSheet: View {
    @Environment(PetBookStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    // SIWA 防重放 nonce 的原始值：onRequest 生成 → onCompletion 透传后端校验
    @State private var currentNonce: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: PPSpacing.xl) {
                VStack(spacing: PPSpacing.md) {
                    Image(systemName: "pawprint.circle.fill")
                        .font(.system(size: 56))
                        .foregroundStyle(Color.ppPrimary)
                    Text("Sign in to PetBook")
                        .font(.title2)
                        .fontWeight(.bold)
                        .foregroundStyle(Color.ppTextPrimary)
                    Text("Link your Apple ID so you never lose your pet's records.")
                        .font(.subheadline)
                        .foregroundStyle(Color.ppTextSecondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, PPSpacing.xl)

                SignInWithAppleButton(.signIn) { request in
                    let nonce = randomNonceString()
                    currentNonce = nonce
                    request.requestedScopes = [.fullName, .email]
                    request.nonce = sha256(nonce)   // Apple 把 hash 烤进 idToken，后端用 raw nonce 校验
                } onCompletion: { result in
                    handleAppleAuth(result)
                }
                .signInWithAppleButtonStyle(.black)
                .frame(height: 50)
                .clipShape(RoundedRectangle(cornerRadius: PPRadius.md, style: .continuous))

                Spacer()
            }
            .padding(PPSpacing.xl)
            .frame(maxWidth: .infinity)
            .background(Color.ppBackground.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                    }
                    .tint(Color.ppTextSecondary)
                }
            }
        }
        .presentationDetents([.medium])
    }

    /// 处理 Sign in with Apple 回调：取 identityToken + fullName → 调 store.linkApple；成功后 dismiss。
    private func handleAppleAuth(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .success(let auth):
            guard let credential = auth.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken,
                  let idToken = String(data: tokenData, encoding: .utf8) else {
                SWAlertManager.shared.show(.error, message: "Apple sign-in returned no token")
                return
            }
            // Apple 仅首次授权返回 fullName；拼成 "Given Family"（任一为空取有的那个）
            let fullName = [credential.fullName?.givenName, credential.fullName?.familyName]
                .compactMap { $0 }
                .joined(separator: " ")
            Task {
                // 成功 toast 由 store 内按 mode 区分发出（首次绑定 vs 换机找回）
                let ok = await store.linkApple(idToken: idToken, nonce: currentNonce, fullName: fullName.isEmpty ? nil : fullName)
                if ok { dismiss() }
            }
        case .failure(let error):
            // 用户主动取消不算错误，不打扰
            if let authError = error as? ASAuthorizationError, authError.code == .canceled { return }
            SWAlertManager.shared.show(.error, message: "Apple sign-in failed")
        }
    }

    // MARK: - SIWA nonce helpers（防重放：raw nonce 的 SHA256 给 Apple，raw 传后端）

    /// 生成随机 nonce 原始串（randomElement 在 Apple 平台底层用安全随机源）。
    private func randomNonceString(length: Int = 32) -> String {
        let charset: [Character] = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._")
        return String((0..<length).compactMap { _ in charset.randomElement() })
    }

    /// SHA256 → 小写十六进制串（作为 Apple request.nonce）。
    private func sha256(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Edit profile sheet（identityCard 点开，集中编辑用户信息字段）

/// 「Edit profile」整合编辑页：原 My details 的 owner 字段（名字 / 邮编 / 住宅 / 电话）
/// 从主页搬到这里，点 identityCard 的「Edit profile」打开。各行仍走 per-field 编辑 sheet。
private struct EditProfileSheet: View {
    @Environment(PetBookStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var editingHomeType = false
    @State private var editingField: EditableField?
    @State private var showDeleteConfirm = false

    var body: some View {
        NavigationStack {
            Form {
                Section("My details") {
                    ProfileRow(label: "Display name", icon: "person.fill", iconColor: .ppPrimary, value: store.owner.displayName) {
                        editingField = .displayName
                    }
                    ProfileRow(label: "Postal code", icon: "mappin.circle.fill", iconColor: .blue, value: store.owner.postalCode) {
                        editingField = .postalCode
                    }
                    // Home type 是 P0 重点：驱动 HDB 合规判定，必须真实可改
                    ProfileRow(label: "Home type", icon: "house.fill", iconColor: .green, value: store.owner.residenceType?.displayName) {
                        editingHomeType = true
                    }
                    ProfileRow(label: "Phone", icon: "phone.fill", iconColor: .orange, value: store.owner.primaryPhone, isLast: true) {
                        editingField = .phone
                    }
                }
                .listRowBackground(Color.ppSurface)
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)

                // 危险区：删除账号（二次确认，删成功后 dismiss 回访客态主页）
                Section {
                    Button {
                        showDeleteConfirm = true
                    } label: {
                        HStack(spacing: PPSpacing.sm) {
                            Image(systemName: "trash.fill")
                            Text("Delete account")
                        }
                        .foregroundStyle(Color.ppDanger)
                        .frame(maxWidth: .infinity)
                        .font(.subheadline)
                    }
                    .buttonStyle(.plain)
                }
                .listRowBackground(Color.clear)
            }
            .scrollContentBackground(.hidden)
            .presentationDetents([.medium, .large])
            .background(Color.ppBackground.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "checkmark")
                    }
                }
            }
            .sheet(isPresented: $editingHomeType) { HomeTypeSheet() }
            .sheet(item: $editingField) { field in TextFieldEditSheet(field: field) }
            .alert("Delete account?", isPresented: $showDeleteConfirm) {
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) {
                    Task {
                        let ok = await store.deleteAccount()
                        if ok {
                            SWAlertManager.shared.show(.success, message: "Account deleted")
                            dismiss()
                        }
                    }
                }
            } message: {
                Text("This will permanently remove your account and all pet records. This can't be undone.")
            }
        }
    }
}

// MARK: - 可编辑文本字段枚举（驱动通用编辑 sheet）

private enum EditableField: Identifiable {
    case displayName, postalCode, phone
    var id: String { title }

    var title: String {
        switch self {
        case .displayName: "Display name"
        case .postalCode:  "Postal code"
        case .phone:       "Phone"
        }
    }

    var placeholder: String {
        switch self {
        case .displayName: "Your name"
        case .postalCode:  "e.g. 297824"
        case .phone:       "e.g. +65 9123 4567"
        }
    }

    var keyboard: UIKeyboardType {
        switch self {
        case .postalCode: .numberPad
        case .phone:      .phonePad
        default:          .default
        }
    }
}

// MARK: - Section 行（label + 值/Add 占位 + 可选 chevron）

private struct ProfileRow: View {
    let label: String
    var icon: String? = nil
    var iconColor: Color = .ppPrimary
    var value: String? = nil
    /// 外链行：右侧用 arrow.up.right 外链箭头（参考 AppPromoRow），且不显示 value/Add
    var isExternalLink: Bool = false
    var isLast: Bool = false
    /// nil = 不可点（如 Version 行）
    var action: (() -> Void)? = nil

    var body: some View {
        Button {
            action?()
        } label: {
            VStack(spacing: 0) {
                HStack(spacing: PPSpacing.md) {
                    // leading 彩色 SF Symbol（生动，参考另一个 App 的设置页）
                    if let icon {
                        Image(systemName: icon)
                            .foregroundStyle(iconColor)
                            .frame(width: 36, height: 36)
                            .background(iconColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    Text(label)
                        .foregroundStyle(Color.ppTextPrimary)

                    Spacer(minLength: PPSpacing.md)

                    // 外链行只显外链箭头；普通行：有值显值 / 空值可编辑显灰 "Add"
                    if !isExternalLink {
                        if let value, !value.isEmpty {
                            Text(value)
                                .foregroundStyle(Color.ppTextSecondary)
                                .lineLimit(1)
                        } else if action != nil {
                            Text("Add")
                                .foregroundStyle(Color.ppTextSecondary.opacity(0.6))
                        }
                    }

                    if action != nil {
                        Image(systemName: isExternalLink ? "arrow.up.right" : "chevron.right")
                            .foregroundStyle(Color.ppTextSecondary)
                    }
                }
                .padding(.horizontal, PPSpacing.md)
                .padding(.vertical, PPSpacing.md)

                if !isLast {
                    Rectangle()
                        .fill(Color.ppBorder)
                        .frame(height: 1)
                        .padding(.leading, PPSpacing.md)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
    }
}

// MARK: - App 推广行（logo + 名 + 简介 + 外链箭头）

private struct AppPromoRow: View {
    let logo: ImageResource
    let name: String
    var subtitle: String? = nil
    var isLast: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 0) {
                HStack(spacing: PPSpacing.md) {
                    Image(logo)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 36, height: 36)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(name)
                            .font(.subheadline)
                            .fontWeight(.semibold)
                            .foregroundStyle(Color.ppTextPrimary)
                        if let subtitle {
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(Color.ppTextSecondary)
                                .lineLimit(1)
                        }
                    }

                    Spacer(minLength: PPSpacing.sm)

                    Image(systemName: "arrow.up.right")
                        .foregroundStyle(Color.ppTextSecondary)
                }
                .padding(.horizontal, PPSpacing.md)
                .padding(.vertical, PPSpacing.md)

                if !isLast {
                    Rectangle()
                        .fill(Color.ppBorder)
                        .frame(height: 1)
                        .padding(.leading, 38 + PPSpacing.md * 2)   // 与 logo 右缘对齐
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Home type 三选 sheet（写 store.owner.residenceType）

private struct HomeTypeSheet: View {
    @Environment(PetBookStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: PPSpacing.md) {
                ForEach(ResidenceType.allCases) { type in
                    Button {
                        Task { await store.updateOwner { $0.residenceType = type } }
                        dismiss()
                        SWAlertManager.shared.show(.success, message: "Home type updated")
                    } label: {
                        HStack {
                            Text(type.displayName)
                                .font(.headline)
                                .foregroundStyle(Color.ppTextPrimary)
                            Spacer()
                            if store.owner.residenceType == type {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(Color.ppPrimary)
                            }
                        }
                        .padding(PPSpacing.lg)
                        .frame(maxWidth: .infinity)
                        .background(
                            RoundedRectangle(cornerRadius: PPRadius.lg, style: .continuous)
                                .fill(Color.ppSurface)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: PPRadius.lg, style: .continuous)
                                .strokeBorder(
                                    store.owner.residenceType == type ? Color.ppPrimary : Color.ppBorder,
                                    lineWidth: store.owner.residenceType == type ? 1.5 : 1
                                )
                        )
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(PPSpacing.xl)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Color.ppBackground)
            .navigationTitle("Home type")
            .navigationBarTitleDisplayMode(.inline)
            .presentationDragIndicator(.visible)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                    }
                    .tint(Color.ppTextSecondary)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: - 通用文本字段编辑 sheet（写对应 store.owner 字段）

private struct TextFieldEditSheet: View {
    @Environment(PetBookStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let field: EditableField
    @State private var text = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: PPSpacing.lg) {
                PPLabeledField(label: LocalizedStringKey(field.title)) {
                    TextField(field.placeholder, text: $text)
                        .keyboardType(field.keyboard)
                }

                Spacer()
            }
            .padding(PPSpacing.xl)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Color.ppBackground)
            .navigationTitle(LocalizedStringKey(field.title))
            .navigationBarTitleDisplayMode(.inline)
            .presentationDragIndicator(.visible)
            .safeAreaInset(edge: .bottom) {
                PPPrimaryButton(title: "Save") {
                    save()
                }
                .padding(.horizontal, PPSpacing.xxl)
                .shadow(radius: 10)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                    }
                        .tint(Color.ppTextSecondary)
                }
            }
            .onAppear { text = currentValue }
        }
        .presentationDetents([.medium])
    }

    /// 读取当前字段值预填
    private var currentValue: String {
        switch field {
        case .displayName: store.owner.displayName
        case .postalCode:  store.owner.postalCode ?? ""
        case .phone:       store.owner.primaryPhone ?? ""
        }
    }

    private func save() {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        // 乐观更新 + 后端持久化（失败由 store.updateOwner 内部回滚 + toast）
        Task {
            await store.updateOwner { o in
                switch field {
                case .displayName: o.displayName = trimmed
                case .postalCode:  o.postalCode = trimmed.isEmpty ? nil : trimmed
                case .phone:       o.primaryPhone = trimmed.isEmpty ? nil : trimmed
                }
            }
        }
        dismiss()
        SWAlertManager.shared.show(.success, message: "Saved")
    }
}

#Preview {
    NavigationStack { ProfileView() }
        .environment(PetBookStore())
        .environment(PetBookTabBarController())
}
