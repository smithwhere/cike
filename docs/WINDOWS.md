# CIKE Windows x64

Windows 版源自 [engeeeee/cike](https://github.com/engeeeee/cike) 对 [chainfix/cike](https://github.com/chainfix/cike) v0.7.0 的移植。本分支在 [smithwhere/cike](https://github.com/smithwhere/cike) 维护。

[查看本仓库发布页](https://github.com/smithwhere/cike/releases)，选择 Windows ZIP 和 `SHA256SUMS.txt`。

## 使用

1. 使用 Windows 10 1803 或更新版本、Windows 11 的 Intel/AMD 64 位系统。
2. 将下载的 Windows x64 ZIP 完整解压到本地可写目录，例如 `D:\Apps\CIKE`。
3. 双击 `CIKE.exe`。运行时已随包提供，无需另装 Node.js。请保留同目录的 DLL、资源目录等文件。
4. 在“设置”中下载 Chromium 内核，然后创建并打开环境。首次下载需要联网。

Chromium 下载在解压或试运行前校验 SHA-256。`src/chromium-assets.json` 记录版本和平台摘要，摘要从 Google 官方归档计算。升级内核时应同时更新这些摘要。

本包没有 Windows 代码签名，系统可能显示未识别的发布者。可用随包的 `SHA256SUMS.txt` 核对文件。

0.9.0 新增“内核模拟（Camoufox / Firefox）”，在内核中设置 CPU 线程数，并报告原生显卡。先在“设置 → Camoufox 指纹内核”下载约 1.3 GB 内核，再在新建/编辑环境的“指纹选项”选择内核模拟。Firefox 与 Chrome 登录数据独立，旧数据保留，切换后需要重新登录。原软件层模式继续保留。[硬件模拟范围与限制](HARDWARE.md)

## Camoufox 关闭与崩溃恢复（0.10.3）

Firefox 的原生窗口和自动化协议里的页面目标并非一一对应。旧版在页面目标列表为空时主动关闭整个浏览器，可能放大内容进程切换或崩溃的影响。现在由 Firefox 自身的窗口生命周期决定退出，不再根据该列表关闭环境。原生新窗口的默认首页设为 `about:blank`，不恢复崩溃会话。

关闭环境会先正常保存并退出，协议关闭无响应时才终止该环境自身的浏览器进程。退出 CIKE 时保留可见窗口，浏览器关闭等待最多 8 秒，再清理自己的残留进程并退出，避免留下占用单实例锁的后台主进程。进行中的内核文件迁移仍会先完成。

升级后首次重开旧环境，或异常退出后重开，会将 `startupCache`、`shader-cache`、`addonStartup.json.lz4`、`xulstore.json` 中存在的文件移动到该 Firefox 环境的 `cike-recovery` 子目录备份，再由 Firefox 重建。不会删除 Cookie、登录数据库、站点存储、书签、权限或用户设置。无需删除环境、迁移内核或重新下载。

“设置 → Camoufox 指纹内核 → 导出崩溃诊断”可保存本地 JSON，包含 CIKE/内核/系统版本、绘制模式、错误类别及可取得的原生崩溃注释。不会自动发送；报告不包含原始 Playwright 日志、代理密码、页面 URL、Cookie 或内存转储。页面崩溃会在环境卡片提示。

新增测试通过独立的测试扩展直接调用 Firefox 的 `BrowserCommands.openTab` 和 `OpenBrowserWindow`，覆盖原生新标签页和新窗口，而非仅使用网页弹窗。验证旧环境缓存恢复、Cookie/localStorage 保留，以及真实浏览器关闭协议无响应时的进程清理、桌面关闭后重开。CI 同时使用 Windows Server 2022 和当前 Windows runner；这些测试不等于在用户的 Windows 10 电脑及显卡驱动上完成实测，内核自身的内容进程崩溃仍可能需要诊断。

## Camoufox GPU / D3D11 崩溃（0.10.2 / 0.10.3）

日志出现 `Failed to launch GPU process after 3 attempts`、`FEATURE_FAILURE_D3D11_NO_DEVICE` 或 `Failed to initialize CompositorD3D11 for SWGL` 时，表示图形设备或 GPU 子进程初始化失败。日志中的 `SW-WR + D3D11` 仍需要 D3D11 设备。

在“设置 → Camoufox 指纹内核 → 图形渲染”选择：

- **兼容模式（软件绘制）**：保存后重新打开环境。使用 CPU 合成，关闭 GPU 子进程、SWGL 的 D3D11 上传路径以及 Canvas / 视频硬件加速；可能增加 CPU 占用并改变 Canvas/WebGL 等图形指纹。实际可用的 WebGL 能力仍取决于系统，不会通过禁用沙箱或网页脚本补造功能。
- **自动**：默认保持正常加速策略；仅在识别到上述 Windows 图形启动崩溃时，保留相同环境和代理重试一次兼容模式。启动成功后记住选择，后续环境直接使用兼容绘制。代理或其他启动错误不会因此改为直连或无限重试。
- **硬件加速**：恢复正常加速偏好。显卡驱动修复后可选择此项，或重新保存“自动”清除已记住的兼容选择，再重新打开环境。

运行中的软件绘制环境会标记“兼容绘制”。更改渲染模式只对重新打开的环境生效，保留配置、Cookie、登录数据及内核位置，不需要删除环境或重新下载内核。

自动恢复通过报告的崩溃文本进行故障注入验证，软件合成路径和新窗口行为在 Windows CI 的实际浏览器上验证；这不等于在每一种显卡、驱动和远程桌面环境上完成实测。

## Camoufox 启动修复（0.10.1）

旧版遇到“指纹内核窗口组件未能连接，请重试”时，会主动关闭已经启动的浏览器。此问题发生在窗口同步连接，和内核是否位于默认目录没有直接关系。

0.10.1 的窗口组件使用每次启动独立的 IPv4 回环 IP，不依赖 `.localhost` 域名解析；Firefox 自身和环境代理配置同时仅排除该专用地址，避免窗口请求继续走继承的系统代理。组件请求有超时和重试，并为每次启动生成新的扩展资源路径，避免沿用旧连接信息。窗口同步异常时环境继续运行，卡片显示提示，可手动调整窗口；重连成功后提示自动消失。浏览器网站请求继续使用原环境代理。

先退出旧版 CIKE，再解压启动 0.10.1。已有内核、环境和登录数据继续使用，无需为此报错迁移内核或删除环境。

## Camoufox 内核位置与删除（0.10.0）

进入“设置 → Camoufox 指纹内核”，可以查看保存目录、各份内核的位置和占用空间。

- **更改位置 / 迁移**：选择其他本地磁盘上的文件夹。已有内核会复制到所选目录下独立的 `camoufox-...` 子目录，逐文件校验 SHA-256 并试启动，成功才切换；失败继续使用原位置。尚未下载时只设置后续下载位置。所选父目录的其他文件保持不变。
- **旧副本**：迁移后暂时保留，可确认新位置正常使用后点击“删除副本”释放空间。
- **卸载此内核**：先关闭所有环境。删除当前内核时优先切换到已通过启动验证的兼容副本；没有副本时会提示再次使用“内核模拟”前需要重新下载。环境配置、Cookie、站点登录数据保留；Chromium 不受影响。
- **占用或缺失**：有环境正在启动、运行或关闭时禁止内核操作，迁移期间也禁止打开新环境。其他进程锁住文件时，保留待清理记录供重试；手工删除过的副本可移除失效记录。
- **外部内核**：用 `CIKE_CAMOUFOX_EXECUTABLE` 指定的外部文件只读，不会自动认领或递归删除；更改位置只影响后续下载。取消环境变量后才恢复使用 CIKE 管理的内核。

默认内核目录为 `%LOCALAPPDATA%\CIKE\browsers`。自定义位置会持久保存，更新应用后仍生效。此功能只管理 Camoufox；Chromium 仍保存在 CIKE 数据目录。请保留自定义磁盘的连接和可用空间，避免运行时从资源管理器手动删除内核。

## 浏览器窗口（0.7.1）

新环境默认最大化。手动按 F11 切换全屏后，后续新建环境和浏览器新窗口会沿用全屏状态，重启应用后仍会记住。普通标签页不会重置当前窗口。

可在“设置 → 浏览器窗口”选择记住上次状态、始终最大化、始终全屏，或按环境分辨率打开。Windows 的页面尺寸随实际窗口变化；环境中的分辨率用于普通窗口启动大小，无头自动化仍使用环境配置。

“新建／编辑环境 → 指纹选项 → 显示测试预设”提供 20 种屏幕尺寸和 100% 至 300% 八档缩放，包括 2240×1400、3200×2000 和 5120×2160。每种分辨率只显示能让 CSS 视口宽高都至少达到 320 的缩放档位。预设按环境保存，新标签页及新窗口沿用设置。以 3200×2000、250% 为例，100% 页面缩放下 CSS 屏幕与默认视口为 1280×800，DPR 为 2.5。规格参考 [Windows 显示指南](https://learn.microsoft.com/en-us/windows-hardware/design/component-guidelines/display)、[ThinkPad T14 Gen 5](https://psref.lenovo.com/product/ThinkPad/ThinkPad_T14_Gen_5_Intel?tab=spec)、[ThinkPad P1 Gen 9](https://psref.lenovo.com/Product/ThinkPad/ThinkPad_P1_Gen_9) 和 [LG 5K2K 显示器](https://www.lg.com/us/press-release/LG_Eletronics_USA_UltraWide_UltraFine_Press_Release_5.4.26.pdf)。

选中测试预设的环境使用固定视口，独立于自动最大化和全屏继承。Camoufox 中网页明确指定了弹窗宽高时，弹窗以该宽高作为视口，仍沿用环境的屏幕尺寸和 DPR。面板、色域、HDR 和刷新率是典型产品规格，实际硬件状态由系统和浏览器决定。选择“跟随系统”可恢复普通窗口行为。2026 年 10 月分辨率参考 [Steam 硬件调查](https://store.steampowered.com/hwsurvey/hw/) 和 [Statcounter 桌面屏幕统计](https://gs.statcounter.com/screen-resolution-stats/desktop)。

随机新建环境时，CIKE 从全部内置显示预设及其支持的缩放档位中选取组合。候选组合的视口加上标题栏、工具栏和边框预留后，必须能放进管理窗口所在显示器的可用工作区。没有合适预设时，窗口尺寸跟随系统。

手动选定的显示预设会保留分辨率和设置的缩放。打开窗口时，如果设定的尺寸放不下，CIKE 会从该预设支持的缩放档位中，选择能完整显示视口、标题栏、工具栏和边框的最低档，应用于本次启动。没有合适的档位时，界面会提示选择较小的分辨率或跟随系统。

同一设置区还提供 61 个语言区域和 64 个时区选项，以及网页外观、动画偏好、对比度偏好和强制配色。打开环境检测页中的“当前网页读到的参数”，可以核对 UA、CSS 屏幕、视口、DPR、语言列表、CPU／网页内存、外观、WebGL／WebGPU、常见字体、编解码格式、连接估计和该页定位权限。读数在本页计算，可离线查看。通过「检测出口 IP」手动查询公网出口和地区。参数参考 [Unicode CLDR](https://cldr.unicode.org/translation/translation-guide-general/default-content)、[IANA 时区数据库](https://www.iana.org/time-zones)、[CSS 强制配色](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/forced-colors) 和 [Windows 11 字体清单](https://learn.microsoft.com/en-us/typography/fonts/windows_11_font_list)。

新环境默认使用「跟随出口 IP（启动时查询）」作为时区，也可指定固定时区。每次打开环境时，CIKE 根据出口 IP 的国家或地区选择浏览器语言，例如美国使用 `en-US`，法国使用 `fr-FR`。直连环境通过 `ipwho.is` 查询公网出口，代理环境使用代理出口的查询结果。同一环境的后续窗口沿用该次启动的语言。

从旧版升级后，已有环境保存的语言用作备用。查不到可用的语言时，直连环境使用备用语言或系统语言，代理环境可指定备用语言后重试。直连环境使用自动出口时区时，如无法获取时区会使用系统时区。

## 环境 DNS

「设置 → 网络 → 直连环境 DNS」默认使用 Cloudflare（`1.1.1.1`）和 Google（`8.8.8.8`）的 DNS over HTTPS。Chromium 配置两个解析服务。Camoufox 每次只能使用一个服务，启动时优先检查 Cloudflare，连不上时尝试 Google。使用中如果当前服务断开，重开环境会重新检查。两种内核也可手动选择单个服务或「使用系统 DNS」。保存后，重新打开已有或新建环境即可生效。

HTTP、HTTPS 和 SOCKS5 代理环境继续由代理解析网站域名。检测站的 DNS 栏可能显示递归解析服务对检测站可见的出口地址。系统网卡的 DNS 由操作系统管理。

## 数据和更新

全新启动时环境列表为空。更新后列表里的「已关闭」表示本机保存的环境，代表可重新打开的配置。要清理指定环境，在「浏览器管理」勾选对应项并点击「删除选中」。此操作也会删除所选环境的 Cookie 和网站登录数据。

删除环境时，如果文件被占用，环境卡片会显示「待清理」。关闭占用文件的进程后可以重试删除。待清理的环境无法再次打开。

- 默认数据目录：`%LOCALAPPDATA%\CIKE`。设置中的“打开数据目录”可以直接打开。
- 自定义数据目录：在启动前设置 `LFB_DATA`。桌面版与独立 Node API 应使用不同数据目录。
- 浏览器下载保存到 Windows 当前用户的系统“下载”目录。
- 桌面版代理密码通过 Electron safeStorage 使用当前 Windows 用户的 DPAPI 加密。不能假设将数据目录复制给其他用户或其他电脑后仍可解密。
- Windows 文件访问使用当前用户目录的 Windows ACL；POSIX 的 `0600/0700` 权限声明仅适用于 Unix 系统。
- 更新时先退出 CIKE 和所有环境，将新版完整解压到新目录再启动。环境数据留在用户目录，更新前建议备份。
- Windows 版使用手动更新，不会下载上游 macOS DMG。
- Windows 环境使用原始 Chromium 内核，不提供 macOS Dock 的每环境独立编号图标。

## 自行构建

安装 Node.js 22.12 或更新的 LTS 版本，在仓库目录执行：

```powershell
npm ci
npm run test:unit
npm run pack:win-x64
```

也可以双击根目录的 `build-windows.cmd`。输出：

```text
dist/CIKE-win32-x64/CIKE.exe
dist/CIKE-0.12.0-windows-x64.zip
dist/SHA256SUMS.txt
```

打包脚本同样可以在 macOS/Linux 上交叉生成 Windows x64 压缩包，使用 Electron 官方预编译运行时并校验其下载内容。

## GitHub Actions

fork 后在 GitHub 的 Actions 页面启用工作流。`main`、`windows` 和 `windows-*` 分支的代码提交会触发 **Build Windows x64**。完成后在该次运行的 Artifacts 中下载 `CIKE-windows-x64`，解压后得到应用压缩包及校验文件。

工作流在 Windows runner 上检查 API/凭据存储、代理与浏览器回归、硬件模拟及 Worker 一致性、最大化和全屏继承、CIKE 内核下载与版本检测、真实内核迁移和删除后的登录数据保留，以及源码和打包后桌面应用的设置操作。所有步骤通过后才上传应用。

Windows 正式发布自 `v0.11.0` 起，每次发布将中间一段加一，末段固定为 `0`，依次使用 `v0.12.0`、`v0.13.0`、`v0.14.0`。标签等于应用版本加上 `v` 前缀。`package.json`、`package-lock.json` 和 Windows ZIP 文件名使用相同的三段版本号，例如 `0.12.0`。

**Publish Windows Release** 复用已通过的 Windows 构建。手动运行时填写构建运行 ID 和对应标签。工作流检查标签是否与应用版本相符，并根据已正式发布的 Windows 版本校验下一个标签。随后确认构建源码一致，校验压缩包，再上传文件并发布。已有标签和下载链接可继续使用。

## 验证范围与实机验收

GitHub Actions 的 Windows runner 用于构建和回归测试。实机验收分别在 Windows 10 和 Windows 11 的 x64 电脑上执行，使用同一提交的 Windows ZIP。记录系统版本和显卡驱动，能拿到不同显卡的电脑时分别记录。

### 执行自动验收

在当前 Windows 用户的桌面会话中完整解压 ZIP。退出其他 CIKE 实例，进入对应提交的源码目录，运行 `npm ci`。用 CIKE 设置页下载安装本版本的两个内核，退出应用后，将下列路径替换为解压后的 `CIKE.exe` 和已安装的两个内核可执行文件。

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\test-windows-device.ps1 `
  -AppPath 'C:\CIKE 测试\CIKE.exe' `
  -ChromiumPath 'C:\CIKE 内核\chromium\chrome.exe' `
  -CamoufoxPath 'C:\CIKE 内核\camoufox\camoufox.exe'
```

脚本使用临时环境复用仓库里的网络、桌面、窗口与内核测试。它检查 HTTP/SOCKS5 认证及代理中断后禁止直连、Unicode 路径、GPU 兼容绘制、关闭及崩溃恢复、Canvas 隔离和打包应用启动。脚本遇到失败或跳过测试会返回非零，默认在 `%TEMP%\cike-windows-device.json` 写入系统版本、显卡驱动和测试统计。

### 完成人工验收

每台机器使用专用测试数据目录和测试账号。可在 PowerShell 中将 `$env:LFB_DATA` 指向新的临时目录，再从同一窗口启动 CIKE。升级场景用上一版和候选版各自解压后的程序先后打开同一个测试目录。

| 检查项 | 操作及通过条件 |
| --- | --- |
| 首次运行与下载 | 从含空格及中文的路径启动。安装 Chromium 和 Camoufox，退出重开后设置页仍显示已安装。分别下载同名测试文件两次，两个文件均保留。 |
| HTTP 与 SOCKS5 | 各用一条有认证的测试代理。正确凭据可打开环境。错误凭据显示认证失败，关闭本机测试代理后显示连接失败。卡片上的「编辑代理」和「重试打开」能完成恢复。 |
| 出口检测与地区信息 | 在测试代理上仅阻止两个 ipify 检测域名时，应看到出口检测失败，环境不得启动。恢复出口探测并仅阻止 `ipwho.is` 后，自动设置环境应提示出口已验证但缺少地区或时区。点击「设置语言和时区」，指定具体值并保存后应能打开。 |
| 代理断线 | 先打开环境，再停止测试代理。在新标签页打开此前未访问过的自有测试地址，请求应失败，测试服务不得收到来自本机直连的请求。分别验证 Chromium 和 Camoufox。 |
| 升级保留会话 | 在上一版里新建两个环境，用两个测试账号登录同一测试站点。完全退出后从新目录启动候选版，两边都应保留各自账号的 Cookie 和站点数据。 |
| 显卡与恢复 | 启动 Camoufox，打开多个标签和窗口，验证自动与兼容绘制两种设置。仅在测试环境中终止已确认属于该环境的浏览器进程，重开后检查登录状态仍在，并确认完全退出 CIKE 后没有残留测试进程。 |
| Canvas 站点保护 | 同一 Camoufox 测试环境分别在关闭和开启保护时重开，使用有权限的应用做一次图片编辑与 PNG 导出。记录文件能否下载、能否重开和编辑结果是否正确。 |

每台机器保留一份自动验收 JSON 和人工结果。人工结果逐项记录「通过」「失败」或「未执行」及简短说明，标明上一版／候选版、使用的内核和配置。如果失败，附上脱敏截图或崩溃诊断。
