# LiveContainer 下 iOS 无法播放视频：根因与修复（v1.2.1）

## 现象

同一份 iOS IPA，用 SideStore / TrollStore 独立安装能播，放进
LiveContainer 里点播放一直转圈 / 黑屏不出画面。列表、搜索、封面都正常，
只有视频播不出来。

## 根因：播放走的是一条 WKWebView 专属链路，LiveContainer 下这条路断了

这个仓库不是原生播放器。iOS 上的播放链路是：

```
上游 m3u8 / 分片
  → Rust 代理（hg://localhost 自定义协议，改写 m3u8 里的分片/Key 地址）
  → WKWebView 里的 fetch()
  → hls.js 1.6.19
  → ManagedMediaSource（MMS）→ <video>
```

这条路在 iPhone 上有三个硬伤，LiveContainer 把它们全放大了：

1. **iPhone 没有标准 MSE，只有 ManagedMediaSource（iOS 17.1+）。**
   hls.js 在 iPhone 上只能走 MMS。MMS 对本地加载的 WKWebView 页面是
   受限/不可靠的（同类播放器 NanoPlayer 的更新日志明确写了要为
   “iOS WKWebView 里本地加载的页面拿不到 ManagedMediaSource”
   做 HLS 回退）。代码还显式设了 `preferManagedMediaSource: false`，
   且没给 `<video>` 设 MMS 要求的 `disableRemotePlayback`。
   MMS 拿不到时 hls.js 不会报致命错，只会一直等 `startstreaming`，
   症状就是无限转圈、黑屏、无报错——和报上来的现象一致。

2. **原生回退分支本身就是死的。**`Player.tsx` / `VideoSurface.tsx`
   里 `Hls.isSupported()` 为假时走 `video.src = playlist(src)`，
   也就是 `video.src = "hg://localhost/hls?u=…"`。但 `<video>` 的加载
   走 AVFoundation，根本不经过 WKWebView 的 `WKURLSchemeHandler`，
   AVFoundation 解析不了 `hg://`，这条回退永远播不出来。
   等于说：MMS 一旦不行，App 里没有任何一条路能播。

3. **LiveContainer 让 WebKit 这条路更不可靠。** 访客 App 跑在宿主
   LiveContainer 的 bundle 身份下：访客的 entitlements 不生效、
   沙盒按宿主走、WebKit 的 WebContent / 媒体进程都按宿主身份启动。
   自定义协议与媒体进程的身份检查在这种环境下更容易被拒。
   对照组很说明问题：YouTube（原生播放器）和 Han 的原生
   hghub-ios（AVPlayer）在同一个 LiveContainer 里都能播——
   能播的都是不走 WKWebView 媒体栈的，播不了的恰好是走它的。

上游、线路、代理都不是根因：列表与封面走 Rust `invoke` + reqwest，
不经过 WebView 媒体栈，所以它们正常；视频分片在 macOS 上经同一套
Rust 代理能播，也证明代理本身没问题。

附带说明：LiveContainer 多任务模式本身也有视频冻结的已知问题
（LiveContainer #870，3.8.0 已修）。实测时请用单任务模式、
并把 LiveContainer 升到最新，避免把两个问题混在一起。

## 修复：iOS 改走原生 AVFoundation + 本机 HTTP 媒体服务器

```
上游 m3u8 / 分片
  → Rust 代理（同一份 media::handle：Referer/UA、AES Key 改写、缓存）
  → Rust 本机 HTTP 服务器 http://127.0.0.1:<随机端口>
  → AVFoundation 原生 HLS → <video>
```

- **新文件 `src-tauri/src/media_server.rs`**：只在 iOS 启动，
  `TcpListener` 绑 `127.0.0.1:0`（系统分配随机端口，不监听任何外部
  网卡），请求直接复用 `media::handle`，回包按 `origin =
  http://127.0.0.1:<port>` 改写 m3u8。AVFoundation 拖动进度会发
  `Range` 请求，这里正确回 `206 Partial Content`
  （`media::handle` 本身不处理 Range，那条路是给 fetch/hls.js 的）。
  只有 `/hls`、`/seg`、`/img` 三个路径。端口经
  `media_server_port` 命令告诉前端。
- **`src-tauri/src/lib.rs`**：iOS 启动时 `spawn(media_server::run())`，
  注册 `media_server_port` 命令。绑定失败也不影响启动，
  前端自动回退 hls.js。
- **`src/api.ts`**：`canPlayNativeHls()`（`canPlayType(
  "application/vnd.apple.mpegurl")`）、`get/setPlaybackEngine()`
 （localStorage `hghub.playbackEngine.v1`，iOS 默认 `native`）、
  `nativePlaybackUrl(src)`（`hg://localhost/…` 或上游地址换成本机
  HTTP 地址；服务器未起返回 `null`）。
- **`src/components/VideoSurface.tsx` / `Player.tsx`**：iOS 默认原生
  优先；原生 `error` 或 12 秒仍无数据（`readyState < 2`）时自动
  切 hls.js（每源一次，切集后旧回调作废）；原生失败且片源不是
  m3u8 时直接报错，不再挂死地址。hls.js 回退分支补了
  `video.disableRemotePlayback = true`（MMS 要求）。
  `video.src` 再也不直接挂 `hg://` 地址。
- **`src/pages/Settings.tsx`**：播放区加 iOS 专属“播放引擎”
  （原生 / 网页）切换，下个视频生效；原生播不了时先在这里切网页
  对照，也能帮定位是原生链路还是上游问题。
- **`src/playbackDiagnostics.ts`**：`app.start` / `app.snapshot`
  加 `native_hls`，启动时另记一条 `media.server`
  （`media_http_port`）。定位时看 `source.load` 的 `engine`
  字段：`native` / `hls.js` / `native-direct`。
- **CI（`.github/workflows/build-ios.yml`）**：Info.plist 补
  `NSAllowsLocalNetworking` 与 `NSLocalNetworkUsageDescription`
  （本机服务器只在回环地址内转发播放数据）。

macOS / Android 不动：macOS 继续 hls.js + `hg://`（实测能播），
Android 继续 `http://hg.localhost` + MSE。

## 风险与取舍

- **CDN 防盗链**：原生直连上游 m3u8 时 AVFoundation 不带 Rust 那份
  Referer/UA，所以原生不直连上游，仍经过 Rust 代理（本机服务器），
  Referer/UA 与原来 `hg://` 完全一致。
- **ATS / 本地网络**：`http://127.0.0.1` 是回环地址，WKWebView 与
  AVFoundation 的流量不触发本地网络授权弹窗（Apple TN3179）；
  Info.plist 仍补了 `NSAllowsLocalNetworking` 与用途说明作兜底。
- **后台 / 画中画**：原生 `<video>` 的后台音频与画中画走系统行为，
  比 MMS 更接近 YouTube 的表现；但本版没改后台模式声明，
  后台行为仍以实测为准。
- **无法在本机验证**：Linux 无 Xcode，Rust iOS 目标与真机播放
  只能由 CI（macOS）构建 + Han 在真机上验证。本版前端类型检查与
  Rust 单元测试（Range 解析）在本地已过，见下。

## 实测步骤（Han）

1. 合 main 后等 CI 出 `v1.2.1-ios` 的 IPA（或 Release 附件）。
2. **LiveContainer 里装 1.2.1**，播首页任意视频（复现用例：117 第 3 集），
   应直接出画面；再切一集、拖一次进度条。
3. 若仍播不出：设置 → 播放诊断 → 开日志，复现一次，复制
   `playback.log` 发回。关键看三行：`media.server` 有没有端口、
   `source.load` 的 `engine` 是 `native` 还是 `hls.js`、
   有没有 `native.failed` / `native.stalled` / `native.fallback`。
4. 对照：同一台手机用 SideStore 独立装 1.2.1 播同一集；
   以及在设置里把引擎切到“网页”再播一次。
   判断表：
   - LiveContainer 原生不行、SideStore 原生行 → LiveContainer
     对本机回环 / AVFoundation 仍有限制，需再查；
   - 两边原生都不行、切网页行 → 原生链路问题，看日志里的
     `native.failed` 错误码与 `media.server` 端口；
   - 两边原生与网页都不行 → 上游/线路问题，与本修复无关。
5. LiveContainer 请用单任务模式、升到最新版再测。

## 本地验证记录（2026-11-11，Linux VM）

- `npm run build`（`tsc --noEmit` + tests 类型检查 + `vite build`）：**通过**
  （1.2.1，`dist` 产物正常；中途修过一个 TS 报错：嵌套的 `function`
  声明会丢 `video` 的非空收窄，改成箭头函数后通过）。
- `parse_range` 单元测试（把 `media_server.rs` 里的函数原样抽出，
  `rustc --test`）：**2 passed**（开区间/后缀/越界/多段）。
- `rustfmt --check`：`media_server.rs` 通过；`lib.rs` 未动格式。
- **未通过**：`cargo test --lib` 在 Linux 上编不过——缺 Tauri Linux
  的系统库（`gdk-3.0` 等），与本次改动无关；Rust iOS 目标与真机
  播放只能由 CI（macOS 构建）+ 真机验证。
- 未做：Xcode 真机编译、真机播放、SideStore / LiveContainer 对照。

## 1.2.1 真机日志结论（2026-11-11，Han 的 playback.log）

- 版本确认 1.2.1，iPhone 18.7，`native_hls: true`，`media_source: false`，
  `managed_media_source: true`。
- 上游与代理都正常：`api.play` 返回 200，全部封面经 `hg://` 协议返回 200。
- **播放器一次都没启动**：26 秒的 feed 停留里没有任何 `source.load`、
  `page.active`、`play.request`——`VideoSurface` 根本没挂载，界面只有
  封面分支。两种可能：`api.play` 200 但 `video_url` 为空（会弹
  “暂无播放地址”），或取端口的 `invoke` 挂住（`startNative` 在 `await`
  处等不到结果，`source.load` 在 `await` 之后所以永远不出现，且 12 秒
  回退定时器也在 `await` 之后才设，同样不会触发）。
- 日志本身有个缺口：`media.server` 只在 App 启动时记一条，日志若是
  启动后才打开，那条就丢了——本次日志里就没有它，所以无法判断本机
  服务器到底起没起来。
- 1.2.2 的改动就是补这个缺口：开日志时也补记 `media.server`；取播放
  地址记 `play.url`（`has_url`）与 `play.failed`；原生启动前记
  `native.waiting`；`media_server_port` 桥接调用 5 秒超时（超时按服
  务未启动处理，回退 hls.js，不再无限等）。

## 1.2.2 真机日志结论（2026-11-11，Han 传的第二份日志，含 4 个进程）

- 1.2.2 的两轮（pid 1488 / 1492）：本机媒体服务器正常启动
  （`media_server.start` 端口 55557 / 55628，`web.media.server`
  一致）；`play` 接口 4 次全部 200 + `business_status: 1`；
  但 `play.url` 之后同一毫秒立刻跟 `play.failed`，且没有任何
  `source.load` / `native.waiting`——说明 `api.play` 正常返回，
  但 `info.video_url` 是空的，走到 `throw "暂无播放地址"`。
- 1.2.2 诊断本身有个坑：`playback_log.rs` 的 `scrub()` 会丢掉键名
  含 `url` / `message` 的字段，所以 `play.url` 的 `has_url` 与
  `play.failed` 的 `message` 都没进磁盘。1.2.3 改成
  `has_address` / `detail`。
- 同份日志里还有个 1.2.18 进程（pid 1456）：视频 3483 第 1 集正常
  挂载播放器（`web.play.resolve`，`resolved: true`，主机
  `yd-lphu-long.hzjvlo.cn`，`paused: false`），且日志里没有任何
  `play` 接口调用——它的地址来自三次 POST `video` 请求之一，
  即新播放接口。

## 根因（2026-11-11 已验证）：上游废弃了旧播放接口

本机实测（游客、无登录，两条线路都一样）：

- `GET /api/videos/{id}/play?ep=&page_texts=0`（旧）：
  `status: 1`，但 `video_url` / `video_url_hevc` / `video_api` /
  `video_key` / `video_iv` / `media_id` 全是空串。视频 12、117、
  3483（第 1、3 集）都一样。详情与列表同样不带地址。所以跟
  播放器、媒体服务器、LiveContainer 全无关——根本没有地址可播。
- 官网视频页 HTML 里公布的路由表有新接口：
  `POST /api/videos/:id/episodes/:ep/playback`。
  实测返回 `data.streams.main`（m3u8，主机正是 1.2.18 日志里的
  `yd-lphu-long.hzjvlo.cn`，`auth_key` 约 1 小时有效），另有
  `streams.preview` / `streams.hevc` 与 `cdn` 鉴权信息；该 m3u8
  直接拉取正常（`#EXTM3U`，AES-128，`tp6.drleao.cn` 分片）。
- 1.2.3 的改动：`api_play` 改走新 POST 接口，`streams.main`
  （无则 preview，再无则 hevc）映射回旧 `PlayInfo` 形状，前端
  不用改；并修了上面那个 scrub 字段名问题；版本 1.2.3。

## 1.2.3 日志分析（2026-11-11 12:53，upload-15.txt，2534 行）

- 两个 1.2.3 进程（pid 1526 04:46、pid 1569 04:52）：地址都拿到了
  （`play.url` 的 `has_address: true`），原生挂载，`play.request`
  （`native_autoplay`）正常，`media.play` 触发，`paused: false`，
  `loadedmetadata` 时长正常，`loadeddata`/`canplay` 后
  `buffered [[0, ~5]]`，`playing` 事件反复触发。
- 但 `currentTime` 恒 0：5 秒一次的 heartbeat（04:46:44→04:46:54→…、
  04:53:00→04:53:20）time 一直是 0（或 seek 后的 66.803、369.717）；
  `readyState` 在 4↔2 之间抖；buffered 涨到 `[0, 101.6]` 后停滞
  （`media.stalled`）；全程 `media_error: null`、`rate: 1`；
  无 `play.rejected` / `play.blocked`，无 `native.failed`。
- seek 本身工作：`currentTime` 跳到目标（228.043、369.717），
  buffered 跟到目标附近，但之后还是不动；整个文件里一次
  `web.seek.resumed` 都没有——seek 后
  `requestVideoFrameCallback` 从未触发，即没有新帧被呈现出来。
- Rust 一侧全部正常：pid 1526 的 141 条 `proxy.end` 全是 200
  （无一条非 200），90 次 `segment_or_key`：key 16 字节、分片
  475KB~4.2MB；9 次 playlist 全 200。本地复核：key 200/16 字
  节，分片 0 用 key+IV 解密后是合法 MPEG-TS（0x47 同步、188 字
  节对齐）；m3u8 是标准 VOD（165 集、总长 820.5s、有 ENDLIST）。
  所以内容、网络、Rust 代理、本地 HTTP 服务器的取数都没有问题。
- 结论：原生 AVFoundation 在这台 LiveContainer 里拿到了正确数据
  却不走时钟。问题在原生引擎消费本地 HTTP 服务器数据这一环，
  根因未定位（Range、keep-alive 等都只是猜测，日志里看不到
  AVFoundation 的 HTTP 交互）。
- 同份日志里的 1.2.18 进程（pid 1456）反证：hls.js +
  ManagedMediaSource 在同一个 LiveContainer 里是正常播的——
  3483 第 1 集 time 0→7.266 实时走，分片 0~4 各约 1.5s 加载完成。
  后来卡在 316.638 是另一回事：seek 到 316 后分片 63 两次加载
  都失败（`network.end`：`dns_error`、`transport_error`，最后
  `proxy 502`），同时段其他图片请求也 `transport_error` /
  `dns_error`——那是手机到 CDN 的网络通路当时断了（代理/DNS
  层面），与引擎无关；网络恢复后 1.2.3 的原生仍卡住，说明原生
  卡住不是网络问题。
- 所以 1.2.1 建原生路线的假设（“hls.js + MMS 在 LiveContainer
  里播不了”）被直接证据推翻：1.2.1 当时播放器根本没挂载
  （无 `source.load`）是因为地址是空的（旧接口已废弃），不是
  MMS 的问题。
- 1.2.4 的改动：iOS 默认引擎改回 `hlsjs`（设置里仍可切原生）；
  原生路径补一个时钟看门狗——12 秒定时器里除了 `readyState < 2`
  之外，若 `readyState` 已够、未暂停、`currentTime` 仍 `< 0.5`
  也切 hls.js（原来只看 `readyState`，冻结时它是 4，拦不住）。

## 1.2.4 日志分析（2026-11-11 13:41，upload-16.txt，pid 1668）

- 1.2.4 已按预期走 hls.js（`source.load` 的 engine 是 hls.js，
  ManagedMediaSource）：时间确实在走——0→1.299，拖到 67.955 后
  67.955→70.871→71.131，之后又拖到 180、50、167、178 都有进展。
  所以“依然”不是 1.2.3 的时钟冻结，而是**播几秒就卡住**。
- 卡的原因是分片拉取慢：中位数 288ms，但有 6 次超过 3 秒。
  最慢的是分片 2（4,230,944 字节）：hls.js 因卡顿重试，连发
  3 次相同请求；每次的首试都在 body 中途断掉（`transport_error`，
  7~9 秒后才失败），重试 1~1.7 秒就通。分片 12（寻求后）同样
  首试 7.4 秒 `transport_error`、重试才通。首试一断，播放器
  的缓冲（刚开播、刚拖动时本来就薄）就被耗空，报
  `bufferStalledError`，画面定住。
- 两个可修的点：① 分片缓存上限 `SEG_CACHE_MAX_BYTES` 是 4MB，
  4.23MB 的分片永远进不了缓存（只差 36KB），所以 3 次并发请求
  各自都去拉了 CDN；② 读 body 没有停滞超时，`resp.bytes()` 一
  直等到对方断开（约 8 秒）才报错重试。
- 1.2.5 的改动（Rust）：分片缓存上限 4MB→8MB；`fetch_bytes`
  改分段读 body，每段 3 秒没新数据就判“下载停滞超时”报错重试
  （可重试的 timeout kind，走已有 3 次重试；“无数据超时”不会
  误杀慢但持续有数据的连接）。版本 1.2.5。

## 1.2.5 验证通过，但画面仍不动（2026-11-11 13:50，upload-17.txt，pid 1700）

- 1.2.5 日志验证通过：时间全程实时走（每 5 秒心跳前进 5.01 秒），
  缓冲 34 秒深，拖到 89 秒后缓冲立刻 33 秒；分片 11 次全部
  154~863ms（中位数 253ms），零网络错误、零 bufferStalledError；
  上次卡 9.6 秒的 4.23MB 分片这次 2 秒内拉到。两次
  `media.stalled` 都是瞬间小抖动（缓冲 34 秒、ready 4）。
- 但 Han 13:50 报“进度条在动，但是画面不动”，13:51 补“画面不动，
  也没有声音”。所以时钟与拉取都好了，剩下的是**呈现**问题：
  currentTime 走、缓冲满，但画面不换。注意：seek 后确实呈现了
  新帧（`seek.resumed`，method `video_frame`，frame_time 86.767，
  1.2.4 之前一次都没有），说明呈现通路本身能工作，只是在连续
  播放时不更新。编解码已排除：分片解密后 PMT 是标准 H.264 + AAC。
- 声音：1.2.5 日志里 88 次快照 `muted` 全是 true——应用默认
  启动静音（store 里 `muteOnStartup` 默认为 true），没点喇叭图标
  本来就没声音；要先确认 Han 是否点了取消静音。
- 1.2.6 的改动：① 诊断补持续帧计数——`requestVideoFrameCallback`
  循环统计真正呈现到屏幕的帧数，心跳里带 `frames_presented` 与
  `last_frame_time`（播放 5 秒应涨约 120~150 帧，涨 0 说明画面真
  没呈现）；② 候选修复：不缩放时去掉视频元素的 `translateZ(0)`
  强制合成层（在 LiveContainer 的 WKWebView 里它可能让视频层一直
  显示旧帧；缩放手势时仍用 translate3d）。版本 1.2.6。

## 1.2.6 诊断定性：画面真没呈现（2026-11-11 14:00，upload-18.txt，pid 1770）

- 帧计数是决定性的：36 秒“播放”只呈现了 **3 帧**（0→2 帧，拖动后
  又呈现 1 帧到 50.867，之后再没涨过）。30fps 的视频 36 秒本该
  呈现约 1000 帧。画面不动不是被遮住、不是海报盖着——视频元素
  本身几乎不呈现帧。去 `translateZ(0)` 的候选修复没生效。
- 声音也确认了：心跳里视频元素自己的 `muted` 在 06:00:16 翻成
  false（Han 确实点了取消静音），还是没声音。所以音画两路呈现
  都死了，只剩 MSE 的解码/时钟在跑。
- 同一个 log 里另有一个独立问题：这次网络又变差了，分片 7 次
  451ms~16.3 秒、1 次 transport_error、3 次 bufferStalledError，
  时钟 10 秒只爬 0.5 秒、缓冲只剩 5 秒、ready 掉到 2~3。这是
  代理/CDN 通路的波动（1.2.5 测时最慢才 0.86 秒），与呈现问题
  是两回事，不要混在一起。
- 结论：WKWebView 的 `<video>` 在 LiveContainer 里呈现死掉
  （解码/缓冲/时钟正常，帧和声音都出不来）；seek 能呈现一帧，
  只是合成器被强制渲染了一次。原生 AVFoundation 路径 1.2.3
  时钟冻在 0 也与此一致——AVFoundation 的时钟由呈现驱动。
- 1.2.7 的改动：全屏按钮先试系统播放器全屏
  （`webkitEnterFullscreen`，有则用，没有则
  `webkitSetPresentationMode("fullscreen")`），把呈现交给系统
  AVPlayer 层，绕开 WKWebView 的合成器；不可用时回落到原来的
  DOM 全屏。诊断加 `webkitpresentationmodechanged` 事件。版本
  1.2.7。点全屏后如果画面动起来、有声音了，就说明系统播放器
  这条路通；如果还是不动，下一步是 Tauri 的原生 AVPlayer 插件。

## 1.2.7 未测到：系统全屏一次都没触发（2026-11-11 14:18，upload-20.txt，pid 1821）

- Han 说 14:18 这份就是点了全屏的，但日志里 `video.sys_fullscreen`
  与 `webkitpresentationmodechanged` 各 0 次。呈现还是死的：
  进度条 0.35→53.29 秒在走，50 秒只呈现 3 帧，取消静音还是没声。
- 排除：日志的 `view= home` 说明他在信息流里；app.start 的 UA
  是 iPhone iOS 18_7，`isIos` 为真；控制栏的“全屏”按钮确实接
  着 `toggleFull`（PlayerControls 唯一实例，`onFullscreen={toggleFull}`），
  且同一个 `videoRef` 的拖动、静音都在日志里正常工作（非空）。
  所以按钮的点按没走到 `systemFullscreen()`——最可能是点成了
  旁边相邻的“影院模式”按钮，或者控制栏自动隐藏后第一下只调出
  了控制栏。还有一个漏掉的面：详情页的 `Player.tsx` 有自己独立
  的 `toggleFull`（只做 DOM 全屏，没接系统路径）。
- 1.2.8 的改动：① `toggleFull`（Feed）先记一笔
  `video.fullscreen_tap`（带 ios 标志），再走系统路径——下一份
  日志能分清“没点到按钮”还是“点了但系统路径没跑起来”；
  ② `Player.tsx` 的 `toggleFull` 也接上同样的系统全屏路径
  （webkitEnterFullscreen / webkitSetPresentationMode，带 trace）。
  版本 1.2.8。

## 找到根因：手机端真正能点的“全屏”按钮走的是 enterFs（2026-11-11 14:31，截图）

- Han 发了两张截图并说“点了画面没有控制栏”。第二张（信息流竖
  屏）看清了手机端 UI：右侧操作栏是 收藏 / 评论 / 全屏 / 分享，
  点画面并不会调出 PlayerControls 控制栏——手机端根本没有那条
  控制栏。第一张是横屏全屏后的样子（暂停、0:11、1x、3:27、
  进度条），是应用自己的 CSS 全屏，画面还是黑的、只有水印。
- 根因：手机端真正能点的“全屏”按钮（右侧操作栏 line 1070 与
  “横屏全屏” line 1023）走的都是 `enterFs`，它只做
  `setFs(true)` + 横屏方向锁定，根本不走系统播放器。1.2.7 只接
  了 PlayerControls 的 `toggleFull`（桌面端控制栏），手机上没人
  能点到它——所以 `video.sys_fullscreen` 一次都没出现过。
- 1.2.9 的改动：`enterFs` 先记一笔 `video.fullscreen_tap`
  （via: "enterFs"），再试 `systemFullscreen()`（系统播放器接管
  了就不再开 CSS 全屏）；不可用时回落到原来的 CSS 全屏 + 方向
  锁定。版本 1.2.9。点右侧操作栏的“全屏”就会走系统播放器。

## 1.2.9 验证：系统播放器也救不了（2026-11-11 14:40，日志 + 截图）

- Han 装 1.2.9 后点右侧操作栏的“全屏”，日志（upload-21.txt，pid 1866）
  确认系统播放器确实打开了：06:39:18 `video.fullscreen_tap`（via:
  "enterFs"）→ `video.sys_fullscreen`（mode inline、has_enter true）→
  `webkitpresentationmodechanged`；约 72 秒后第二次
  `webkitpresentationmodechanged`（06:40:30）退出。截图是系统播放器
  界面（X、画中画、音量、±10 秒、暂停、0:33/-2:55），画面是真实剧集
  内容。
- 但 Han 14:41 回“还是画面静止不动，没有声音”——系统播放器里画面
  仍是冻住的（截图那一帧）、没声音，时钟却在实时走（66.991→72.012
  →77.033）。结论修正：系统播放器也救不了，因为它底层仍走 WebKit
  的媒体管线（与视频元素共享同一条管线），继承了同样的呈现死掉。
- 注意：心跳里的 `frames_presented` 在系统播放器期间仍停在 2~3——那
  是视频元素自己的 rVFC，系统播放器走自己的呈现层不触发它，不能拿
  它判断系统播放器；以 Han 的直接反馈为准。
- 剩下的路只有一条：Tauri 原生 AVPlayer 插件（Swift 插件 + Rust 命
  令，AVPlayerViewController 在应用进程内直接播本机媒体服务器的
  m3u8，彻底绕开 WebKit；原生 HGhub app 的 AVPlayer 在 LiveContainer
  里能正常播，证明这条路本身通）。信息流内嵌播放仍是冻住的。

## 1.2.10：原生 AVPlayer 插件（2026-11-11，待 Han 测）

- 插件 `tauri-plugin-native-player`（`src-tauri/plugins/`，path 依赖）：
  Tauri 2 移动插件，按官方 Mobile Plugin Development 文档与
  `tauri-plugin-opener`（v2.7.2，同一套 API）照着写——Rust 侧
  `tauri::ios_plugin_binding!` + `api.register_ios_plugin` +
  `PluginHandle::run_mobile_plugin("play", ...)`；Swift 侧
  `class NativePlayerPlugin: Plugin`，`@objc func play(_ invoke: Invoke)`，
  `@_cdecl("init_plugin_native_player") public func initPlugin() -> Plugin`
  （public 不可少，Release 构建会 strip 掉非 public 的入口符号）。
- Swift 呈现：`manager.viewController?.present(AVPlayerViewController,
  animated: true)`，播 `http://127.0.0.1:<port>/hls?u=<m3u8>`（本机媒
  体服务器，分片/key 全走本地代理，AVPlayer 不用直连 CDN）。关闭时
  （Done/下滑，`playerViewControllerDidEndDismissalTransition`）先
  `pause()` 再 `invoke.resolve(["position": <秒>])`；Rust 的 `play`
  命令在 `spawn_blocking` 里等这个结果（不占 tokio 工作线程）。
- v1 限制：画中画关掉了（`allowsPictureInPicturePlayback = false`，
  它的生命周期会多一条 dismissal 路径）；同一时间只开一个原生播放器，
  第二次点“全屏”会拒绝（already playing）；关闭时内联播放器跳回关
  闭点的进度、仍暂停（不自动续播）。
- 前端 `enterFs`（Feed.tsx）：iOS 上先试原生插件（内联先暂停，关闭
  后 seek 到返回的 position，记 `video.native_play` {ok, position /
  detail}）；插件不可用/取地址失败时回退到 1.2.9 的系统全屏，再不行
  走 CSS 全屏。`api.ts` 新增 `playNative(url)`（invoke
  `plugin:native-player|play`）。能力文件加 `native-player:default`
  （插件 `permissions/default.toml` 的 `[default]` 集引用自动生成的
  `allow-play`）。
- 版本 1.2.10。本地验证：`npm run build`（tsc + vite）通过；Rust
  侧本机没法完整 check（Linux 桌面构建缺 gdk，iOS target 构建缺
  xcrun/iOS SDK），以 CI（macOS + Xcode）的构建结果为准。
- 验证：装 v1.2.10-ios，点开视频后直接点右侧操作栏的“全屏”，看原生
  播放器里画面动不动、有没有声音；再点 Done 回来，确认内联播放器
  回到了关闭点的进度（暂停）。
