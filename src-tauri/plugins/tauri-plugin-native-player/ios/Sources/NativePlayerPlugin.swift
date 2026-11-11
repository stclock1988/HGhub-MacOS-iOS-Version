// Native AVPlayer playback for iOS.
//
// The web view's <video> cannot present frames in LiveContainer: the
// timeline runs (hls.js + ManagedMediaSource buffers and advances, and
// the native AVFoundation engine does too), but no frame or audio comes
// out — in inline playback AND in the iOS system fullscreen player,
// because both share WebKit's media pipeline. A seek forces exactly one
// frame. This plugin presents a real AVPlayerViewController from the app
// process, fed by the local media server URL, bypassing WebKit entirely.
// The native HGhub app plays the same way in LiveContainer, so the path
// itself is proven.
//
// The `play` command resolves when the player is dismissed, with the
// position (seconds) where playback stopped, so the inline player can
// jump back to that point (staying paused).
//
// Dismissal is noticed via UIAdaptivePresentationControllerDelegate's
// presentationControllerDidDismiss (fires for the Done button and for a
// swipe, and only on a real dismissal — not when a route picker merely
// covers the player). The AVPlayerViewControllerDelegate dismissal
// callbacks (playerViewControllerWill/DidEndDismissalTransition) are
// marked @available(iOS, unavailable) in the iOS 26 SDK, so they cannot
// be implemented at all — compiling them fails the build (2026-11-11,
// 1.2.10 CI).

import AVKit
import Foundation
import SwiftRs
import Tauri
import UIKit
import WebKit

/// Arguments for the `play` command: the playable URL (local media server m3u8).
struct PlayArgs: Decodable {
  let url: String
}

class NativePlayerPlugin: Plugin, UIAdaptivePresentationControllerDelegate {
  private var player: AVPlayer?
  private var playerVC: AVPlayerViewController?
  private var pendingInvoke: Invoke?

  @objc public func play(_ invoke: Invoke) throws {
    do {
      let args = try invoke.parseArgs(PlayArgs.self)
      guard let url = URL(string: args.url) else {
        invoke.reject("invalid url")
        return
      }
      // One native player at a time; a second tap while one is open is rejected.
      if pendingInvoke != nil {
        invoke.reject("already playing")
        return
      }
      pendingInvoke = invoke
      DispatchQueue.main.async { [weak self] in
        self?.present(url: url)
      }
    } catch {
      invoke.reject(error.localizedDescription)
    }
  }

  // MARK: - Presentation

  private func present(url: URL) {
    guard let presenter = manager.viewController else {
      finish(position: 0, error: "no presenter")
      return
    }
    // If something else (e.g. a sheet) is already presented, presenting
    // on top would warn and silently do nothing, leaving the invoke hung.
    if presenter.presentedViewController != nil {
      finish(position: 0, error: "already presenting")
      return
    }
    let player = AVPlayer(url: url)
    let vc = AVPlayerViewController()
    vc.player = player
    vc.showsPlaybackControls = true
    // v1: no Picture in Picture. Its lifecycle adds a second dismissal
    // path (player keeps playing after the sheet goes away); the Done
    // button / swipe dismisses and playback stops.
    vc.allowsPictureInPicturePlayback = false
    vc.entersFullScreenWhenPlaybackBegins = false
    self.player = player
    self.playerVC = vc
    presenter.present(vc, animated: true) { [weak self] in
      // The presentation controller exists once presentation completes;
      // this is what reports the Done-button / swipe dismissal.
      vc.presentationController?.delegate = self
      player.play()
    }
  }

  // MARK: - UIAdaptivePresentationControllerDelegate

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish(position: currentPosition())
  }

  // MARK: - Finish

  private func currentPosition() -> Double {
    guard let player = player else { return 0 }
    let seconds = player.currentTime().seconds
    return seconds.isFinite ? seconds : 0
  }

  private func finish(position: Double, error: String? = nil) {
    player?.pause()
    player = nil
    playerVC = nil
    guard let invoke = pendingInvoke else { return }
    pendingInvoke = nil
    if let error = error {
      invoke.reject(error)
    } else {
      invoke.resolve(["position": position])
    }
  }
}

@_cdecl("init_plugin_native_player")
public func initPlugin() -> Plugin {
  return NativePlayerPlugin()
}
