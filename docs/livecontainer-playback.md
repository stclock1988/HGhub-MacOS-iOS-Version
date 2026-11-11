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
