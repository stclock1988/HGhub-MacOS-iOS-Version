//! 本机媒体 HTTP 服务器（只在 iOS 上启用）。
//!
//! # 为什么要多这一层
//!
//! iOS 播放链路之前只有一条路：WKWebView 里跑 hls.js + `hg://localhost`
//! 自定义协议。这条路在 iPhone 上依赖 ManagedMediaSource（iPhone 没有标准
//! MSE），而 ManagedMediaSource 对本地加载的 WKWebView 页面是受限/不可靠的；
//! 更关键的是 `<video>` 元素的加载走 AVFoundation，根本不会经过
//! WKWebView 的 `WKURLSchemeHandler`，所以 `video.src = "hg://…"` 的原生
//! 回退分支永远播不出来（见 `Player.tsx` / `VideoSurface.tsx` 的旧代码）。
//! LiveContainer 里更糟：访客 App 跑在宿主的 bundle 身份下，WebKit 的
//! 媒体进程与自定义协议处理都按宿主身份走，MMS / `hg://` 更容易被拒，
//! 而原生 AVPlayer（YouTube、Han 的 hghub-ios 原生版）在 LiveContainer
//! 里是能播的——问题不在上游、不在网络，在播放器走的这条 Web 链路。
//!
//! 本服务器把同一份媒体逻辑（`media::handle`：封面解密、m3u8 改写、
//! 分片/Key 代理、Referer/UA、内存缓存）以普通 `http://127.0.0.1:<随机端口>`
//! 暴露给 AVFoundation。原生 HLS 只认 http(s) 地址，这样 iOS 就能用系统
//! 原生播放器播，完全绕开 hls.js + MMS + `hg://`。只绑回环地址，
//! 不监听任何外部网卡；请求路径仍只认 `/hls`、`/seg`、`/img`。
//!
//! AVFoundation 做进度拖动时会发 `Range` 请求，因此这里必须正确回
//! `206 Partial Content`（`media::handle` 本身不处理 Range，
//! 只给 fetch/hls.js 用，那条路不需要 Range）。

use std::sync::OnceLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

static MEDIA_PORT: OnceLock<u16> = OnceLock::new();

/// 本机服务器的端口（未启动时为 `None`）。
pub fn media_port() -> Option<u16> {
    MEDIA_PORT.get().copied()
}

/// 本机服务器的 origin，如 `http://127.0.0.1:51234`。
pub fn media_origin() -> Option<String> {
    media_port().map(|port| format!("http://127.0.0.1:{port}"))
}

/// 前端在 iOS 上拿端口：`invoke("media_server_port")`。
/// 非 iOS / 未启动时返回 `null`，前端随即回退到 hls.js 路径。
#[tauri::command]
pub fn media_server_port() -> Option<u16> {
    media_port()
}

/// 在 `127.0.0.1:0`（系统分配的随机端口）上启动服务器并一直跑下去。
/// 绑定失败时只记一条日志，不影响主窗口（前端会回退到 hls.js）。
pub async fn run() {
    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(listener) => listener,
        Err(err) => {
            crate::playback_log::record(
                "media_server.bind_failed",
                serde_json::json!({"error_kind": crate::playback_log::error_kind(&err.to_string())}),
            );
            return;
        }
    };
    if let Ok(addr) = listener.local_addr() {
        let _ = MEDIA_PORT.set(addr.port());
        crate::playback_log::record(
            "media_server.start",
            serde_json::json!({"port": addr.port()}),
        );
    }
    loop {
        match listener.accept().await {
            Ok((socket, _)) => {
                tokio::spawn(async move {
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(30),
                        handle_conn(socket),
                    )
                    .await;
                });
            }
            Err(_) => continue,
        }
    }
}

/// 解析单段 `Range: bytes=start-end`，返回闭区间 `[start, end]`。
/// 支持 `bytes=123-`（到末尾）与 `bytes=-500`（最后 500 字节）；
/// 多段 Range、越界 start、空串一律返回 `None`（调用方回完整 200）。
pub fn parse_range(header: &str, len: usize) -> Option<(usize, usize)> {
    let spec = header.trim().strip_prefix("bytes")?.trim();
    let spec = spec.strip_prefix('=')?.trim();
    if spec.contains(',') {
        return None;
    }
    let (start_s, end_s) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    if start_s.trim().is_empty() {
        // 后缀形式：bytes=-N
        let suffix: usize = end_s.trim().parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = len.saturating_sub(suffix);
        return Some((start, len - 1));
    }
    let start: usize = start_s.trim().parse().ok()?;
    if start >= len {
        return None;
    }
    let end = if end_s.trim().is_empty() {
        len - 1
    } else {
        let end: usize = end_s.trim().parse().ok()?;
        if end < start {
            return None;
        }
        end.min(len - 1)
    };
    Some((start, end))
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        206 => "Partial Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        502 => "Bad Gateway",
        _ => "OK",
    }
}

async fn handle_conn(mut socket: tokio::net::TcpStream) {
    // 只读请求头（GET 无 body），上限 32 KiB。
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 2048];
    let header_end = loop {
        match socket.read(&mut chunk).await {
            Ok(0) => return,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 32 * 1024 {
                    return;
                }
                if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
                    break pos + 4;
                }
            }
            Err(_) => return,
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_ascii_uppercase();
    let mut target = parts.next().unwrap_or("").to_string();
    // 兼容 absolute-form：http://127.0.0.1:PORT/seg?u=...
    if let Some(after) = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("https://"))
    {
        if let Some(slash) = after.find('/') {
            target = after[slash..].to_string();
        } else {
            target = "/".to_string();
        }
    }
    let mut range_header: Option<String> = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("range") {
                range_header = Some(value.trim().to_string());
            }
        }
    }

    let origin = match media_origin() {
        Some(origin) => origin,
        None => return,
    };
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (target.clone(), String::new()),
    };

    let (status, headers, body): (u16, Vec<(String, String)>, Vec<u8>) =
        if method != "GET" && method != "HEAD" {
            (
                405,
                vec![("Content-Type".into(), "text/plain".into())],
                b"method not allowed".to_vec(),
            )
        } else {
            let resp = crate::media::handle(&path, &query, &origin).await;
            let status = resp.status().as_u16();
            let headers: Vec<(String, String)> = resp
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            (status, headers, resp.into_body())
        };

    // Range：只对 200 的完整体裁剪，返回 206。
    let head_only = method == "HEAD";
    let mut status = status;
    let mut body = body;
    let mut content_range: Option<String> = None;
    if status == 200 {
        if let Some(range) = range_header.as_deref() {
            if let Some((start, end)) = parse_range(range, body.len()) {
                let total = body.len();
                body = body[start..=end].to_vec();
                status = 206;
                content_range = Some(format!("bytes {start}-{end}/{total}"));
            }
        }
    }

    let mut out = String::with_capacity(512);
    out.push_str(&format!("HTTP/1.1 {status} {}\r\n", reason(status)));
    for (name, value) in &headers {
        let lower = name.to_ascii_lowercase();
        if lower == "content-length" || lower == "content-range" || lower == "connection" {
            continue;
        }
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(content_range) = content_range {
        out.push_str(&format!("Content-Range: {content_range}\r\n"));
    }
    out.push_str(&format!("Content-Length: {}\r\n", body.len()));
    out.push_str("Connection: close\r\n\r\n");
    if socket.write_all(out.as_bytes()).await.is_err() {
        return;
    }
    if !head_only && !body.is_empty() {
        let _ = socket.write_all(&body).await;
    }
    let _ = socket.shutdown().await;
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_open_ended_and_suffix() {
        assert_eq!(parse_range("bytes=0-", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=100-199", 1000), Some((100, 199)));
        assert_eq!(parse_range("bytes=950-2000", 1000), Some((950, 999)));
        assert_eq!(parse_range("bytes=-500", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=-2000", 1000), Some((0, 999)));
    }

    #[test]
    fn range_invalid_returns_none() {
        assert_eq!(parse_range("bytes=1000-", 1000), None); // start 越界
        assert_eq!(parse_range("bytes=200-100", 1000), None); // end < start
        assert_eq!(parse_range("bytes=0-99, 200-299", 1000), None); // 多段不支持
        assert_eq!(parse_range("bytes=-0", 1000), None);
        assert_eq!(parse_range("bytes=abc-", 1000), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
        assert_eq!(parse_range("items=0-99", 1000), None);
    }
}
