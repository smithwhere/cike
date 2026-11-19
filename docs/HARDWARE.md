# 硬件指纹模拟（0.9.0）

## 内核模式（新增）

0.9.0 新增 **内核模拟（Camoufox / Firefox）**，用于避免 0.8.0 软件模拟产生的网页 API 替换痕迹。它使用固定版本的 Camoufox，在 Firefox 内部设置 CPU 线程数；不向网页注入硬件脚本，不替换 `navigator` getter、Canvas、WebGL 或音频函数。

1. 进入“设置 → Camoufox 指纹内核”下载安装。下载约 1.3 GB，展开约 2.6 GB，安装前须关闭所有环境。
2. 新建环境，或编辑环境并展开“指纹选项”，选择“内核模拟（Camoufox / Firefox）”。
3. 设置 CPU 线程数。显卡标识和图形能力来自 Firefox 内核。
4. 保存并关闭、重新打开环境。

**数据与兼容性：**Firefox 使用环境目录下独立的 `firefox` 子目录；原 Chromium 的 Cookie、站点数据保留，切回 Chromium 后继续使用。两种内核之间不会自动迁移登录状态。Firefox 不支持 Chrome 扩展、Chromium CDP 调试端口和所有仅限 Chrome 的网页功能。

0.10.2 可在设置中选择 Camoufox 图形渲染模式。兼容软件绘制使用 CPU 合成窗口，绕开故障的 GPU/D3D11 合成路径，保留原生网页接口；它可能改变 Canvas/WebGL 的实际结果和性能。显卡标识设置不保证对应的硬件加速能力，无法提供的 WebGL 功能不会用网页脚本补造。自动回退仅针对已识别的 Windows 图形启动崩溃，具体用法见 [Windows 说明](WINDOWS.md)。

**范围：**页面、iframe、专用/模块/共享/Service Worker 共用 CPU 配置。语言与请求头由内核统一设置，时区由内核处理。User-Agent 使用所选 Firefox 预设或内核原生值。Canvas、音频和字体采用原生输出，不添加种子噪声。Firefox 原本不提供 `navigator.deviceMemory`，本模式保持该接口不存在；配置编号不是网站看到的完整指纹，不保证每个环境的完整指纹都不同。

**窗口与下载：**仍默认最大化并记住 F11 全屏。随内核加载的本地后台扩展仅管理真实窗口，没有内容脚本或可被网页读取的资源。窗口控制使用独立、随浏览器关闭失效的能力令牌；该令牌不能访问一般 API。仅随机的 `.localhost` 控制域名绕过环境代理，普通网页请求继续使用配置的代理。下载使用 Firefox 原生下载管理器，保留文件名、处理重名并保存到系统下载目录。

内核固定为 [Camoufox v158.0.1-beta.41](https://github.com/daijro/camoufox/releases/tag/v158.0.1-beta.41)，匹配 Playwright 1.62.0。下载来自该项目官方 Release，先校验固定 SHA-256，再验证版本与启动，完成后才切换可执行文件标记。内核源码、许可证与第三方字体声明由 Camoufox 项目及下载包提供。CIKE 不把第三方内核称作自行编译的内核。

`test/kernel-runtime.test.js` 验证原生 getter、像素/音频、各类 Worker 的首次读数、请求头、重启、数据隔离与真实下载。`test/kernel-window.test.js` 验证 Windows 最大化、F11、新窗口及新环境继承。性能、驱动和其他底层信号仍可能与报告的 CPU/GPU 不同。

## 软件层模式（0.8.0 保留）

0.8.0 的**软件层硬件指纹模拟**继续保留。它改变网站通过部分浏览器 API 读取到的值与输出，会被检查原生函数或已知像素的检测网站识别，不改变真实硬件、驱动或计算能力。

## 使用

在“新建环境 → 指纹选项”或“编辑环境 → 指纹选项”中，把策略改为“硬件模拟（软件层）”。可设置：

- CPU 线程数可选 2、4、6、8、10、12、14、16、18、20、22、24、28、32。随机生成从 4 线程起取值。22 线程规格参考 [Intel Core Ultra 7 155H](https://www.intel.com/content/www/us/en/products/sku/236847/intel-core-ultra-7-processor-155h-24m-cache-up-to-4-80-ghz/specifications.html)。
- 网页内存默认由内核报告。软件层手动测试分为桌面常用的 2、4、8、16、32 GiB 和兼容性测试值 0.5、1、48、64、96 GiB。手动选择仅改变 JavaScript 的 `deviceMemory`，请求头由内核按站点协商。[Chrome 147 内存分档](https://developer.chrome.com/release-notes/147#update_device_memory_api_limits)
- 软件层可以选原生显卡或当前平台的测试标识。Apple Silicon 提供 Apple 预设，Windows 和 Linux 提供 Intel、NVIDIA、AMD 预设。Intel Mac 自动创建时使用原生显卡。
- UA 默认使用内核原生值。手动选项按当前主版本和其他版本分组，用于兼容性测试。检测页可核对实际内核版本、UA、平台及浏览器公开的 Client Hints。
- Canvas 读取可选按环境固定处理或原生输出。音频使用内核原生读写。

首次保存会生成固定的环境种子。更名、修改代理、关闭重开或重启 CIKE 不会自动更换种子。点击“生成另一组”可以重新生成参数和种子；修改后需要关闭并重新打开环境。

桌面端每次新建环境默认抽取 CPU、网页内存、可用的当前内核 UA 与显卡预设、窗口尺寸与缩放、同地区的语言和时区，以及网页外观、动画、对比度和强制配色。Windows 使用配套的屏幕预设。每份配置包含新的 Canvas 种子，创建后关闭重开仍使用保存的配置。选择「新建独立环境并打开」可一次保存并启动。音频、插件和字体使用原生读数，代理与 WebRTC 网络策略由用户选择。

当前内核有多个 UA 预设时，默认创建会避开上一份环境的 UA。传统 `User-Agent` 请求头和 `navigator.userAgent` 使用保存的预设，`Sec-CH-UA` 和 `navigator.userAgentData` 使用内核值。

Windows 的软件层模式提供 30 个手动 UA 预设，包括 Chrome 10 个、Edge 9 个、Opera 8 个和 Vivaldi 3 个。版本覆盖 2026 年 7 月底至 11 月的稳定渠道和部分预览渠道。完整版本号和 Vivaldi 品牌标记属于兼容性测试格式。Chromium 158 的自动抽取范围为其中 6 个。旧环境编辑时仍可选择已保存的 UA。版本参考 [Chrome 发布记录](https://chromereleases.googleblog.com/)、[Edge 发布排期](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-release-schedule)、[Edge Beta 发布记录](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnote-beta-channel)、[Opera 发布记录](https://blogs.opera.com/desktop/) 和 [Vivaldi 桌面发布记录](https://vivaldi.com/blog/desktop/)。

本地 HTTP API 可在创建环境时传入 `fingerprintMode: "random"`，省略时使用原生一致。切换策略时 Cookie 和站点数据由所选内核的环境目录保存。升级后的软件层和内核模式使用原生音频，已有的跨平台或内核不兼容显卡预设会改用原生显卡。

## 对照两个窗口的读数

先看环境检测页页首的环境编号。同一环境里的新窗口沿用已保存的配置。要在新窗口使用独立配置，从「环境管理 → 新建独立环境」创建并打开环境。展开「当前网页读到的参数」即可离线查看读数。点击「检测出口 IP」后，页面分别检查 IPv4、IPv6 出口，并查询可用出口的地区。

| 项目 | 环境检测页显示 |
| --- | --- |
| WebGL / WebGPU | 配置的显卡标识、当前绘制模式、网页读到的渲染器和适配器能力 |
| Canvas / 音频 | 文本、渐变、半透明像素、重复读取及 PNG 往返，以及离线音频采样率与复制读数 |
| 插件 / 字体 | 页面读取的插件、内嵌 PDF 支持、可访问的字体样本和中日韩字形尺寸 |
| RECTS | 多行文字布局、屏幕可用区域、视口和 DPR |

第三方检测页可以选择不同的输入和摘要算法。对照环境设置时以本地检测页的原始读数和固定样本为准。

在环境检测页点击「本地合成样本」，可以离线查看 PLUGINS、RECTS、FONTS 和 AUDIO 的合成数据和摘要。选中两个独立环境并点击「对比」，页面并排显示摘要，逐项标明相同或不同。已关闭的环境也可选择。样本由环境 ID 固定生成，关闭重开后可复现。本地样本页只展示测试数据。

## 实现范围

| 表面 | 行为 |
| --- | --- |
| `navigator.hardwareConcurrency` | 返回所选线程数，覆盖页面和 Worker |
| `navigator.deviceMemory` | 在浏览器原本提供该接口的上下文中返回所选值 |
| 内存请求头 | 由内核处理 Client Hints 协商 |
| WebGL / WebGL2 | 替换可用的未屏蔽厂商、渲染器标识；处理 RGBA / UNSIGNED_BYTE 的像素读回 |
| WebGPU | 在接口和适配器可用时替换适配器信息标识，不创建虚构适配器 |
| Canvas / OffscreenCanvas | 对不透明 8 位像素采用按种子固定的最低位处理，覆盖常用读取和 PNG 导出；重复读取不累加变化 |
| AudioBuffer | 使用内核原生读写；启动页只计算本地离线样本 |
| Worker | 在初始脚本执行前安装，包括专用、模块、嵌套、Blob、SharedWorker 与 ServiceWorker |

Worker 使用原始 URL 和加载方式，保留 CSP、同源规则与浏览器沙盒。启动不额外开放远程调试端口。跨环境的浏览器进程与数据目录继续独立。

## 明确限制

- 操作系统、Client Hints、字体和媒体设备由运行中的内核和系统提供。UA 预设设置传统 `User-Agent` 请求头和 `navigator.userAgent`。
- 音频设备按浏览器原生权限枚举。网卡型号和 MAC 地址没有对应的标准网页字段，连接读数来自浏览器提供的网络估计。参见 [MediaDevices](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices) 和 [NetworkInformation](https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation)。
- Windows 窗口仍默认最大化并记住 F11 全屏；本模式不把窗口恢复为固定的页面尺寸，也不伪造显示器和系统 DPI。
- GPU 预设只模拟标识。驱动功能、扩展、限额、着色器精度和性能仍取决于实际设备，不能视为完整的虚拟 GPU。
- 透明像素、广色域、浮点格式和超过 16,777,216 像素的 Canvas 采用原生结果。其他 WebGL 像素格式和自定义 Worklet 也由内核处理。跨域像素读取受浏览器原始权限控制，导出保留原有的同步异常或 Promise 拒绝方式。
- CPU 性能、调度、JS 堆容量、字体栅格化等底层特征没有变成另一台电脑。网站仍可能识别软件模拟或通过其他信号关联环境。
- 稳定性以相同浏览器与系统运行环境为前提，升级内核、显卡驱动或系统可能改变底层渲染/音频结果。

## 维护和验证

Worker 初始化适配当前锁定的 Playwright **1.64.1**。它在 Playwright 恢复 Worker 前排入配置，避免只在 Worker 事件回调中修改而错过首次执行。升级 Playwright 必须同步验证适配器；无法初始化时关闭该环境，不静默降级为部分模拟。

`test/hardware-runtime.test.js` 验证页面、iframe 与 Worker 的读数、首个请求及协商后的内存头、Canvas 导出、原生音频读写和重启稳定性。`test/environments.test.js` 验证检测页开启后可在零外部请求的情况下完成本地读数。
