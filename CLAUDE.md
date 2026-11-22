# LayNet 项目架构与功能规范

## 1. 全局命名矩阵与技术栈环境
- **产品显示名 (`productName`)**: `LayNet`
- **包名 (`package name`)**: `laynet`
- **全局唯一标识 (`identifier`)**: `com.lay00.net`
- **Sidecar 内核名**: `laynet-core`（对应 `src-tauri/binaries/laynet-core-x86_64-pc-windows-msvc.exe`，与系统其他 `sing-box.exe` 进程彻底隔离）
- **TUN 驱动动态库**: `wintun.dll`（存放于 `src-tauri/binaries/wintun.dll`，通过 `bundle.resources` 及运行时同目录部署确保 `laynet-core` 直接加载）
- **Windows 提权服务名**: `LayNetService`
- **TUN 虚拟网卡名 (`interface_name`)**: `LayTun`
- **基础栈**: Tauri v2 + Rust 1.98 + Vite 8 + React 19 + TypeScript 6 + Tailwind CSS v4 + `lucide-react` + `zustand`

---

## 2. 前后端职责红线（重 TypeScript 业务 90% + 极薄 Rust 系统壳 10%）

### 前端（`src/`）
- 负责所有单节点分享链接（`vless://`, `hy2://`, `hysteria2://`, `ss://`, `trojan://`）与 Base64/远程订阅的解析。
- 负责在内存中合成符合 **`sing-box v1.14+`** 规范的 `running-config.json`。
- 直接通过 `fetch` 与 `WebSocket` 连接内核 Clash API（`http://127.0.0.1:9090` / `ws://127.0.0.1:9090`），实现：
  - HTTP 204 真连接延迟测速（`GET /proxies/{name}/delay?url=https://www.gstatic.com/generate_204&timeout=5000`）
  - 毫秒级切换出站节点（`PUT /proxies/{selector}`）
  - 三档分流模式无感热切换（`PATCH /configs` 修改 `mode`）
  - 实时上下行网速（`/traffic`）、活跃连接分流透视表（`/connections`）、内核实时日志流（`/logs`）

### Rust 层（`src-tauri/`）
- **严禁在 Rust 层编写任何节点解析逻辑！**
- 仅负责：
  1. `running-config.json` 配置落盘与运行时目录准备（确保 `laynet-core` 启动同目录存在 `wintun.dll`）。
  2. 通过 `tauri-plugin-shell` Sidecar 或受控进程（`CREATE_NO_WINDOW` 无黑框）启停 `laynet-core`。
  3. 使用 Win32 API / 注册表开关 Windows 系统代理（默认 `127.0.0.1:7890`）并调用 `InternetSetOptionW` 立即生效。
  4. 单实例锁（`tauri-plugin-single-instance`，唤醒已有窗口）。
  5. 开机自启（`tauri-plugin-autostart`，传入 `--silent` 参数静默缩进托盘并恢复上次连接状态）。
  6. 系统托盘（Tray）三态图标切换与右键快捷菜单同步。
  7. Windows 管理员权限检测、UAC 提权拉起与 `LayNetService` 服务辅助能力。

---

## 3. 四大显性功能模块与极简三页 UI
- **窗口形态**: 默认锁定 `820 × 540` 紧凑现代桌面风，支持深浅色自适应，左侧窄图标导航栏 + 右侧三视图（`控制台 Dashboard`、`节点库 Nodes`、`设置与透视 Settings`）。

1. **流量接管三件套**
   - `系统代理` 开关：接管 `127.0.0.1:7890`。
   - `TUN 模式` 开关：动态注入 `LayTun` 入站接管全局三层流量；无管理员权限时引导 UAC 提权重启或服务运行。
   - `一键复制终端代理命令` 按钮：一键写入 PowerShell / CMD 的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 环境变量命令至剪贴板并弹 Toast。

2. **三档分流控制 + 极简自定义黑白名单**
   - `规则 (Rule，默认)` / `全局 (Global)` / `直连 (Direct)` 三档滑块，连接状态下调 Clash API `PATCH /configs` 热切换，不重启内核。
   - 「强制代理」与「强制直连」两个多行纯文本输入框：自动识别按行填入的域名后缀（转 `domain_suffix`）或 `.exe` 进程名（转 `process_name`），置顶注入 `route.rules`。

3. **剪贴板智能节点解析 + HTTP 204 真测速**
   - 支持剪贴板一键批量导入单节点链接或 Base64 订阅，支持远程订阅 URL 保存及启动静默刷新。
   - 完整解析：
     - `vless://`（含 Reality `pbk`/`sid`/`sni`/`fp`/`xtls-rprx-vision` 及 `ws`/`grpc` 传输）
     - `hy2://` / `hysteria2://`（含 `sni`、`obfs`、`insecure=1` 及端口跳跃 `mport` 转换为 `sing-box` `"server_ports": ["起始:结束"]` 冒号格式）
     - `ss://`（SIP002 / Legacy Base64）
     - `trojan://`（TLS / WS / gRPC）
   - 严禁用 ICMP Ping，统一走 Clash API HTTP 204 测速，默认置顶 `auto` (`urltest`) 自动择优组。

4. **桌面生存套件**
   - 点击窗口右上角 `×` 隐藏至系统托盘（不退出进程）。
   - 托盘图标区分「未连接 / 系统代理 / TUN 开启」三种状态；右键菜单支持开关连接、切系统代理/TUN、切分流模式、复制终端命令与彻底退出。
   - 支持 `--silent` 参数开机静默驻留托盘并恢复上次连接状态。
   - 设置页下半区内置实时连接分流表（`ws://127.0.0.1:9090/connections`）与内核日志面板（`/logs`），直观展示「进程/域名 → 命中规则 → 直连或节点」。

---

## 4. 底层硬编码三项“隐形保护”（无需 UI 开关）

1. **退出/崩溃/冷启动防断网守卫**
   - 在正常退出、Rust `PanicHook`、窗口退出事件中，强制重置 Windows 注册表系统代理（调用 `InternetSetOptionW` 立即刷新）并清理 `laynet-core` 子进程。
   - 每次 `LayNet` 冷启动尚未连接时，主动执行一次残留系统代理复位与孤儿 `laynet-core` 进程清理，杜绝异常断电或强杀后浏览器断网。

2. **双路防污染 DNS 固化内置（严格遵循 `sing-box v1.14+` 规范）**
   - 严禁使用已废弃的旧版字符串 `address` 或 `geoip`/`geosite` 字段！必须使用新版带 `type` 的 `dns.servers`：
     - `dns-direct`: `{"type": "udp", "tag": "dns-direct", "server": "223.5.5.5"}`，用于解析 `geosite-cn` 规则集及 `route.default_domain_resolver: "dns-direct"`。
     - `dns-remote`: `{"type": "https", "tag": "dns-remote", "server": "1.1.1.1", "detour": "proxy"}`，作为默认兜底 `final` DNS 走代理防污染。
   - 路由规则使用新版 `{"action": "sniff"}`、`{"protocol": "dns", "action": "hijack-dns"}` 以及远程 `.srs` 二进制规则集（`geosite-cn.srs` / `geoip-cn.srs`，`download_detour: "proxy"`，开启 `experimental.cache_file` 本地缓存）。

3. **局域网与本地虚拟网卡自动绕过**
   - 系统代理 `ProxyOverride` 完整排除：`localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>`。
   - 顶层 `route` 强制开启 `"auto_detect_interface": true` 自动绑定真实物理网卡（避开 VMware `VMnet`、WSL2、Hyper-V 虚拟网卡冲突）。
   - TUN 模式固定 `"stack": "system"`、`route_exclude_address` 排除私有网段，并在路由内置 `{"ip_is_private": true, "outbound": "direct"}`。
