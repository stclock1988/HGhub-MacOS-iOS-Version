use tauri::{command, AppHandle, Runtime};

use super::{NativePlayerExt, PlayResponse};

/// Present the native iOS player for `url`; resolves when the player is
/// dismissed, with the position (seconds) where playback stopped.
#[command]
pub async fn play<R: Runtime>(app: AppHandle<R>, url: String) -> Result<PlayResponse, String> {
    app.native_player().play(url).await
}
