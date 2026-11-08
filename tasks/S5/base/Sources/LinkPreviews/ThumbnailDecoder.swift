//
//  ThumbnailDecoder.swift
//  LinkPreviews
//

import CoreGraphics
import Foundation
import ImageIO

/// 缩略图解码：纯函数，在后台线程跑
nonisolated enum ThumbnailDecoder {
    /// 长边不超过 maxPixelSize，并当场解码好（之后画到屏幕上不再在主线程解码）
    static func downsample(_ data: Data, maxPixelSize: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ] as CFDictionary
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options)
    }
}
