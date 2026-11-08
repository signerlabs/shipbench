//
//  ImageProcessing.swift
//  LinkPreviews
//
//  图片处理（PRD §8、§11 #16）：截图等 TIFF 转存为无损 PNG、生成卡片缩略图、读像素尺寸。
//  纯函数、不碰界面，采集在后台线程调用。
//

import Foundation
import ImageIO
import UniformTypeIdentifiers

nonisolated enum ImageProcessing {

    /// 转存为无损 PNG：连同图片属性一起拷（DPI、方向、色彩描述），Retina 截图贴回去仍是原来的大小、朝向
    static func pngData(from data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImageFromSource(destination, source, 0, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }

    /// 卡片缩略图：长边不超过 maxPixelSize，几十 KB（PRD §8.1 ClipThumbnail）
    static func thumbnail(from data: Data, maxPixelSize: Int = 640) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return pngData(of: image)
    }

    static func pixelSize(of data: Data) -> (width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int
        else { return nil }
        return (width, height)
    }

    static func pngData(of image: CGImage) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }
}
