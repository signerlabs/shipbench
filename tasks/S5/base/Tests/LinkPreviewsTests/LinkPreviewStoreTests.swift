//
//  LinkPreviewStoreTests.swift
//  LinkPreviewsTests
//
//  链接预览：哪些网址可以去取（fetchableURL），以及不该取的不会去取。不连网。
//

import Foundation
import Testing
@testable import LinkPreviews

struct FetchableURLTests {
    @Test func acceptsHTTPAndHTTPS() {
        #expect(LinkPreviewStore.fetchableURL("https://www.apple.com/mac/") != nil)
        #expect(LinkPreviewStore.fetchableURL("http://example.com/a?b=1") != nil)
    }

    @Test func rejectsOtherSchemesAndNonURLs() {
        for string in ["ftp://example.com/file", "mailto:someone@example.com", "file:///etc/hosts", "javascript:alert(1)",
                       "example.com", "not a url", ""] {
            #expect(LinkPreviewStore.fetchableURL(string) == nil, "\(string)")
        }
    }

    @Test func keepsTheURLAsIs() {
        #expect(LinkPreviewStore.fetchableURL("https://example.com/a?b=1#top")?.absoluteString == "https://example.com/a?b=1#top")
    }
}

struct LinkPreviewStoreTests {
    @Test func nothingCachedForAnUnknownURL() {
        #expect(LinkPreviewStore().cached(for: "https://example.com/") == nil)
    }

    @Test func doesNotFetchURLsItMayNotVisit() async {
        #expect(await LinkPreviewStore().preview(for: "ftp://example.com/file") == nil)
    }
}
