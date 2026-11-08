//
//  PPVideoView.swift
//  PetBook
//
//  通用内嵌视频播放视图（静音 + 循环）。layer 填满容器 bounds，
//  由 caller 控制 frame / clipShape / cornerRadius。
//
//  与 PPVideoBackground 的区别：
//   - PPVideoView：通用填充层，card / 任意尺寸容器内用，videoGravity 默认 resizeAspectFill
//   - PPVideoBackground：全屏背景专用（顶对齐 + 底部羽化），仅作整页背景
//
//  用法：
//      PPVideoView(resourceName: "CatVideo")
//          .frame(width: 240, height: 320)
//          .clipShape(RoundedRectangle(cornerRadius: 28))
//

import SwiftUI
import UIKit
import AVFoundation

struct PPVideoView: UIViewRepresentable {
    let resourceName: String
    var fileExtension: String = "mp4"
    var videoGravity: AVLayerVideoGravity = .resizeAspectFill

    func makeUIView(context: Context) -> VideoFillContainerView {
        let view = VideoFillContainerView()
        view.backgroundColor = .clear
        configurePlayer(in: view)
        return view
    }

    func updateUIView(_ uiView: VideoFillContainerView, context: Context) {
        if uiView.currentResourceName != resourceName {
            uiView.tearDown()
            configurePlayer(in: uiView)
        }
    }

    private func configurePlayer(in view: VideoFillContainerView) {
        guard let url = Bundle.main.url(forResource: resourceName, withExtension: fileExtension) else {
            return
        }
        let player = AVPlayer(url: url)
        player.isMuted = true
        player.actionAtItemEnd = .none

        let layer = AVPlayerLayer(player: player)
        layer.videoGravity = videoGravity
        view.layer.addSublayer(layer)
        view.playerLayer = layer
        view.currentResourceName = resourceName

        view.loopObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: player.currentItem,
            queue: .main
        ) { _ in
            player.seek(to: .zero)
            player.play()
        }

        player.play()
    }
}

/// layer 填满容器 bounds（区别于 PPVideoBackground 的顶对齐 container）。
final class VideoFillContainerView: UIView {
    var playerLayer: AVPlayerLayer?
    var loopObserver: NSObjectProtocol?
    var currentResourceName: String?

    override func layoutSubviews() {
        super.layoutSubviews()
        playerLayer?.frame = bounds
    }

    func tearDown() {
        if let obs = loopObserver {
            NotificationCenter.default.removeObserver(obs)
            loopObserver = nil
        }
        playerLayer?.player?.pause()
        playerLayer?.removeFromSuperlayer()
        playerLayer = nil
        currentResourceName = nil
    }

    deinit {
        if let obs = loopObserver {
            NotificationCenter.default.removeObserver(obs)
        }
    }
}

#Preview {
    // ⚠️ Preview Canvas 默认静态，点右下角 ▶︎ 进 Live 模式看视频
    PPVideoView(resourceName: "CatVideo")
        .frame(width: 240, height: 340)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .padding(40)
        .background(Color.ppBackground)
}
