//
//  UIImage+Downscale.swift
//  PetBook
//
//  上传前的图片等比缩放工具。**只缩不裁**：保持原始宽高比，绝不裁切任何边——
//  存储层保留完整原图比例，圆形头像是显示层的 clipShape 裁切，与存储无关。
//  将来若把头像从圆形改方形，只需改显示层 clipShape，无需重传或动存储原图。
//

import UIKit

extension UIImage {

    /// 把图片最长边等比缩到 ≤ maxDimension，保持原始宽高比、不裁切。
    /// 原图最长边已 ≤ maxDimension → 原样返回（不放大，避免无意义重采样 + 体积膨胀）。
    /// - Parameter maxDimension: 缩放后允许的最长边像素上限（如 1600）。
    func downscaled(maxDimension: CGFloat) -> UIImage {
        let longest = max(size.width, size.height)

        // 已在上限内 → 不放大，原样返回
        guard longest > maxDimension, longest > 0 else { return self }

        let scale = maxDimension / longest
        let targetSize = CGSize(width: size.width * scale, height: size.height * scale)

        // 用 1.0 scale 直出目标像素尺寸（不乘屏幕 scale，避免产出比预期大几倍的位图）
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1.0
        format.opaque = false   // 保留可能的透明通道，整图等比绘制、四边不裁

        let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
        return renderer.image { _ in
            draw(in: CGRect(origin: .zero, size: targetSize))
        }
    }
}
