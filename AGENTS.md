# AGENTS.md — LayNet Engineering Constraints & Verification Checklist

> 本文档与根目录 `CLAUDE.md` 同步维护，供所有自动化 Agent 开发与校验遵循。

## 核心身份与命名约束
- **Product Name**: `LayNet`
- **Package Name**: `laynet`
- **App Identifier**: `com.lay00.net`
- **Sidecar Binary**: `laynet-core` (`src-tauri/binaries/laynet-core-x86_64-pc-windows-msvc.exe`)
- **Wintun Library**: `src-tauri/binaries/wintun.dll`
- **Windows Elevation Service**: `LayNetService`
- **TUN Interface**: `LayTun`
- **Local Ports**: Mixed Inbound `127.0.0.1:7890`, Clash API `127.0.0.1:9090`

## 架构红线
1. **90% 前端 TypeScript + 10% Rust 系统壳**：
   - 所有节点协议解析（`vless://`, `hy2://`, `hysteria2://`, `ss://`, `trojan://`、Base64 订阅、远程订阅）、`sing-box v1.14+` 配置生成、Clash API (`fetch` + `WebSocket`) 测速/切节点/分流热更新/流量连接日志监控均在 `src/` TypeScript 完成。
   - `src-tauri/` 严禁包含任何节点协议解析代码，仅负责：配置落盘、`wintun.dll` 同目录保障、无黑框（`CREATE_NO_WINDOW`）启停 `laynet-core`、Win32 系统代理设置与 `InternetSetOptionW` 刷新、单实例锁、开机自启（`--silent`）、三态托盘图标与右键菜单、管理员权限检测与 UAC/`LayNetService` 提权、防断网守卫。

2. **`sing-box v1.14+` 严格兼容规范**：
   - 严禁使用旧版 `dns.servers[].address`、`outbounds` 特殊 `dns`/`block` 类型或废弃 `geosite`/`geoip` 字段。
   - 必须使用 `dns.servers` 新版结构（`{"type": "udp", "tag": "dns-direct", "server": "223.5.5.5"}` 与 `{"type": "https", "tag": "dns-remote", "server": "1.1.1.1", "detour": "proxy"}`）。
   - 必须配置 `route.default_domain_resolver: "dns-direct"` 与 `route.auto_detect_interface: true`。
   - 必须使用路由动作 `{"action": "sniff"}`、`{"protocol": "dns", "action": "hijack-dns"}`、远程 `rule_set` (`geosite-cn.srs`, `geoip-cn.srs`, `download_detour: "proxy"`) 与 `experimental.cache_file`。
   - Hysteria2 端口跳跃 `mport` 参数必须转换为 `"server_ports": ["start:end"]` 冒号分隔数组格式。

3. **三大隐形保护必检项**：
   - 冷启动未连接前自动清理残留系统代理 + 孤儿 `laynet-core` 进程；正常退出、窗口退出与 `std::panic::set_hook` 均强制复位注册表代理并调 `InternetSetOptionW` + 终止 `laynet-core`。
   - 双路防污染 DNS 固化内置。
   - `ProxyOverride` 排除全量私有网段 + `route.auto_detect_interface: true` + TUN `stack: "system"` & `route_exclude_address` & `ip_is_private: true -> direct`。

## 交付前自检命令
1. `src-tauri/binaries/laynet-core-x86_64-pc-windows-msvc.exe check -c <sample-config.json>` 返回零错误。
2. `pnpm tsc --noEmit` 与 `pnpm build` 零报错通过。
3. `cargo check`（在 `src-tauri` 目录）零编译错误，且 `capabilities/default.json` 权限完整。
