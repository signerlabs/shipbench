//
//  SearchFolding.swift
//  ClipData
//
//  搜索的折叠规则：不分大小写、变音符与全半角。
//  建索引与查询必须用同一个折叠函数——FTS5 旁路索引、mock 的内存扫描、卡片上的命中高亮都走这里。
//

import Foundation

public enum SearchFolding {
    public static let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]

    public static func fold(_ text: String) -> String {
        text.folding(options: options, locale: nil)
    }
}
