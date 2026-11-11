import { invoke } from "@tauri-apps/api/core";
import type {
  CommentPage, Detail, Paged, PlayInfo, Post, RankItem, User, VideoCard,
} from "./types";

/* ── 运行环境 ───────────────────────────────────────────── */

/** 应用版本（构建时由 vite.config.ts 从 package.json 注入） */
export const APP_VERSION = __APP_VERSION__;

const ua = navigator.userAgent;
/** iPhone 的 UA 也带「like Mac OS X」，必须先于 macOS 判断；iPadOS 默认伪装成 Mac，用触点数区分。 */
export const isIos =
  /iPhone|iPad|iPod/i.test(ua) ||
  (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) ||
  (typeof navigator.platform === "string" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/i.test(ua);
export const isMacos = !isIos && /Macintosh|Mac OS X/i.test(ua);
export const platform: "android" | "ios" | "windows" | "macos" =
  isAndroid ? "android" : isIos ? "ios" : isMacos ? "macos" : "windows";
/** 移动端（安卓 / iOS）共用触屏界面 */
export const isMobile = isAndroid || isIos;

/** 自定义协议地址随平台不同（见 tauri `register_asynchronous_uri_scheme_protocol` 文档）：
 *  Windows / Android → `http://<scheme>.localhost`
 *  macOS / iOS / Linux → `<scheme>://localhost`
 *  Rust 侧 `src-tauri/src/lib.rs` 里改写 m3u8 用的 scheme 必须与此一致。 */
export const LOCAL = isMacos || isIos ? "hg://localhost" : "http://hg.localhost";

/** src 是否已是本地协议地址（避免在详情页把代理地址再包一层） */
export const isLocalMedia = (src: string) => src.startsWith(`${LOCAL}/`);

/** 封面：经本地协议解密（站点封面是 AES 密文）。 */
export const cover = (url?: string, _w = 480) =>
  url ? `${LOCAL}/img?u=${encodeURIComponent(url)}` : "";

/** 播放列表：经本地协议改写分片地址，规避 CORS 与防盗链。 */
export const playlist = (url: string) => `${LOCAL}/hls?u=${encodeURIComponent(url)}`;

/* ── iOS 原生播放（绕开 WKWebView 的 hls.js + ManagedMediaSource + hg://） ──
 *
 * 根因见 docs/livecontainer-playback.md：iPhone 没有标准 MSE，只有
 * ManagedMediaSource，且它对本地加载的 WKWebView 页面受限不可靠；
 * LiveContainer 访客跑在宿主身份下更糟；而 <video> 的加载走
 * AVFoundation，根本不经过 WKURLSchemeHandler，所以 video.src 挂
 * hg:// 地址的原生回退永远播不出来。
 *
 * 新路：Rust 在本机 127.0.0.1 起一个随机端口的 HTTP 媒体服务器
 * （media_server.rs，复用同一份 media::handle），iOS 用原生
 * AVFoundation 直接播 http://127.0.0.1:<port>/hls?u=…。Referer/UA、
 * AES Key 改写与缓存都在 Rust 侧，和原来 hg:// 完全一致。
 * 服务器没起来（非 iOS / 绑定失败）时返回 null，播放器回退 hls.js。 */

export type PlaybackEngine = "native" | "hlsjs";
const ENGINE_KEY = "hghub.playbackEngine.v1";
export function getPlaybackEngine(): PlaybackEngine {
  try {
    const saved = localStorage.getItem(ENGINE_KEY);
    if (saved === "native" || saved === "hlsjs") return saved;
  } catch { /* ignore */ }
  // 1.2.4：iOS 默认改回网页播放（hls.js）。1.2.1 建原生路线的假
  // 设是“hls.js + ManagedMediaSource 在 LiveContainer 里播不了”，
  // 但 1.2.18 日志证明它能正常播（3483 第 1 集，time 0→7.266 实
  // 时走）；反而默认的原生在 1.2.3 日志里全程卡住：buffered 涨到
  // 100s、readyState 4、未暂停、无 error，但 currentTime 恒 0、
  // seek 后也没有新帧呈现。原生仍可在设置里手动切回来。
  return "hlsjs";
}
export function setPlaybackEngine(engine: PlaybackEngine) {
  try { localStorage.setItem(ENGINE_KEY, engine); } catch { /* ignore */ }
}

/** 系统原生 HLS（AVFoundation）是否能播 m3u8：iOS/iPadOS/macOS 返回真。 */
export function canPlayNativeHls(): boolean {
  try {
    const v = document.createElement("video");
    const can = v.canPlayType("application/vnd.apple.mpegurl");
    return can === "probably" || can === "maybe";
  } catch { return false; }
}

let mediaPortPromise: Promise<number | null> | null = null;
/** 本机媒体服务器端口（应用生命周期内不变）；未启动时为 null。
 * 桥接调用加 5 秒超时：调用一旦挂住（1.2.1 日志里出现过无 source.load、
 * 无任何错误的静默卡死），播放不能无限等下去，超时按服务未启动处理，
 * 前端回退 hls.js。 */
export function mediaServerPort(): Promise<number | null> {
  if (!mediaPortPromise) {
    const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 5000));
    mediaPortPromise = Promise.race([
      invoke<number | null>("media_server_port").catch(() => null),
      timeout,
    ]);
  }
  return mediaPortPromise;
}

/** 把播放地址换成本机 HTTP 地址（原生播放器用）；服务器未起返回 null。 */
export async function nativePlaybackUrl(src: string): Promise<string | null> {
  const port = await mediaServerPort();
  if (!port) return null;
  const origin = `http://127.0.0.1:${port}`;
  if (src.startsWith(`${LOCAL}/`)) return origin + src.slice(LOCAL.length);
  if (/\.m3u8(\?|$)/i.test(src)) return `${origin}/hls?u=${encodeURIComponent(src)}`;
  return `${origin}/seg?u=${encodeURIComponent(src)}`;
}

/* ── 调用封装 ───────────────────────────────────────────── */

/** 写一行到应用数据目录 debug.log（用户反馈「打不开」时要的就是它） */
export const logLine = (msg: string) => invoke("debug_log", { msg }).catch(() => {});

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return (await invoke(cmd, args)) as T;
  } catch (e) {
    const msg = typeof e === "string" ? e : "请求失败，请检查网络";
    // 落盘完整错误链（dns error / connection refused / 证书错误…），toast 只显示截断版
    logLine(`[api] ${cmd} → ${msg}`);
    const status = /^HTTP (\d{3})\b/.exec(msg)?.[1];
    if (status) {
      throw new Error(`服务器请求失败（HTTP ${status}），请稍后重试或在设置中切换线路`);
    }
    throw new Error(msg.length > 140 ? `${msg.slice(0, 140)}…` : msg);
  }
}

/* ── 接口 ───────────────────────────────────────────────── */

export const api = {
  boot: () =>
    call<{
      user: User | null;
      logged_in: boolean;
      base: string;
      strict_security?: boolean;
      cli_relaxed?: boolean;
    }>("app_boot"),
  securitySet: (strict: boolean) => call<boolean>("security_set", { strict }),
  login: (username: string, password: string) =>
    call<{ user: User }>("api_login", { username, password }),
  register: (username: string, password: string, email = "") =>
    call<{ user: User }>("api_register", { username, password, email }),
  logout: () => call<{ ok: boolean }>("api_logout"),
  me: () => call<User>("api_me"),

  feed: (page = 1, size = 20) => call<Paged<VideoCard>>("api_feed", { page, size }),
  category: (cate: string, page = 1, size = 20) =>
    call<Paged<VideoCard>>("api_category", { cate, page, size }),
  rank: (kind: "hot" | "recommend" | "potential") =>
    call<{ type: string; items: RankItem[] }>("api_rank", { kind }),
  search: (q: string, page = 1, size = 20) =>
    call<{ items: VideoCard[]; pagination: Paged<VideoCard>["pagination"]; keyword: string }>(
      "api_search", { q, page, size },
    ),
  posts: (page = 1, size = 20) => call<Paged<Post>>("api_posts", { page, size }),
  post: (id: number) => call<Post & { content?: string; video_url?: string }>("api_post", { id }),

  video: (id: number) => call<Detail>("api_video", { id }),
  play: (id: number, ep: number) => call<PlayInfo>("api_play", { id, ep }),

  comments: (id: number, ep: number, page = 1, size = 20) =>
    call<CommentPage>("api_comments", { id, ep, page, size }),
  commentSend: (id: number, ep: number, text: string, replyId?: number) =>
    call<unknown>("api_comment_send", { id, ep, text, replyId: replyId ?? null }),

  clearCache: () => invoke<void>("cache_clear"),
  netDiag: () => invoke<Record<string, unknown>>("net_diag"),
  postLike: (id: number, on: boolean) => invoke<unknown>("api_post_like", { id, on }),
  postCollect: (id: number, on: boolean) => invoke<unknown>("api_post_collect", { id, on }),
  postComments: (id: number, page: number, size: number) => call<CommentPage>("api_post_comments", { id, page, size }),
  like: (id: number, ep: number, on: boolean) => call<unknown>("api_like", { id, ep, on }),
  collect: (id: number, on: boolean) => call<unknown>("api_collect", { id, on }),
  follow: (uid: number, on: boolean) => call<unknown>("api_follow", { uid, on }),

  /* 线路（数据源）：固定线路写死在 Rust 侧，镜像线路按需从地址发布页拉取 */
  lineState: () => call<LineState>("line_state"),
  lineSet: (url: string) => call<string>("line_set", { url }),
  lineMirrors: () => call<LineMirrors>("line_mirrors"),
  lineProbe: (urls: string[]) => call<LineProbe[]>("line_probe", { urls }),

  /* 更新检查：对比 GitHub Release 的 tag */
  checkUpdate: () => call<UpdateInfo>("check_update"),
  openUrl: (url: string) => call<void>("open_url", { url }),
};

/* ── 更新检查 ───────────────────────────────────────────── */

export type UpdateInfo = {
  current: string;
  latest: string;
  tag?: string;
  has_update: boolean;
  url: string;
  name?: string;
  published_at?: string;
  notes?: string;
};

/* ── 线路（数据源） ─────────────────────────────────────── */

export type LineItem = { name?: string; url: string; host?: string };
export type LineState = { base: string; default: string; fixed: LineItem[] };
export type LineMirrors = { source: string; script?: string; items: LineItem[] };
export type LineProbe = { url: string; ok: boolean; status?: number; ms: number; error?: string };

/** `https://a.b/c` → `a.b`（线路展示用） */
export const hostOf = (url: string) => {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
};

/* ── 自检：验证 webview → 本地协议 → 上游 的取流链路 ───────── */
export async function selfTest(): Promise<string> {
  const steps: string[] = [];
  try {
    const info = await api.play(117, 3);
    steps.push(`play:${info?.video_url ? "ok" : "empty"}`);
    const hlsUrl = `${LOCAL}/hls?u=${encodeURIComponent(info.video_url)}`;
    const r1 = await fetch(hlsUrl);
    const txt = await r1.text();
    steps.push(`hls:${r1.status}/${txt.length}/${txt.startsWith("#EXTM3U") ? "m3u8" : "bad"}`);
    const keyLine = txt.split("\n").find((l) => l.startsWith("#EXT-X-KEY"));
    if (keyLine) {
      const m = keyLine.match(/URI="([^"]+)"/);
      if (m) {
        const rustUrl = m[1];
        steps.push(`rustUrl:${rustUrl.slice(0, 60)}`);
        // A/B：用 JS 重新编码同一条上游地址
        const inner = decodeURIComponent(rustUrl.split("?u=")[1] || "");
        steps.push(`inner:${inner.slice(0, 50)}`);
        try {
          const rk = await fetch(rustUrl);
          const bk = await rk.arrayBuffer();
          steps.push(`keyRust:${rk.status}/${bk.byteLength}`);
        } catch (e) { steps.push(`keyRust:throw:${(e as Error).message.slice(0, 30)}`); }
        try {
          const rk2 = await fetch(`${LOCAL}/seg?u=${encodeURIComponent(inner)}`);
          const bk2 = await rk2.arrayBuffer();
          steps.push(`keyJs:${rk2.status}/${bk2.byteLength}`);
        } catch (e) { steps.push(`keyJs:throw:${(e as Error).message.slice(0, 30)}`); }
      }
    }
    const segLine = txt.split("\n").find((l) => l && !l.startsWith("#") && l.includes("/seg?u="));
    if (segLine) {
      try {
        const r2 = await fetch(segLine.trim());
        const buf = await r2.arrayBuffer();
        steps.push(`seg:${r2.status}/${buf.byteLength}`);
      } catch (e) { steps.push(`seg:throw:${(e as Error).message.slice(0, 40)}`); }
    } else steps.push("seg:no-line");
  } catch (e) {
    steps.push(`err:${(e as Error).message.slice(0, 60)}`);
  }
  return steps.join(" | ");
}

/* ── 格式化 ─────────────────────────────────────────────── */

export const fmt = (n: number | undefined) => {
  const v = Number(n) || 0;
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  return String(v);
};

export const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
};

export const dur = (s?: number | string) => {
  const n = Number(s) || 0;
  if (n <= 0) return "";
  const m = Math.floor(n / 60);
  const ss = n % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
};

/** 非 m3u8 媒体（mp4 等）走 /seg 原样透传 */
export function directMedia(url: string): string {
  return `${LOCAL}/seg?u=${encodeURIComponent(url)}`;
}

/** 按扩展名选择代理方式：m3u8 → 播放列表改写；其它 → 原样透传 */
export function mediaUrl(url: string): string {
  return /\.m3u8(\?|$)/i.test(url) ? playlist(url) : directMedia(url);
}
