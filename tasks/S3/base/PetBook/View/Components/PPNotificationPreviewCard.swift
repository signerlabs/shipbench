//
//  PPNotificationPreviewCard.swift
//  PetBook
//
//  模拟 iOS 系统通知横幅的预览卡：让用户在授权通知前「看见自己将收到什么」，
//  这是通知权限转化最有效的价值前置手段（设计语言 v2 · P2）。
//  用在两处：Onboarding Celebration 屏软引导 + Profile Completion 的 enableReminders 步骤页。
//  纯展示组件，不触发任何权限请求。
//

import SwiftUI

struct PPNotificationPreviewCard: View {
    /// 通知正文（调用方带入宠物名，如 "Mochi's rabies vaccine is due in 7 days"）
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: PPSpacing.md) {
            Image(.ppLogo)
                .resizable()
                .scaledToFit()
                .frame(width: 38, height: 38)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))

            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text("PetBook")
                        .font(.footnote)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.ppTextPrimary)
                    Spacer(minLength: 0)
                    Text("now")
                        .font(.caption2)
                        .foregroundStyle(Color.ppTextSecondary)
                }
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(Color.ppTextPrimary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(PPSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ppCard(cornerRadius: PPRadius.lg)
    }
}

#Preview {
    VStack(spacing: PPSpacing.xl) {
        PPNotificationPreviewCard(message: "Mochi's rabies vaccine is due in 7 days")
        PPNotificationPreviewCard(message: "Buddy's dog licence expires in 30 days — renew on PALS")
    }
    .padding(PPSpacing.xl)
    .frame(maxHeight: .infinity)
    .background(Color.ppBackground)
}
