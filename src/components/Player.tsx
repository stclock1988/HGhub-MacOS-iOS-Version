import React, { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { canPlayNativeHls, fmtTime, getPlaybackEngine, nativePlaybackUrl, platform, playlist } from "../api";
import { mediaResource, observeHls, usePlayerDiagnostics } from "../playbackDiagnostics";
import { usePlaybackActivity } from "../usePlaybackActivity";
import { useSeekInput } from "../useSeekInput";
import PlaybackLock from "./PlaybackLock";
import { ICompress, IExpand, ILockF, IPauseF, IPlayF, IVol, IVolMute } from "../icons";

type Props = {
  src: string;              // 原始 m3u8 地址
  poster?: string;          // 已处理好的封面地址（本地协议）
  autoPlay?: boolean;
  active?: boolean;
  muted?: boolean;
  loop?: boolean;
  onEnded?: () => void;
  onPlaying?: () => void;
  onTogglePlay?: (playing: boolean) => void;
  onToggleMute?: () => void;
  controls?: boolean;
  className?: string;
  diagnosticContext?: Record<string, unknown>;
};

export default function Player({
  src, poster, autoPlay, active = true, muted = false, loop = false, onEnded, onPlaying,
  onTogglePlay, onToggleMute, controls = true, className = "", diagnosticContext = {},
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const recoverCountRef = useRef(0);
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { view: "post_detail", ...diagnosticContext, active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay: !!autoPlay, src, trace });
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [full, setFull] = useState(false);
  const [rate, setRate] = useState(1);
  const [errMsg, setErrMsg] = useState<string>("");
  const [controlsLocked, setControlsLocked] = useState(false);
  const seek = useSeekInput({ time, duration, enabled: active && !controlsLocked, resetKey: src,
    onInteraction: (phase, input, target, pointerTarget) => trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget }),
    onSeek: (target, input) => {
      const video = videoRef.current;
      if (!video || !activity.isActive()) return;
      requestSeek(target, `legacy_${input}`);
      setWaiting(true);
      if (hlsRef.current) {
        try { hlsRef.current.startLoad(target); } catch { /* ignore */ }
      }
      video.currentTime = target;
      trace("seek.assigned", { target });
      setTime(video.currentTime);
    },
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    // 原生 / hls.js 切换用的代次守卫与失败标记（切集后旧的异步回调一律作废）。
    let cancelled = false;
    let nativeFailed = false;
    let fallbackTimer: number | null = null;
    let nativeErrorHandler: (() => void) | null = null;
    const url = playlist(src);
    recoverCountRef.current = 0;
    setErrMsg("");
    // iOS 默认走原生：AVFoundation + 本机 HTTP 服务器，绕开 WKWebView 的
    // hls.js + ManagedMediaSource + hg:// 链路（LiveContainer 下那条路
    // 不可用，见 docs/livecontainer-playback.md）。设置里可切回 hls.js。
    const wantNative =
      platform === "ios" && getPlaybackEngine() === "native" && canPlayNativeHls();

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    // --- hls.js 路径（macOS / 安卓 / iOS 原生失败后的回退） ---
    const startHls = () => {
      if (cancelled) return;
      trace("source.load", { engine: Hls.isSupported() ? "hls.js" : "native-direct", auto_play: autoPlay });
    if (Hls.isSupported()) {
      // ManagedMediaSource 要求关掉远程播放，否则 iOS 上建源会直接失败。
      if (platform === "ios") { try { video.disableRemotePlayback = true; } catch { /* ignore */ } }
      const hls = new Hls({
        // 禁用从插播/内容引导 JSON 派生直连 URL 的可选功能。
        interstitialsController: undefined,
        contentSteeringController: undefined,
        enableInterstitialPlayback: false,
        enableWorker: platform !== "ios",
        // Keep the same macOS seek workaround as the shared player.
        preferManagedMediaSource: false,
        autoStartLoad: false,
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 30,
        maxBufferHole: 0.5,
        nudgeOffset: 0.25,
        nudgeMaxRetry: 6,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 4,
        fragLoadingTimeOut: 25000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 400,
      });
      hlsRef.current = hls;
      observeHls(hls, trace);
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (activity.isActive()) hls.startLoad();
        if (autoPlay) activity.play("manifest_autoplay", true);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        recoverCountRef.current = 0;
        setErrMsg("");
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) {
          if (
            data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR ||
            data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR
          ) {
            try { hls.startLoad(video.currentTime || -1); } catch { /* ignore */ }
          }
          return;
        }
        if (!activity.isActive()) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoverCountRef.current < 4) {
          recoverCountRef.current += 1;
          try { hls.startLoad(video.currentTime || -1); } catch { /* ignore */ }
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoverCountRef.current < 4) {
          recoverCountRef.current += 1;
          try { hls.recoverMediaError(); video.play().catch(() => {}); } catch { /* ignore */ }
          return;
        }
        const detail = `${data.type}/${data.details}/${data.response?.code ?? ""}/${String(data.reason ?? "").slice(0, 80)}`;
        (window as unknown as { __hlsErr?: string }).__hlsErr = detail;
        setErrMsg(detail);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else { hls.destroy(); hlsRef.current = null; }
      });
    } else {
      // 之前这里是 video.src = hg://…：AVFoundation 的加载根本不经过
      // WKURLSchemeHandler，挂自定义协议地址永远播不出来。改走本机
      // HTTP 服务器；服务器没起来就报出来，而不是挂一个死地址。
      void nativePlaybackUrl(src).then((nativeUrl) => {
        if (cancelled) return;
        if (!nativeUrl) {
          setErrMsg("本地媒体服务未启动，无法播放");
          return;
        }
        if (nativeFailed) {
          setErrMsg("原生播放失败，且该片源不支持网页播放");
          return;
        }
        video.src = nativeUrl;
        if (autoPlay) activity.play("native_autoplay", true);
      });
    }
    }

    // --- iOS 原生路径：AVFoundation + 本机 HTTP 服务器 ---
    const switchToHlsOnce = (reason: string) => {
      if (cancelled || nativeFailed) return;
      nativeFailed = true;
      if (nativeErrorHandler) video.removeEventListener("error", nativeErrorHandler);
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      trace("native.fallback", { reason });
      video.removeAttribute("src");
      try { video.load(); } catch { /* ignore */ }
      startHls();
    }
    const startNative = async () => {
      // native.waiting：等取端口期间若一直没下文（无 source.load、无
      // native.failed），说明这步卡住了——这正是 1.2.1 日志里的死状。
      trace("native.waiting");
      const nativeUrl = await nativePlaybackUrl(src);
      if (cancelled) return;
      if (!nativeUrl) { startHls(); return; }
      trace("source.load", { engine: "native", auto_play: autoPlay });
      video.src = nativeUrl;
      video.load();
      nativeErrorHandler = () => {
        trace("native.failed", { error_code: video.error?.code ?? null });
        switchToHlsOnce("error");
      };
      video.addEventListener("error", nativeErrorHandler);
      // 原生 12 秒仍无数据（readyState < 2）且页面还在前台：切 hls.js。
      fallbackTimer = window.setTimeout(() => {
        if (cancelled || nativeFailed) return;
        if (video.readyState < 2 && activity.isActive()) {
          trace("native.stalled", { ready_state: video.readyState });
          switchToHlsOnce("stalled");
        }
      }, 12000);
      if (autoPlay) activity.play("native_autoplay", true);
    }

    if (wantNative) void startNative();
    else startHls();

    return () => {
      cancelled = true;
      trace("source.cleanup");
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      if (nativeErrorHandler) video.removeEventListener("error", nativeErrorHandler);
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  }, [src, autoPlay]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
  }, [muted]);

  useEffect(() => {
    const onFs = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    trace("toggle.request");
    if (video.paused) activity.play("toggle");
    else activity.pause("toggle");
  };

  const cycleRate = () => {
    const video = videoRef.current;
    if (!video) return;
    const next = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 2 : 1;
    video.playbackRate = next;
    setRate(next);
  };

  const toggleFull = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };

  const pct = duration > 0 ? (seek.time / duration) * 100 : 0;

  return (
    <div ref={wrapRef} className={`relative bg-black overflow-hidden group ${className}`}>
      <div className="absolute inset-0" inert={controlsLocked}>
      <video
        ref={videoRef}
        poster={poster}
        playsInline
        webkit-playsinline="true"
        preload="auto"
        muted={muted}
        loop={loop}
        className="w-full h-full object-contain bg-black"
        onClick={toggle}
        onPlay={() => { if (activity.isActive()) { setPlaying(true); onTogglePlay?.(true); } }}
        onPause={() => { setPlaying(false); onTogglePlay?.(false); }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => { if (activity.isActive()) { setWaiting(false); setErrMsg(""); onPlaying?.(); } }}
        onSeeked={() => setWaiting(false)}
        onTimeUpdate={(e) => setTime((e.target as HTMLVideoElement).currentTime)}
        onLoadedMetadata={(e) => setDuration((e.target as HTMLVideoElement).duration || 0)}
        onEnded={() => { if (activity.isActive()) onEnded?.(); }}
      />

      {errMsg && (
        <div className="absolute left-2 top-2 z-30 max-w-[80%] rounded bg-black/70 px-2 py-1 text-[10px] leading-tight text-red-300 break-all">
          {errMsg}
        </div>
      )}

      {waiting && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-9 h-9 spinner" />
        </div>
      )}

      {!playing && !waiting && (
        <button onClick={toggle} aria-label="播放"
          className="absolute inset-0 flex items-center justify-center">
          <span className="w-16 h-16 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center elev-2 pressable">
            <IPlayF size={26} className="text-white ml-0.5" />
          </span>
        </button>
      )}

      {controls && (
        <div className="absolute inset-x-0 bottom-0 px-3 pb-2 pt-8 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
          <input aria-label="播放进度" type="range" {...seek.inputProps}
            className="hg-range w-full" style={{ ...seek.inputProps.style, "--fill": `${pct}%` } as React.CSSProperties} />
          <div className="flex items-center gap-3 mt-1 text-white">
            <button onClick={toggle} aria-label={playing ? "暂停" : "播放"} className="pressable">
              {playing ? <IPauseF size={16} /> : <IPlayF size={16} />}
            </button>
            <button onClick={() => onToggleMute?.()} aria-label={muted ? "取消静音" : "静音"} className="pressable">
              {muted ? <IVolMute size={16} /> : <IVol size={16} />}
            </button>
            <span className="text-[11px] tabular-nums text-white/85">{fmtTime(seek.time)} / {fmtTime(duration)}</span>
            <div className="flex-1" />
            <button onClick={() => setControlsLocked(true)} aria-label="锁定播放控制" title="锁定播放控制" aria-pressed={false} className="pressable">
              <ILockF size={16} />
            </button>
            <button onClick={cycleRate} className="text-[11px] font-bold text-white/85 pressable tabular-nums">{rate}x</button>
            <button onClick={toggleFull} aria-label="全屏" className="pressable">
              {full ? <ICompress size={16} /> : <IExpand size={16} />}
            </button>
          </div>
        </div>
      )}
      </div>
      {controlsLocked && <PlaybackLock active={active} onUnlock={() => setControlsLocked(false)} />}
    </div>
  );
}
