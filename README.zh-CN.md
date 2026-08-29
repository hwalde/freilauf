# cc-hub

[English](README.md) · **中文** · [Deutsch](README.de.md)

**一个替你运行编码智能体的 Web 界面 —— 可定时、无人值守、并从外部持续观测。**
Claude Code、opencode、hermes 和 cursor-agent 各自在独立的 git worktree 与独立的
tmux 会话中工作；cc-hub 负责启动它们、观察它们、收集它们的报告、合并它们的成果，
并在需要你介入时通过 Telegram 通知你。

> ### 🤖 要安装？交给你的智能体。
> 你已经在用编码智能体了。把它指向
> **[SETUP_WITH_AGENT.md](SETUP_WITH_AGENT.md)** —— 这是一份**写给智能体**的指南，
> 它会讲清楚系统结构、向你询问那几个它无法猜测的值，然后完成安装。
> 一句话即可：*"读一下 SETUP_WITH_AGENT.md，帮我把它装起来。"*
> （该文档为英文，与项目语言保持一致。）

```
浏览器 --https--> <wg-IP>:8790 --http--> 127.0.0.1:8791 --> tmux 会话
(经 WireGuard)    vpn-proxy.mjs           server/hub.mjs      cc-<name>-<id>
                  cchub-vpn.service       cchub.service       cc-oc-/he-/cu-…
                  └──── 两者都从 deploy 检出目录运行 ────┘
                        (~/agents/deploy/cc-hub，见下文)
```

## 你为什么可能需要它

当你坐在电脑前时，你的编码智能体表现很好。cc-hub 是为你**不在**的时候准备的：

- **交代任务，然后走开。** 每次运行都有自己的 worktree 和 tmux 会话，因此互不干扰；
  事后你可以随时接入任意一个会话，读到完整的屏幕内容。
- **定时执行。**"每晚两点，看一遍待处理的 issue。"所谓**智能体（agent）**，就是一份
  已保存的运行定义，加上一个名字和一个时间表；**单次运行（single run）**则是同一张
  表单去掉这两项。
- **即使智能体自己说不出话，你也知道出了什么事。** 撞上速率限制的智能体无法上报，
  所以 hub 从外部观测：tmux 状态、日志、transcript、hook、供应商脉冲探测。
- **"运行完成"意味着成果已经在 `main` 上。** hub 可以自己完成合并，在相信智能体的
  "我做完了"之前先行核查，并把仍然活着的智能体退回去补齐缺失的部分。
- **四个 CLI，一个入口。** hub 可以驱动哪些编码智能体、每个智能体可以使用哪些模型
  供应商，都是配置项，而不是代码改动。

## 功能一览

- **编码智能体即插件** —— claude、opencode、hermes、cursor。在界面中配置
  （设置 → Coding agents），添加对话框会自动探测已安装的 CLI。新增编码智能体或
  供应商只需要一个文件（[docs/plugins.md](docs/plugins.md)）。
- **智能体与单次运行共用一张表单**：编码智能体、模型、推理强度、提示词、仓库、
  分支规则、时间表。每个页面顶部的 **Quick Run** 按钮可以用保存好的收藏项，
  只填两个字段就启动一次运行。
- **浏览器中的终端**（xterm.js over WebSocket，默认只读）—— 观看运行、向其中输入、
  回答求助。
- **报告** 通过 `cc-report` 上报（done / failed / help / progress / branch / pr）；
  hub 不可达时回落到 `inbox.jsonl`。
- **集成**：hub 自己把完成的运行合并进基础分支，按仓库串行，在专属的 worktree 中
  进行 —— 工作区不干净、发生冲突或合并检查失败时，先退回给智能体处理，实在不行
  才升级给你。
- **事件（Incidents）**：速率限制与供应商故障由多条互相独立的通道识别，只上报一次，
  而不是五次。
- **订阅用量** —— Claude 的 5 小时 / 7 天窗口、Cursor 当前周期的花费、OpenRouter
  与 DeepSeek 余额 —— 显示在每个页面的侧边栏中；预算闸门（budget gate）会在额度
  即将耗尽前推迟启动，并且只推迟该窗口真正约束的运行：Claude 的通用周窗口约束所有
  Claude 运行，按模型划分的周窗口只约束使用该模型的运行，DeepSeek 运行只受其自身
  余额约束。每个闸门都是**可选的**，各有自己的阈值（设置 → 预算闸门），被推迟的
  运行也可以从其详情页**强制启动**。同一个侧边栏还会显示本机所有 tmux 会话共占用多少内存，每八分钟
  重新测量一次：会话是有意在其智能体之后继续存活的，这笔账会悄悄累积。
- **无代码流程（No-code flows）**：用图形化设计器编排运行结束之后的事 —— 给运行中的
  智能体发消息、启动后续运行并等待结果、用 LLM 从报告中抽取结构化数据、分支、
  循环、Telegram、HTTP、Shell 命令
  （[server/flows/AGENTS.md](server/flows/AGENTS.md)）。
- **Telegram** 通知，附带直达该次运行的链接。
- **多语言界面**：English（默认）、中文、Deutsch —— 设置 → UI language。

## 安全模型 —— 这一节请务必读完

hub 能操作 tmux，**这等同于 shell 访问权限**。因此：

- `server/hub.mjs` **只绑定 `127.0.0.1`**，从网络没有直达它的路径。
- 前面是 `vpn-proxy.mjs`（TLS），它**只绑定本机自己的 WireGuard 地址**。
  `CCHUB_VPN_BIND` 是必填项 —— 刻意没有默认值。
  **WireGuard 就是认证层；cc-hub 本身没有登录功能。**
- 主机白名单 + Origin 校验（`CCHUB_ALLOWED_HOSTS`）用来抵御 DNS rebinding 与 CSRF；
  `Sec-Fetch-Site: cross-site` 会被拒绝。
- **失败即关闭（fail-closed）**：`cchub-vpn.service` 刻意不随开机自启
  （用 `cchub on` 开启访问）；`setup/04-firewall.sh` 只在 `wg0` 上放行 VPN 端口，
  其他接口一律拒绝。

**绝不要在缺少这些防护层的可达网络中运行 hub。**

## 安装

前置条件：带 systemd（用户单元）的 Linux、Node.js ≥ 22（`node:sqlite`）、tmux、
git、jq、curl、一个 WireGuard 接口，以及 `PATH` 中至少一个智能体 CLI
（`claude`、`opencode`、`hermes`、`cursor-agent`）。证书可以用
[mkcert](https://github.com/FiloSottile/mkcert) 生成。

```bash
./setup/01-npm-install.sh       # node-pty、ws、xterm.js —— 供“本”检出目录使用（测试、开发）
./setup/02-install-scripts.sh   # cc-start/-attach/-kill/-help/-report + cchub + cchub-deploy → ~/.local/bin
./setup/03-install-services.sh  # ~/.config/cc-hub/env（源自 env.example）+ systemd 单元
sudo ./setup/04-firewall.sh     # ufw：VPN 端口仅在 wg0 上放行（一次性）
```

随后在 `~/.config/cc-hub/env` 中至少设置 `CCHUB_VPN_BIND` 和 `CCHUB_ALLOWED_HOSTS`
（参见 [`env.example`](env.example)），放好证书，然后让第一个版本上线：

```bash
cchub-deploy --init --from "$PWD"   # 克隆到 ~/agents/deploy/cc-hub 并部署
cchub status                        # hub 进程、VPN 访问、流水线、会话、已部署的 sha
cchub on                            # 启动 VPN 代理 → 经 WireGuard 可访问
```

**进入界面后的第一件事**：在 **设置 → Coding agents** 中添加你的编码智能体 ——
全新安装时每个页面都会有横幅提示。可选的种子文件
`~/.config/cc-hub/coding-agents.json` 会在首次启动时预填这些配置，这正是脚本化
安装可复现的关键。

> 请**从 VPN 客户端**验证可达性，不要在服务器上用 `curl` 自测：那条请求走的是
> `lo`，对你的防火墙什么也证明不了。

### 让一个版本上线

systemd 单元启动的是 `~/agents/deploy/cc-hub` —— 一个只属于 hub 的克隆，永远以
detached 状态停在某一个提交上。你工作用的检出目录从不运行服务，因此未提交的改动
绝不可能被对外提供。

```bash
cchub deploy            # fetch、检出 origin/main、依赖（仅当 lockfile 变化时）、
                        # 重装 cc-* 脚本、重启、健康检查 —— 失败则回滚
cchub deploy <ref>      # 改为部署该提交
cchub-deploy --status   # 已部署 sha、origin sha、落后多少
cchub-deploy --rollback # 回到上一个已部署的提交
```

部署失败会回滚到原先运行的提交，并通过 Telegram 告知你。正在运行的 sha 会打印在
每个页面的侧边栏中，所以"我的改动上线了吗"只需扫一眼。`cchub restart` 就是字面
意思 —— 只重启，不部署。

## 测试

```bash
node test/unit.mjs          # 纯逻辑（cron、时间表、配额闸门、解析器、注册表、i18n、文档）—— 约 1 秒
node test/e2e.mjs           # 沙箱中的完整 hub，用桩程序代替真实智能体 —— 约 40 秒
node test/e2e.mjs --echt    # 额外为每个 harness 跑一次真实运行（消耗配额）
node test/browser.mjs       # 在真实 Chromium 中跑 public/hub.js —— 约 10 秒（需要 playwright）
node test/proxy.mjs         # vpn-proxy.mjs 对接桩上游 —— <1 秒
node test/deploy.mjs        # bin/cchub-deploy 对接裸 origin —— 约 3 秒
```

e2e 套件会在一个空闲端口上启动第二个 hub，带有自己的数据库、测试仓库和 `cc-start`
桩程序 —— 既不碰生产数据，也不碰别人的 tmux 会话，因此可以与运行中的 hub 并存。

## 把它改成你自己的

cc-hub 是一位运维者的工作流写成的代码，之所以公开，是因为它也许能帮你省下一个月。
**尽管 fork、修改、拆掉不需要的部分。** 有意为你留出的接缝：harness 与 provider
插件、平台提示词后缀、按仓库的提示词、`~/agents/zusaetze/` 中可选启用的额外技能，
以及无代码流程。完整表格见
[SETUP_WITH_AGENT.md](SETUP_WITH_AGENT.md)。

## 参与贡献

**非常欢迎 Pull Request** —— 缺陷报告、更多编码智能体或供应商的插件文件、翻译、
文档修正，一律欢迎。基本规则与提交前检查清单见
[CONTRIBUTING.md](CONTRIBUTING.md)。

开发者知识 —— 架构决策、各个 harness 的怪癖，以及一长串"已经让人浪费过一个下午"
的陷阱 —— 都在 [AGENTS.md](AGENTS.md) 里，那份文档同时写给人**和**编码智能体。

## 许可证

[CC BY 4.0](LICENSE) —— 可以使用、修改、商用。只需署名：注明
**Herbert Walde**、回链 <https://github.com/hwalde/cc-hub>、附上许可证链接，
并说明你是否做了改动。
