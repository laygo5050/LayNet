# LayNet 连接可靠性与前端状态修复方案

给负责实施的 AI：请在 LayNet 仓库完成以下五项修复，并提交可重复的回归验证。先读根目录 [AGENTS.md](AGENTS.md)。建议先完成第 1～3 项，它们共用内核和系统代理生命周期；第 4 项会迁移用户数据，第 5 项应以迁移后的状态结构为基础。

遵循现有分工。TypeScript 负责节点协议、配置生成和 Clash API 操作，Rust 负责进程、文件、Win32 系统代理和托盘。沿用当前交互：窗口右上角 × 收到托盘，代理继续工作；托盘“退出”结束应用并清理。沿用 Mixed 端口 7890、Clash API 端口 9090 和现有 sing-box 兼容性要求。

## 1. P1　取得单实例资格后再清理残留

**入口**　[src-tauri/src/lib.rs](src-tauri/src/lib.rs) 的 `run`、[src-tauri/src/core_manager.rs](src-tauri/src/core_manager.rs) 的 `kill_orphan_cores` 和 `stop`。

当前启动流程先关系统代理、按镜像名终止内核，再初始化单实例插件。将冷启动清理移到已成为主实例、尚未恢复连接的阶段。普通启停优先操作本实例持有的子进程；孤儿回收应验证进程确属 LayNet 的残留。保留 UAC 重启时等待旧实例退出的交接顺序。

**验收**　分别在窗口可见和窗口已收到托盘时，记录内核 PID，建立一条经过 7890 的持续连接，再次打开 LayNet。原 PID、连接和系统代理均应保持，已有窗口被唤醒或重建。另测真正冷启动，预置的 LayNet 残留应在恢复连接前清理。测试 UAC 取消时原会话继续工作，同意时只有新实例接管。

## 2. P1　内核异常退出时由 Rust 恢复网络

**入口**　[core_manager.rs](src-tauri/src/core_manager.rs) 的 `CommandEvent::Terminated`、[tray.rs](src-tauri/src/tray.rs) 的 `RuntimeSnapshot` / `handle_tray_action`、[useAppStore.ts](src/store/useAppStore.ts) 的 `core-exited` 监听。

Rust 确认退出的是当前这一轮内核后，清除对应进程句柄，释放 LayNet 仍接管的系统代理和环境变量，刷新 WinINet、托盘及运行状态，再通知前端。前端据此更新显示与遥测。将退出归属判断和状态更新放在同一套同步机制中，避免旧进程的迟到事件覆盖新会话。区分主动停机、重载换进程和意外退出。保留用户下次连接的代理偏好。

**验收**　关窗收到托盘，按已记录的 PID 结束测试内核。此时无需打开窗口，托盘就应显示断开，WinINet 和新启动的终端应解除 LayNet 代理。再打开界面，状态应一致。另测系统代理原本关闭、用户已切换到其他代理，以及旧内核的退出事件晚于新内核就绪三种情况，核对当前代理设置和托盘状态。正常从托盘退出后，测试内核与 LayNet 接管的代理均应清理。

## 3. P1　重载先预检，切换失败可回滚

**入口**　[core_manager.rs](src-tauri/src/core_manager.rs) 的 `start` / `read_saved_config`、[useAppStore.ts](src/store/useAppStore.ts) 的 `reloadCoreConfig` 及其调用方、[tray.rs](src-tauri/src/tray.rs) 的无窗口重连分支。

1. 将候选配置写入独立临时文件，使用随包内核执行 `check`。预检期间保持旧内核、遥测和已生效的 `running-config.json` 可用。
2. 预检通过后再切换进程。确认新进程仍然存活、接口就绪后，才提交新配置、同步系统代理与托盘，并向调用方报告成功。前台连接与无窗口托盘重连使用一致的就绪条件。
3. 切换失败时清理候选进程，尝试用最后一份已生效配置恢复。回滚成功应恢复遥测、代理和已生效的模式；回滚也失败则转为断开，释放 LayNet 代理。保留候选错误，向用户说明当前实际运行状态。检查规则应用、TUN 切换、订阅刷新和节点编辑调用方，避免失败后仍提示“已生效”。
4. 协调并发重载、断开与退出。某次重载在用户主动断开后完成时，应尊重最新操作，避免迟到的完成回调重新开启代理。

| 故障或操作 | 通过条件 |
| --- | --- |
| 候选配置未通过预检 | 原 PID、已生效配置内容和系统代理保持；原测试连接继续传输；界面报告新配置失败。 |
| 预检通过，候选进程启动失败或一直未就绪 | 恢复旧配置，允许 PID 改变；用受控 HTTP 目标确认 7890 恢复转发，9090 可读，界面和托盘反映旧配置。 |
| 候选和回滚均失败，或首次连接失败且无旧配置 | 无受管内核继续运行，系统代理解除，界面与托盘显示断开，错误中能区分失败阶段。 |
| 连续提交两个修改，或在重载期间断开 | 最终配置、进程、系统代理与最后一次有效操作一致。托盘从无窗口状态重连时，只在本次内核就绪后显示已连接。 |

## 4. P2　同名节点刷新后保留用户的选择

**入口**　[uriParser.ts](src/lib/uriParser.ts) 的 `ensureUniqueTags`、[configBuilder.ts](src/lib/configBuilder.ts) 的 selector 构建、[useAppStore.ts](src/store/useAppStore.ts) 的选择、刷新和持久化逻辑，以及 [NodesView.tsx](src/components/NodesView.tsx)。

用稳定节点 ID 保存选择，为 sing-box 和 Clash 使用唯一且稳定的 outbound tag。显示名和重名后缀可独立变化。刷新时在同一订阅内匹配原节点并复用 ID，匹配依据应覆盖服务器、端口、协议及区分连接所需的认证和传输参数。界面、托盘、测速和自动优选显示要能从内部 tag 找回节点名称。所选节点确实消失时回退到 `auto`。

**旧数据迁移**　从 `laynet-storage-v1` 读取原始节点与旧 `selectedOutbound`，在任何标签重排前，用原 tag 找到旧节点并保留其 ID。保留内置选择和已有设置；旧标签缺失或含义不唯一时回退到 `auto`。重复加载迁移后的数据应得到同一选择。

**验收**　在订阅 A、B 中分别导入 `trojan://demo@a.example:443#HK` 和 `trojan://demo@b.example:443#HK`。选择 A，依次刷新 A、反转排序、修改显示名、重启。每一步都断言当前选中 ID、发给 Clash 的 tag、生成配置中该 tag 的服务器仍对应 A。删除 A 后应进入 `auto`。用含旧 tag `HK #2` 的持久化样本再跑一次，验证升级后仍指向原节点。

## 5. P2　遥测更新不触发配置持久化

**入口**　[useAppStore.ts](src/store/useAppStore.ts) 的 `startTelemetry`、`core-stdio`、`persist` 和 `partialize`。当前流量、连接快照和日志共用持久化 store，运行态更新也会序列化节点与订阅。

把流量、连接和日志放入内存状态，或只在持久化字段实际变化时进入序列化流程。保留界面订阅、历史长度、日志上限和窗口重建后的遥测恢复。仅在序列化后比较字符串，仍会产生大节点列表的序列化成本。

**验收**　用可计数的内存存储和假遥测源，待初始化完成后清零计数。分别经真实回调发送 10 次流量更新、一批连接快照和一批日志，断言界面数据更新、配置序列化及 `setItem` 增量均为 0。随后修改主题和节点，确认发生持久化；重建 store 后，主题、节点、订阅和所选 ID 均恢复。

## 验证与交付

- **自动回归**　为上面的失败分支、旧事件晚到、同名节点迁移及存储写入次数补可重复的测试。内核启动失败和回滚失败优先用可控的测试替身触发。报告里给出实际新增的测试命令。
- **仓库自检**　在根目录执行 `pnpm tsc --noEmit` 和 `pnpm build`，在 `src-tauri` 执行 `cargo check`。用项目实际的 TypeScript 配置生成器和无真实凭证的测试节点，分别生成 TUN 关闭、开启两份样例；对每份运行 `src-tauri/binaries/laynet-core-x86_64-pc-windows-msvc.exe check -c <样例路径>`，记录退出码。核对 `src-tauri/capabilities/default.json` 能覆盖修改后的调用。
- **Windows 实机验收**　在可恢复的 Windows 测试环境覆盖冷启动、二次打开、× 收到托盘、后台内核退出、托盘重连、托盘退出、UAC 和 `--silent` 恢复。使用受控测试节点和目标；故障注入仅针对已核对的测试进程 PID。记录测试前后内核 PID、代理状态、托盘/UI 状态及实际请求结果。
- **交付记录**　按五项列出修改位置、回归用例、命令和结果。区分自动测试、Windows 实测及尚待验证的场景；输出样例或日志时使用测试凭证。
