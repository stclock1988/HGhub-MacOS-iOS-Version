//! Play a URL in the native iOS AVPlayer (AVPlayerViewController).
//!
//! Why this exists: the web view's `<video>` cannot present frames in
//! LiveContainer. The timeline runs (hls.js + ManagedMediaSource buffers
//! and advances, and the native AVFoundation engine does too), but no
//! frame or audio comes out — in inline playback AND in the iOS system
//! fullscreen player, because both share WebKit's media pipeline. A seek
//! forces exactly one frame. This plugin presents a real
//! AVPlayerViewController from the app process, fed by the local media
//! server URL (`http://127.0.0.1:<port>/hls?u=...`), bypassing WebKit
//! entirely. The native HGhub app plays the same way in LiveContainer,
//! so the path itself is proven.
//!
//! The `play` command resolves when the player is dismissed, with the
//! position (seconds) where playback stopped, so the inline player can
//! jump back to that point (staying paused).

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_native_player);

mod commands;

/// Request from JS/Rust: the playable URL (local media server m3u8).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayRequest {
    pub url: String,
}

/// Response from Swift when the player is dismissed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayResponse {
    /// Position (seconds) where playback stopped / was dismissed.
    pub position: f64,
}

/// Access to the native player APIs, managed by the plugin as app state.
///
/// Obtain an instance via [`NativePlayerExt::native_player`].
pub struct NativePlayer<R: Runtime> {
    #[cfg(target_os = "ios")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "ios"))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> NativePlayer<R> {
    /// Present the native iOS player for `url` and wait until it is
    /// dismissed. Returns the position (seconds) where playback stopped.
    /// (iOS only; on other targets this always errors.)
    pub async fn play(&self, url: String) -> Result<PlayResponse, String> {
        #[cfg(target_os = "ios")]
        {
            let handle = self.handle.clone();
            tokio::task::spawn_blocking(move || {
                handle
                    .run_mobile_plugin("play", PlayRequest { url })
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = url;
            Err("native player is only available on iOS".to_string())
        }
    }
}

/// Extensions to [`tauri::App`], [`tauri::AppHandle`], [`tauri::WebviewWindow`],
/// [`tauri::Webview`] and [`tauri::Window`] to access the native player APIs.
pub trait NativePlayerExt<R: Runtime> {
    fn native_player(&self) -> &NativePlayer<R>;
}

impl<R: Runtime, T: Manager<R>> NativePlayerExt<R> for T {
    fn native_player(&self) -> &NativePlayer<R> {
        self.state::<NativePlayer<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R, ()> {
    Builder::new("native-player")
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_native_player)?;

            app.manage(NativePlayer {
                #[cfg(target_os = "ios")]
                handle,
                #[cfg(not(target_os = "ios"))]
                _marker: std::marker::PhantomData::<fn() -> R>,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::play])
        .build()
}
