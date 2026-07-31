# 第一章：系统边界与运行时

## 1. 先问“谁拥有控制流”

理解 Triple-pi 的第一原则不是“有哪些工具”，而是谁拥有主循环。

**Pi 上游拥有控制流，Triple-pi 通过扩展点参与控制流。**

```text
用户输入
  │
  ▼
Pi CLI/TUI
  │
  ▼
Pi Agent Loop ── 模型请求/流式输出/工具调用/重试/queued continuation
  │
  ├── lifecycle event ───────────────┐
  ├── tool execution ────────────────┤ Extension API
  └── session tree mutation ─────────┘
                                      │
                                      ▼
                              Triple-pi Extension
```

因此，Triple-pi 不是另一个 Agent Loop，也不是绕过 Pi 的模型客户端。它是运行于 Pi Extension API 上的领域系统。

## 2. 启动与加载链

### 2.1 启动器

[现状] Unix 启动链从 `bin/trip` 开始：

```text
trip
  ├─ realpath(${BASH_SOURCE[0]})
  ├─ 计算 REPO_ROOT
  └─ exec <repo>/pi-runtime/pi-test.sh "$@"
```

`realpath` 的意义不是美化脚本，而是修复全局 symlink 启动时的仓库定位：

```text
~/.local/bin/trip -> /repo/bin/trip

错误：dirname("~/.local/bin/trip") 认为 repo 在 ~/.local
正确：realpath 后得到 /repo/bin/trip，再上溯 /repo
```

Windows 由 `bin/trip.bat` 与 `bin/trip.ps1` 承担同类职责。[校正点] 若后续 Pi 改为正式构建产物而非 `pi-test.sh`，这里只校正命令，不改变边界：启动器选择并 `exec` Pi runtime。

### 2.2 安装器

`scripts/install-extension.mjs` 把 `extensions/` 作为统一目录 symlink 到 Pi agent 目录：

```text
<repo>/extensions
       │ symlink
       ▼
~/.pi/agent/extensions/triple-pi
```

安装器的安全策略：

- 已指向正确源目录：幂等成功；
- broken/wrong symlink：删除后重建；
- 目标是普通文件或普通目录：拒绝覆盖；
- 旧 memory-only symlink：迁移删除；
- agent 根目录可由 `PI_CODING_AGENT_DIR` 覆盖。

这属于 Triple-pi 的部署胶水。**扫描扩展目录并调用默认导出的是 Pi 上游 loader。**

### 2.3 统一扩展入口

`extensions/index.ts` 的默认导出完成依赖装配：

```text
triplePiExtension(pi)
  │
  ├─ repository = createMemoryRepository()
  ├─ registerMemoryExtension(pi, repository)
  └─ registerSubagentExtension(pi, repository)
```

共享 repository 很重要：Memory 与 Reviewer 看到同一 canonical store，而不是各自实现文件扫描。入口不应该承载业务状态；扩展实例状态应封装在注册函数内。

## 3. Pi 上游能力面

### 3.1 Extension API

从 Triple-pi 使用方式可归纳出以下宿主契约：

```text
ExtensionAPI
├─ registerTool(tool)
├─ registerCommand(name, handler)
├─ on(event, handler)
└─ appendEntry(customType, data)

ExtensionContext
├─ cwd
├─ model
├─ modelRegistry
├─ sessionManager
├─ hasUI / ui
└─ 其他运行时状态
```

这些接口的语义由 Pi 定义。Triple-pi 对它们做组合，形成自己的协议。

### 3.2 Session tree，而非平面日志

Pi session 被建模为 append-only tree。当前 branch 是从根到当前 leaf 的一条路径：

```text
root
 ├─ u1 ─ a1 ─ u2 ─ a2 ─ cp-A       branch A
 │             \
 │              u2' ─ a2' ─ cp-B   branch B
 └─ ...
```

`ctx.sessionManager.getBranch()` 返回当前路径；`getLeafId()` 给出当前 leaf；`getSessionId()` 标识 session。Triple-pi 不应扫描目录并猜“最近 JSONL”，因为文件时间不能表达当前 leaf、废弃 branch、fork 或 compaction 语义。

### 3.3 ModelRegistry 与 provider 边界

[目标协议/现状] 自动提取使用当前 `ctx.model` 和 `ctx.modelRegistry`。认证、动态 header、base URL、自定义 provider 都留给 Pi：

```text
Triple-pi: 组织提示、要求 JSON、校验输出
Pi:        定位模型、取认证、调用 provider、处理兼容性
```

错误方案：

```text
读取 ~/.pi/agent/auth.json
  → 按 key 前缀猜 provider
  → 拼固定 endpoint
  → 自行发 HTTP
```

它会复制上游职责，并在 OAuth、custom provider、ambient auth 或配置迁移时失效。

### 3.4 UI 是能力，不是必然条件

`ctx.hasUI` 是安全边界。手动 `SaveMemory` 需要把完整 scope/category/title/content 展示给用户确认：

```text
hasUI && confirm = true  → 可以写
hasUI && confirm = false → 不写
!hasUI                   → fail closed，不静默保存
```

命令行批处理没有 UI 不等于默认授权。无法实施产品承诺时，应拒绝而不是降级。

## 4. Triple-pi 的运行时组成

```text
Triple-pi unified extension
├─ Memory Extension
│  ├─ SaveMemory / SearchMemory tools
│  ├─ lifecycle hooks
│  ├─ SessionState
│  ├─ ExtractionScheduler
│  └─ FilesystemMemoryRepository
└─ Subagent Extension
   ├─ delegate/review tools
   ├─ isolated reviewer orchestration
   └─ shared memory repository lookup
```

本卷重点是 Memory；Reviewer 只用于说明边界：Pi 提供模型和工具执行基础，Triple-pi 定义何时委派、怎样构造 review 输入、如何绑定 diff 和 memory 证据、怎样解释结果。

## 5. Lifecycle：把业务语义绑定到正确时机

### 5.1 `session_start`：恢复本 session 的可见性

Memory 扩展在 session 启动时：

1. 从当前 branch 找 working checkpoint；
2. 深度校验 checkpoint 内嵌状态；
3. 读取 project lifecycle；
4. `archive-due`：无损归档并标 cold；
5. `archived`：不注入，提示显式恢复；
6. `cold`：有 UI 时询问，无 UI 时保持 cold；
7. 允许恢复则刷新 activity 并标 hot。

状态机：

```text
                inactivity > 30d
       ┌────────────────────────────┐
       │                            ▼
     [hot]                       [cold]
       ▲                            │
       │ confirm restore            │ inactivity > 90d / next start
       └────────────────────┐       ▼
                            └── [archived]
                                  │
                                  └─ explicit restore + confirm → hot
```

`SessionState.hot/cold` 表示**本扩展实例、本 session 的决定**；磁盘 metadata 表示跨 session 生命周期。不能只读磁盘状态，因为用户可能在当前 session 拒绝 cold 恢复。

### 5.2 `before_agent_start`：请求级注入

每次模型请求前，扩展构造两类上下文：

```text
长期记忆索引 → 追加到 chained system prompt
Working State → 标为 derived/temporary/untrusted 的 custom message
```

长期记忆按 context window 计算预算；Working State 也独立限长。二者隔离的原因：

- 长期规则属于高信任、跨 session 上下文；
- Scratchpad/Daily 可能只是 assistant 报告或暂态计划；
- 若都塞入 system prompt，会抹平信任等级；
- 若每 turn 持久追加普通消息，会在 session tree 内积累重复快照。

在注入 Working State 前会过滤旧的 `triple-pi-working-context`，目标是不累积同类派生消息。

### 5.3 `agent_settled`：稳定边界后的异步提取

为什么不是任意 assistant message 结束后立刻提取？因为 Agent Loop 可能仍会自动重试、compact-and-retry 或消费 queued continuation。settled 才是本轮不会自行继续的稳定边界。

处理顺序：

```text
agent_settled
  ├─ 读取 hot/cold 生命周期
  ├─ 快照当前 branch
  ├─ 确定性生成并保存 Working State
  ├─ append working checkpoint
  ├─ 创建 ExtractionSnapshot
  └─ scheduler.start(...)
       └─ 后台 extraction → 成功后 append memory checkpoint
```

关键点：snapshot 同步捕获 `cwd/sessionId/branch/leaf/model/modelRegistry`。后台任务不能继续引用可变 `ctx`。

### 5.4 `session_tree`：branch 改变时 fencing

tree 切换意味着旧 in-flight extraction 的结果可能不再属于当前 branch。处理动作：

- `scheduler.bumpGeneration()`；
- abort 当前提取；
- 从目标 branch 恢复 working checkpoint；
- 有合法状态则更新 `branchWorking` 和 latest；
- 无合法状态则清空，防止旧 branch 临时状态泄露。

### 5.5 `session_shutdown`：有界退出

shutdown 清空 session working state，增加 generation，abort 在途任务，并最多等待约一秒。

```text
无限等待：退出可能卡死
完全不等：已接近 commit 的任务更易留下不必要重试
有界等待：可用性与善后之间折中
```

注意：有界等待不等于强制终止 JavaScript Promise；真正安全性仍由 AbortSignal 检查、repository 事务和 generation fencing 提供。

## 6. 一次完整调用时序

```text
User          Pi Runtime        Memory Ext       Scheduler        Repository
 │                │                 │                │                 │
 │ new session    │                 │                │                 │
 ├───────────────>│ session_start   │                │                 │
 │                ├────────────────>│ get lifecycle  │                 │
 │                │                 ├─────────────────────────────────>│
 │                │                 │<─────────────────────────────────┤
 │                │                 │ confirm cold?  │                 │
 │                │<────────────────┤                │                 │
 │ prompt         │                 │                │                 │
 ├───────────────>│ before_agent... │                │                 │
 │                ├────────────────>│ build prompt   │                 │
 │                │                 ├─────────────────────────────────>│
 │                │<────────────────┤ memory/context │                 │
 │                │ model/tool loop │                │                 │
 │                │ agent_settled   │                │                 │
 │                ├────────────────>│ snapshot       │                 │
 │                │                 ├───────────────>│ runExtraction   │
 │                │                 │                ├────────────────>│
 │                │                 │                │<────────────────┤
 │                │                 │ appendEntry(cp)│                 │
 │                │<────────────────┤<───────────────┤                 │
```

这里存在两个不同的持久域：

1. Memory repository：长期 record、manifest、reinforcement；
2. Pi session tree：branch-local checkpoint。

跨域不存在单一 ACID 事务，所以顺序必须是“repository 先发布，再 append checkpoint”。反向顺序会造成已跳过输入但磁盘没有记录。

## 7. 运行时不变量

### R-1 Extension 实例隔离

每次 `registerMemoryExtension` 创建自己的 `SessionState` 与 scheduler，避免 reload/fork 后模块级可变单例泄露。

### R-2 Context capture

```text
后台任务可使用的数据 ⊆ agent_settled 时创建的不可变 snapshot
```

不允许异步晚些时候再从 `ctx` 读取“当前”cwd、session 或 leaf。

### R-3 注入顺序

长期记忆注入发生在模型请求前；提取发生在 settled 后。提取结果影响后续请求/会话，不应反向改变已经完成的模型请求。

### R-4 冷态不可旁路

任意入口都必须服从 cold/archive：prompt、search、manual save、working state、extraction。只在 UI 层拦一次不够，repository 还需写保护。

### R-5 上游状态不复制

session branch 由 Pi `sessionManager` 提供；provider auth 由 ModelRegistry 提供。Triple-pi 不能维护第二套猜测状态。

## 8. 源码导读

1. `bin/trip`：只看定位与 `exec`，不要从这里推断 Agent Loop。
2. `.gitmodules`、`package.json`：确认 `pi-runtime` 是上游 submodule，本项目通过本地包依赖编译。
3. `scripts/install-extension.mjs`：理解扩展安装与非覆盖策略。
4. `extensions/index.ts`：看统一 composition root 和共享 repository。
5. `extensions/memory/index.ts`：按 lifecycle hook 分段读，而非从头逐行读。
6. `extensions/memory/extraction/provider.ts`：识别模型调用边界。
7. `extensions/subagent/index.ts`、`review-core.ts`：对照同一个 Extension API 如何支持第二个领域系统。

[校正点] 后续若 Pi submodule 未 checkout，源码导读只能基于 Triple-pi 的使用面；校正时应进入 Pi 对应 package 核实事件精确定义，特别是 `agent_settled`、custom entry 是否进入模型上下文、`before_agent_start` 返回值合并规则。

## 9. 错误方案与 trade-off

### 9.1 Fork Pi Agent Loop

**错误**：复制主循环后插 memory hooks。

- 优点：短期完全可控；
- 代价：重试、compaction、provider、tool loop 全部背离上游；
- 结论：除非上游没有必要扩展点，否则不应复制。

### 9.2 cron 扫最新 JSONL

**错误**：按 mtime 选最新 transcript。

- 无法知道当前 leaf；
- 会读废弃 branch；
- 不知道 queued continuation 是否结束；
- 复制 auth/provider；
- 与当前 cwd/project identity 容易不一致。

正确替代是 lifecycle + current branch snapshot。

### 9.3 全部记忆作为普通 message 追加

- 优点：实现简单、session 可见；
- 代价：每 turn 累积、污染 transcript、branch fork 携带旧快照；
- 当前选择：长期索引进入请求级 system prompt，Working State 使用可替换的 hidden custom context。

### 9.4 全局模块单例状态

- 优点：少传参数；
- 风险：测试实例、extension reload、fork/new session 相互污染；
- 当前选择：注册时创建实例状态，共享只通过显式 repository 注入。

### 9.5 无 UI 自动同意

- 优点：headless 自动化方便；
- 风险：违背“用户看到完整内容后确认”的产品协议；
- 当前选择：手动 save fail-closed。自动 extraction 则依靠不同的 grounding/review 协议，而不是冒充手动同意。

## 10. 面试追问

1. **Pi 与 Triple-pi 的最小稳定接口是什么？**
   - 回答应包含 lifecycle、sessionManager、ModelRegistry、UI 与 tool registration；不要把内部文件路径说成稳定接口。
2. **为什么 `agent_settled` 比 `agent_end` 更合适？**
   - 继续追问 queued follow-up 与 compact retry 对重复提取的影响。
3. **为什么 checkpoint 在 Pi session tree，manifest 在 Memory store？**
   - 前者表达 branch 进度，后者表达磁盘幂等提交；两者的故障域不同。
4. **如果 repository 已提交，但 `appendEntry` 前进程退出会怎样？**
   - 下次 branch 没看到 checkpoint，会重放；manifest 使重放 no-op，然后可以补 checkpoint。
5. **如果先 append checkpoint 再写 repository 呢？**
   - 崩溃会永久跳过输入，因此违反 fail-closed。
6. **为什么 `ctx.cwd` 优于 `process.cwd()`？**
   - Extension 运行进程的 cwd 未必等于当前 session workspace；宿主 context 才是请求级真相。
7. **如何处理 Pi API 变化？**
   - 统一 composition root、少量 adapter、契约测试；不要把上游类型散落为隐式假设。
8. **Reviewer 算 Pi 上游还是 Triple-pi 原创？**
   - 子代理/模型运行能力依赖 Pi；review 输入协议、隔离策略、diff/memory 绑定和结果政策属于 Triple-pi。
