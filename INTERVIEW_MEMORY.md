# Triple-pi Memory 系统面试完整指南

> 这份文档的目标读者是你——一个要去面试的开发者。我会从最基础的概念开始，把整个 Memory 系统的每一个技术决策、每一个遇到的问题、每一行代码背后的"为什么"讲清楚。读完你应该能自信地回答任何相关提问。

---

## 目录

1. [前置基础概念](#1-前置基础概念)
2. [背景：Pi Agent 是什么，为什么需要 Memory](#2-背景pi-agent-是什么为什么需要-memory)
3. [旧系统的问题（面试时用来展示你的分析能力）](#3-旧系统的致命问题)
4. [架构全景图](#4-架构全景图)
5. [第 1 层：项目身份——怎么区分不同项目](#5-第-1-层项目身份project-identity)
6. [第 2 层：存储核心——数据怎么安全落盘](#6-第-2-层存储核心filesystem-memory-repository)
7. [第 3 层：生命周期——记忆的冷热状态机](#7-第-3-层生命周期状态机)
8. [第 4 层：手动保存——SaveMemory Tool](#8-第-4-层手动保存savememory)
9. [第 5 层：自动提取——整个系统最核心的部分](#9-第-5-层自动提取完整的-6-步链路)
10. [第 6 层：Working State 临时工作状态](#10-第-6-层working-state)
11. [安全设计](#11-安全设计)
12. [为什么不做 X？](#12-为什么不做-x)
13. [测试与验证体系](#13-测试与验证体系)
14. [大厂面试 Q&A 逐题详解](#14-大厂面试-qa-逐题详解)
15. [面试回答模板](#15-面试回答模板)

---

## 1. 前置基础概念

面试官可能会追问底层技术细节。在讲 Memory 系统之前，先把会用到的核心概念搞明白。

### 1.1 进程与并发

**进程（Process）**：操作系统里一个正在运行的程序实例。你打开终端跑 `pi`，操作系统就创建了一个 Pi 进程。它有自己的内存空间、文件描述符等，跟其他进程互相隔离。

**并发（Concurrency）**：多个任务在同一时间段内执行。比如你可能开了两个终端窗口，跑了两个 Pi 实例在同一个项目目录下。

**为什么 Memory 系统要关心并发？** 如果两个 Pi 进程同时往同一个记忆文件写内容，后写的可能覆盖先写的，也可能两个进程各自写一半，文件内容变成乱码。这就是"竞态条件"（Race Condition）。

### 1.2 文件锁（File Lock）

**问题**：两个进程同时写一个文件，数据会损坏。

**解决**：文件锁——就像公共厕所门上的插销，谁先进去谁锁门，外面的人排队等。

我们的项目使用了 `proper-lockfile` 这个 npm 包。它的工作原理：

```
进程 A 想写文件：
  1. 在目标目录下创建一个 .lock 文件
  2. 如果 .lock 文件已存在 → 说明别人在用，等待并重试（最多 20 次）
  3. 如果 .lock 文件不存在 → 创建成功，获得锁
  4. 执行写操作
  5. 删除 .lock 文件，释放锁

进程 B 同时在等待：
  1. 尝试创建 .lock 文件 → 失败（进程 A 占着）
  2. 等待 10-100ms 后重试
  3. 直到进程 A 释放锁 → 获得锁
  4. 执行写操作
```

代码位置：`repository.ts` 的 `withWriteLock()` 方法。

**关键参数**：
- `retries: 20`：最多重试 20 次
- `minTimeout: 10, maxTimeout: 100`：每次重试间隔 10-100ms
- `stale: 10_000`：如果锁文件超过 10 秒没被释放（进程崩溃），自动清除

**面试要点**：如果面试官问"锁超时了怎么办"，回答——设置 `stale` 可以防止死锁。如果进程崩溃没来得及释放锁，10 秒后其他进程可以强制获取。但这不是银弹：如果写入操作本身超过 10 秒，可能两个进程同时获得锁。我们的写操作都是毫秒级的，所以安全。

### 1.3 原子写入（Atomic Write）

**问题**：如果写文件写到一半进程崩溃了，文件只剩半截，读取方会读到损坏的数据。

**解决**：原子写入——"要么完全成功，要么完全不存在"。

```
错误方式（非原子）：
  fs.writeFileSync("rule.md", newContent)
  // 如果在这行之前崩溃 → 文件里是半截内容

正确方式（原子写入）：
  // 1. 先写到临时文件
  fs.writeFileSync(".rule.md.a1b2c3.tmp", newContent)
  // 2. 再把临时文件改名为正式文件
  fs.renameSync(".rule.md.a1b2c3.tmp", "rule.md")
  // rename 是操作系统的原子操作——要么完成，要么没发生
```

**为什么 `rename` 是原子的？** 这是操作系统文件系统的保证。`rename` 只修改目录项（directory entry）的指针，不修改文件数据本身。操作要么成功（指针更新），要么失败（指针不变），不存在"指针更新一半"的中间状态。

代码位置：`repository.ts` 的 `atomicWrite()` 方法。

**面试要点**：
- Q: 为什么不用 `writeFileSync` 直接写？
- A: 因为如果写入过程崩溃，文件就损坏了。temp + rename 保证读取方看到的要么是完整旧内容，要么是完整新内容，永远看不到半写状态。这种策略叫"崩溃一致性"（Crash Consistency）。

### 1.4 权威数据与派生索引

**问题**：Memory 系统需要两个东西——存储记忆内容本身，以及一个方便浏览的索引（类似书本的目录）。如果这两个不同步怎么办？

**解决思路**：
- **权威数据（Source of Truth）**：单个 Entry Markdown 文件，每个文件包含一条记忆的完整数据和 metadata
- **派生索引（Derived Index）**：`MEMORY.md` 文件，只是一份方便人类和 LLM 快速浏览的列表

**关键原则**：索引丢了/坏了，可以从 Entry 文件重建。Entry 文件丢了就真丢了。

```
重建流程：
  遍历 entries/ 目录下的所有 .md 文件
    → 读取每个文件的 metadata header
    → 按标题排序
    → 生成 MEMORY.md
```

代码位置：`repository.ts` 的 `rebuildIndexUnlocked()` 方法。

**面试要点**：这个设计解决了一个两难问题——如果保存时要同时写入 Entry 和 Index，且要求两个文件同时成功，那就需要"分布式事务"，在单机上做不到真正的原子性。我们的方案是：先写 Entry（不可丢失），再写 Index（可重建）。Index 写失败了不影响 Entry，因为 Entry 才是真相。

### 1.5 Fail-Closed 与 Fail-Open

这两个概念在安全系统里很重要：

- **Fail-Closed（故障关闭）**：出错时拒绝操作，宁可"误杀"也不"放过"。比如：不确定该不该写记忆 → 不写。
- **Fail-Open（故障开放）**：出错时允许操作，宁可"放过"也不"误杀"。比如：防火门断电时自动打开让人逃生。

Memory 系统几乎所有路径都采用 **Fail-Closed**：
- 无交互 UI → 拒绝保存
- LLM 输出不规范 → 整批拒绝
- 项目已归档 → 拒绝写入
- 提取失败 → 不写 checkpoint，下次重试

**为什么？** 长期记忆是持久副作用。一条错误的记忆会在后续所有 Session 里反复污染 Agent 的决策。相比之下，漏掉一条记忆的代价小得多——下次还可以手动保存或提取重试。

### 1.6 Session 与 Branch

Pi Agent 的概念：
- **Session**：一次完整的对话。从启动 Pi 到退出。
- **Session Tree**：Pi 把对话历史存储为一棵树。每个节点（Entry）可以是用户消息、模型回复、工具调用等。支持分支（Branch），类似于 Git 的分支——你可以从某个点 fork 出一个新对话方向。
- **Branch**：对话树中的一条路径。`sessionManager.getBranch()` 返回当前活动的 branch 上的所有 Entry。

**为什么 Memory 系统要关心 Branch？** 因为 memory checkpoint 跟着 branch 走——切换 branch 就切换到那个 branch 的提取进度，不会跨 branch 乱跳。

---

## 2. 背景：Pi Agent 是什么，为什么需要 Memory

### 2.1 Pi Agent 简介

Pi 是一个 Coding Agent Runtime（不是我的代码，我不修改它）。它的核心能力：

1. 加载 Extensions（插件系统）
2. 管理对话循环：用户发消息 → 调用 LLM → 执行工具 → 返回结果 → 循环
3. 把对话历史保存为 append-only 的 Session Tree
4. 提供 ModelRegistry（管理不同 AI 模型的 API key 和认证）
5. 触发生命周期事件（session_start、agent_settled 等）

### 2.2 为什么需要 Memory？

没有 Memory 的 Agent 每次启动都是"失忆"的：
- 用户上次说了"这个项目用 TypeScript strict mode"
- 下次启动 Agent 完全不记得
- 用户必须反复重复相同的偏好和规则

有了 Memory：
- Agent 启动时自动加载之前的项目规则、偏好、决策
- 用户说一次"记住这个"，跨 Session 持久保留
- Agent 还能从对话中自动提取重要信息

### 2.3 设计目标

| 优先级 | 目标 | 含义 |
|---|---|---|
| 1 | 正确隔离 | 项目 A 的记忆绝不能出现在项目 B |
| 2 | 安全默认 | 无用户确认不写盘，自动提取失败就拒绝整批 |
| 3 | 可审计 | 所有记忆是人类可读的 Markdown 文件 |
| 4 | 可恢复 | 单个文件损坏不影响其他记忆，索引可从 Entry 重建 |
| 5 | Pi 原生接入 | 不修改 Pi 源码，用 Extension API |
| 6 | 可测试 | 确定性测试做 CI 门，Live LLM Eval 做独立质量评估 |

---

## 3. 旧系统的致命问题

> 面试时可以讲这个来展示你的问题分析能力。

旧系统（v0.x）不是某一个 bug 的问题，而是端到端架构断裂。我来逐个说明：

### 问题 1：两个写入路径互相看不见

```
Extension (SaveMemory) 写入:    ~/.triple-pi/memory/global/rule/xxx.md
Cron Extractor 写入:            ~/.triple-pi/memory/rule/xxx.md
                                 ↑ 注意：没有 global/ 目录层
```

手动保存和自动提取写到不同的目录结构里，SearchMemory 只能搜到其中一个路径的数据。一条记忆被 Extract 保存后，Prompt 用 `loadContextPrompt()` 加载的索引根本看不到它。

### 问题 2：跨 Session 闭环根本没接通

`loadContextPrompt()` 函数存在，但没有接入 Pi 的 `before_agent_start` 生命周期。这意味着——新 Session 启动时，系统 prompt 里根本没有记忆索引。代码写了但没调用。

### 问题 3：Project Identity 有三个不同实现

Extension、Extractor、Session Path 各自用自己的算法判断"当前是哪个项目"：
- Extension 用 `getProjectSlug()` 基于 git remote
- Extractor 从 session 目录名逆向猜 cwd
- Session Path 直接读 JSONL 路径

三个不同的 identity 算法导致同一个项目被识别为三个不同的 ID，记忆写到了三个不同的目录，谁跟谁都不通。

### 问题 4：Cron 绕过 Session Tree

旧系统用 cron 定时触发提取，cron job 做的事情是：
1. 扫描 session 目录
2. 找"最新"的 JSONL 文件
3. 读这个文件的内容
4. 调 LLM 提取

问题：
- cron 不知道当前 active branch 是哪个
- 可能读了已经废弃的 branch 的对话
- 不知道 session 正在进行中还是已完成
- 如果 Pi 做了 compaction（压缩旧对话），cron 读到的可能是不完整的
- 复制了一遍 provider/auth 逻辑，没复用 Pi 的 ModelRegistry

### 问题 5：30 天硬删除

旧系统超过 30 天不活跃直接 `rm -rf` 删除整个记忆目录。且 activity marker 可能写到错误的项目目录。误删无法恢复。

### 问题 6：旧 Eval 的 "10/10 通过" 是假的

- 只检查 category 字段，不检查 content/title/evidence
- 默认 tolerance=1，允许"至少应该匹配 0 条"的 case 永远通过
- Provider 错误返回空结果 → noise case（本应有 0 条记忆）假通过
- 只测试了 project A，project B 的隔离根本没验证
- 解析 stdout 文案，不是真实的产品 contract

### 面试怎么讲这一段

> "旧系统不是一个小 bug，而是端到端的协议断裂：两个写入路径互相看不到、跨 session 闭环没接通、project identity 有三个不同实现、cron 绕过 session tree、30 天硬删除、eval 的通过是假的。这些问题说明——如果架构的核心假设不一致，上层修修补补是没用的。所以我选择了重建一个唯一的 Memory Core。"

---

## 4. 架构全景图

```
                     Pi Agent Runtime（不修改）
                    ┌─────────────────────────┐
                    │  Extension Lifecycle    │
                    │  - session_start        │
                    │  - before_agent_start   │
                    │  - agent_settled        │
                    │  - session_tree         │
                    │  - session_shutdown     │
                    │  - Tool System          │
                    │  - ModelRegistry        │
                    └───────┬─────────────────┘
                            │ 通过 Extension API 接入
                            ▼
              ┌─────────────────────────────────┐
              │     index.ts (Extension 入口)    │
              │                                 │
              │  SaveMemory Tool (手动保存)      │
              │  SearchMemory Tool (搜索)        │
              │  SessionState (会话内状态管理)    │
              │  ExtractionScheduler (提取调度)   │
              │  Commands (memory-status 等)     │
              └────────────┬────────────────────┘
                           │
              ┌────────────▼────────────────────┐
              │   repository.ts (唯一存储核心)    │
              │                                 │
              │   FilesystemMemoryRepository    │
              │   - save / saveExtractionBatch  │
              │   - search / buildPrompt / list │
              │   - archiveProject / restore    │
              │   - loadWorkingState / save...  │
              │   - 文件锁 / 原子写入 / 回滚    │
              └────────────┬────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
  │ domain.ts    │ │ extraction/  │ │ working-state.ts │
  │ 类型定义      │ │ 自动提取链路  │ │ 临时工作状态      │
  │ MemoryRecord │ │ source.ts    │ │ Scratchpad       │
  │ MemoryScope  │ │ pipeline.ts  │ │ Daily            │
  │ MemoryCategory│ │ provider.ts  │ │                  │
  └──────────────┘ │ review.ts    │ └──────────────────┘
                   │ signals.ts   │
                   │ consolidation│
                   │ coordinator  │
                   └──────────────┘

              文件系统存储
       ~/.triple-pi/memory-v1/
       ├── global/entries/...
       ├── projects/<id>/entries/...
       ├── projects/<id>/working/...
       ├── archive/projects/<id>/
       ├── extractions/
       └── signals/
```

**数据流**：

```
会话 A
  → 用户说 "这个项目用 strict TypeScript"
  → agent_settled 触发
  → 提取候选 → 严格验证 → Review → Consolidation
  → 写入 projects/<project-id>/entries/rule/xxx.md
  → 写入 checkpoint 到 session tree

会话 B（同项目，几天后）
  → Pi 启动 → session_start
  → 检查生命周期：hot（<30天）
  → before_agent_start
  → buildPrompt() 把索引注入 system prompt
  → Agent 看到: "## Persistent Memory\n- [project/rule] 使用 strict TypeScript"
  → Agent 知道有这个规则
```

---

## 5. 第 1 层：项目身份（Project Identity）

代码文件：`extensions/memory/project-identity.ts`，只有 30 行。

### 5.1 问题

同一个开发者可能维护多个项目。项目 A（公司的电商后端）和项目 B（个人的博客）不应该共享记忆。需要一个方式来唯一标识"当前在哪个项目"。

### 5.2 方案：cwd → SHA-256

```
resolveProjectIdentity(cwd):
  1. path.resolve(cwd)        // 把相对路径变成绝对路径
  2. fs.realpathSync(...)     // 解析符号链接
  3. basename → displayName   // 方便人读的名字，如 "my-app"
  4. SHA-256(cwd) 取前 20 位  // 稳定且防碰撞的唯一 ID
  返回:
    {
      id: "my-app-e4b2d3c1a5...",  // 唯一标识符
      cwd: "/home/user/projects/my-app",  // 规范化的完整路径
      displayName: "my-app"  // 人类可读的名字
    }
```

### 5.3 为什么不用 Git Remote？

```bash
git remote get-url origin
# → git@github.com:my-org/monorepo.git
```

大厂 monorepo 里，几十个子项目共享同一个 git remote。如果按 remote 做 identity：
- `monorepo/packages/backend` 和 `monorepo/packages/frontend` 会被识别为同一个项目
- 后端 API 策略会污染前端项目的记忆

用 cwd 意味着 `packages/backend` 和 `packages/frontend` 各自独立。

### 5.4 为什么用 SHA-256 而不是直接用 cwd 当目录名？

cwd 路径包含 `/` 和其他特殊字符，不能直接当目录名。SHA-256 产生固定长度（取前 20 位=10 字节=40 个 hex 字符）、只包含 `[0-9a-f]`、碰撞概率极低。

### 5.5 为什么额外做了 `realpathSync`？

符号链接（Symlink）：
```bash
/home/user/work → /mnt/data/projects
```

如果没有 `realpathSync`，`cd /home/user/work` 和 `cd /mnt/data/projects` 会产生不同的 hash，被视为不同项目。`realpathSync` 解析符号链接，保证两个路径指向同一个项目时生成相同的 identity。

### 面试要点

> Q: 两个开发者在同一台机器上，各自 clone 了同一个仓库到不同目录，它们的记忆会共享吗？
> A: 不会。cwd 不同 → hash 不同 → 不同项目。这是正确的行为——不同 clone 目录可能在不同分支、不同开发阶段，规则不应该混用。
> Q: 怎么实现共享？
> A: 应该通过显式配置，比如 `.triple-pi-project` 文件指定共享的 project ID，而不是让系统隐式猜测。

---

## 6. 第 2 层：存储核心（Filesystem Memory Repository）

代码文件：`extensions/memory/repository.ts`，约 800 行。

### 6.1 目录结构

```
~/.triple-pi/memory-v1/                    ← 环境变量 TRIPLE_PI_MEMORY_ROOT 可覆盖
│
├── global/                                ← 跨所有项目共享
│   └── entries/
│       ├── preference/{record-id}.md
│       ├── decision/{record-id}.md
│       ├── rule/{record-id}.md
│       ├── fact/{record-id}.md
│       └── knowledge/{record-id}.md
│
├── projects/{project-id}/                 ← project-id 由 ProjectIdentity 生成
│   ├── project.json                       ← 元数据（状态、活跃时间）
│   ├── MEMORY.md                          ← 派生索引（可重建）
│   ├── entries/
│   │   ├── preference/{record-id}.md
│   │   ├── decision/{record-id}.md
│   │   └── ...
│   ├── working/
│   │   ├── sessions/{session-hash}/SCRATCHPAD.md
│   │   └── latest.json
│   └── daily/
│       ├── 2026-07-25.md
│       └── 2026-07-26.md
│
├── archive/projects/{project-id}/         ← 归档项目（同文件系统 rename）
│
├── extractions/{project-id}/{sourceHash}.json  ← 幂等标记
├── working-manifests/{project-id}/{sourceHash}.json
└── signals/{project-id}/reinforcement.json
```

### 6.2 Entry 文件的格式

每一条记忆是一个 Markdown 文件，头部嵌入了 JSON metadata：

```markdown
<!-- triple-pi-memory
{"schemaVersion":1,"id":"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6","category":"rule","scope":"project","projectId":"my-app-xxx","title":"使用 Strict TypeScript","content":"本项目所有新代码必须使用 TypeScript strict mode。","createdAt":"2026-07-01T00:00:00.000Z","updatedAt":"2026-07-20T12:30:00.000Z","provenance":{"source":"extraction","sessionId":"session-123","sourceHash":"sha256...","fingerprint":"sha256...","score":0.85,"reinforcement":3}}
-->

# 使用 Strict TypeScript

本项目所有新代码必须使用 TypeScript strict mode。
```

设计原则：
- **JSON metadata 在 HTML 注释里**：Markdown 渲染器会隐藏注释，但程序可以精确解析
- **正文是人类可读的 Markdown**：用任何编辑器都能直接打开查看
- **id 由 scope+projectId+category+title 做 SHA-256**：同一条记忆更新时 id 不变

### 6.3 Record ID 的生成

```
recordId("project", "my-app-xxx", "rule", "使用 Strict TypeScript")
  → SHA-256("project\0my-app-xxx\0rule\0使用 strict typescript")
  → 取前 32 位 hex
```

关键：**id 不包含 title 和 content 的具体内容变体**。因为同一条规则的描述可能从"用 strict TS" 改为 "所有代码用 TypeScript strict mode"，id 不变，更新时保留 `createdAt`，只刷新 `updatedAt`。

### 6.4 原子写入的完整流程

```typescript
async atomicWrite(filepath: string, content: string): Promise<void> {
  // 1. 确保父目录存在，权限 0700（只有 owner 能读写执行）
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  // 2. 生成一个随机临时文件名
  const temporary = path.join(dir, `.${basename}.${randomUUID()}.tmp`);
  //   例: .a1b2c3d4.md.550e8400-e29b-41d4-a716-446655440000.tmp

  try {
    // 3. 内容写入临时文件，权限 0600（只有 owner 能读写）
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });

    // 4. 原子 rename —— 操作系统保证这一步要么全成功要么全失败
    await fs.rename(temporary, filepath);
    //   rename 完成后，filepath 指向完整的新内容
    //   任何在这一刻之前打开文件的读取者看到的是旧内容
    //   任何在这一刻之后打开文件的读取者看到的是新内容
    //   没有人会看到半写的内容

    // 5. 确保正式文件权限正确
    await fs.chmod(filepath, 0o600);
  } finally {
    // 6. 清理临时文件（不管成功失败）
    //    如果 rename 成功了，temporary 已经不存在（被 rename 移走了）
    //    fs.rm 会静默失败，没有副作用
    //    如果 rename 失败了，temporary 还在，这里清理掉
    await fs.rm(temporary, { force: true });
  }
}
```

### 6.5 为什么 temporary 文件用 `.` 开头？

以 `.` 开头的文件在 Linux 上是隐藏文件。如果用 `ls` 浏览目录，看不到这些临时文件，不会干扰人类用户。而且 `readdir` 遍历 entry 文件时如果不过滤 `.` 文件，会读到 `.tmp` 残留——不过这不是问题，因为我们用 `endsWith('.md')` 过滤，`.tmp` 不会被当成记忆文件。

**但是**，万一进程崩溃，`.tmp` 文件可能残留。这就是 `finally { await fs.rm(temporary, { force: true }) }` 的作用——尽最大努力清理。

### 6.6 记录损坏隔离

```typescript
async listBase(base: string): Promise<MemoryRecord[]> {
  for (const entry of entries) {
    try {
      records.push(parseRecord(content, filepath));
    } catch {
      // ⚠️ 一条记录损坏了——跳过它，继续处理其他记录
      // 不能让一条坏记录阻断所有健康记忆
    }
  }
  return records;
}
```

这个 try-catch 非常关键：
- 如果某条记忆的 Markdown 文件被手动编辑损坏了
- 或者 JSON header 格式坏了
- 只会跳过这一条，不会让整个项目的 prompt 构建失败

### 6.7 并发写入安全

```
时间线：
  进程 A                          进程 B
  ────────                        ────────
  withWriteLock() 获取锁✓
  withWriteLock() 等待中...
  atomicWrite(entry-1.md)
  atomicWrite(entry-2.md)
  释放锁
                                  withWriteLock() 获取锁✓
                                  atomicWrite(entry-3.md)
                                  释放锁
```

在一个 `withWriteLock` 锁内可以做多步操作（saveExtractionBatch 可能在一次锁内写入多条记录 + reinforcement + manifest + index），整个批次是一个逻辑事务。如果中间某一步失败，用备份恢复。

### 6.8 事务回滚

`saveExtractionBatch` 的完整事务保护：

```typescript
async saveExtractionBatch(...): Promise<MemoryRecord[]> {
  return this.withWriteLock(async () => {
    // 1. 备份：记录每个将被修改的文件的当前内容
    const backups = new Map<string, string | undefined>();
    //    key = filepath, value = 当前内容（undefined 表示文件不存在）

    try {
      // 2. 逐个写入 entry
      for (const item of staged) {
        backups.set(item.filepath, 旧内容);
        await this.atomicWrite(item.filepath, item.content);
      }

      // 3. 写入 reinforcement state
      backups.set(reinforcementFile, 旧内容);
      await this.atomicWrite(reinforcementFile, 新内容);

      // 4. 写入 source manifest（幂等标记）
      //    这步必须最后做，因为它标志着"整批完成"
      backups.set(manifestFile, 旧内容);
      await this.atomicWrite(manifestFile, manifest内容);

    } catch (error) {
      // 5. 回滚：把每个被修改的文件恢复为旧内容
      for (const [filepath, previous] of backups) {
        if (previous === undefined) {
          await fs.rm(filepath, { force: true });  // 文件之前不存在，删掉
        } else {
          await this.atomicWrite(filepath, previous);  // 恢复旧内容
        }
      }
      throw error;  // 重新抛出错误，让上层知道失败了
    }
  });
}
```

**关键细节：Manifest 最后写入。** Manifest 是"幂等标记"——下次看到相同的 sourceHash，直接跳过不处理。如果 Manifest 在 entry 之前写入，那 entry 写失败了但下次重试会跳过，数据就丢了。所以 Manifest 必须最后写，作为"全部完成"的信号。

### 6.9 读写锁分离

当前修复后的设计：

- **写操作**（save, saveExtractionBatch, archive, restore, saveWorkingState 等）→ 获取 `withWriteLock()`（排他锁）
- **读操作**（buildPrompt, search, list, loadWorkingState, diagnose 等）→ **不持锁**

为什么读不需要锁？因为 `atomicWrite` 保证每个文件的写入是原子的——读者要么看到旧内容（rename 之前），要么看到新内容（rename 之后），永远不会看到半写的内容。这就叫"无锁读"（Lock-Free Read）。

当然有个代价：读者可能在一个写事务的中间读取，看到"部分已更新"的状态（比如 entry-1 写完了但 entry-2 还没写）。但在 Memory 系统的语义下这是可接受的——Prompt 里多了或少了某条记忆不会造成灾难性后果，下一次 `before_agent_start` 自然会看到最新状态。

---

## 7. 第 3 层：生命周期状态机

### 7.1 核心数据结构

每个项目目录下的 `project.json`：

```json
{
  "schemaVersion": 1,
  "projectId": "my-app-e4b2d3c1a5f6...",
  "displayName": "my-app",
  "cwd": "/home/user/projects/my-app",
  "status": "active",
  "lastActiveAt": "2026-07-25T12:30:00.000Z",
  "archivedAt": null
}
```

### 7.2 状态机

```
         session_start
              │
              ▼
    ┌─────────────────┐
    │  计算闲置天数     │
    │  now - lastActive│
    └───────┬─────────┘
            │
   ┌────────┼────────┐
   ▼        ▼        ▼
0-30天   31-90天    >90天
   │        │        │
   ▼        ▼        ▼
 HOT     COLD    ARCHIVE_DUE
   │        │        │
   │        ├─Yes──→ 恢复热态    ┌→ 自动归档（rename）
   │        ├─No───→ 保持冷态    │
   │        └─无UI─→ 保持冷态    │
   │                            ▼
   │                       ARCHIVED
   │                            │
   │                     /memory-restore
   │                            │
   └──────────── 恢复为 HOT ←───┘
```

### 7.3 为什么 30 天？

真实开发周期：
- 一个功能分支可能持续 2-3 周
- 季度 OKR 项目轮换很常见
- 长假 2-3 周

30 天覆盖了这些场景。如果 30 天没碰一个项目，大概率是暂时不活跃了——但不代表要丢弃记忆。给用户一个显式的恢复决策。

### 7.4 为什么 90 天归档（rename）而不是删除？

1. **磁盘成本远低于误删代价**。一条记忆文件可能只有几 KB，但包含了一个重要的架构决策（"为什么当初选了 PostgreSQL 而不是 MongoDB"），无法从代码里恢复。
2. **Rename 是原子的**。`fs.rename(source, target)` 在同一个文件系统内是原子操作——目录从一个位置瞬间"移动"到另一个位置。不会出现"拷贝一半"的中间态。
3. **恢复简单**。归档就是 rename 到 `archive/` 目录。恢复就是 rename 回来。

### 7.5 生命周期事件的触发时机

```typescript
// session_start: 每次 Pi 启动时
pi.on("session_start", async (event, ctx) => {
  // 1. 检查项目当前生命周期状态
  const lifecycle = await repository.getProjectLifecycle(ctx.cwd);

  if (lifecycle.state === "archive-due") {
    // 自动归档
    await repository.archiveProject(ctx.cwd);
    // 通知用户
  }
  if (lifecycle.state === "cold") {
    if (ctx.hasUI) {
      // 弹确认框
      const restore = await ctx.ui.confirm("恢复？", "...");
      if (restore) {
        // 用户选择恢复 → markProjectActive
      }
    } else {
      // 无 UI → fail closed
    }
  }
  if (lifecycle.state === "hot") {
    // 刷新 lastActiveAt
    await repository.markProjectActive(ctx.cwd);
  }
});

// before_agent_start: 每次模型请求前
pi.on("before_agent_start", async (event, ctx) => {
  // 根据当前 session 的 hot/cold 决策注入哪些记忆
  const includeProject = sessionIsHot && lifecycle.state === "hot";
  const memory = await repository.buildPrompt(ctx.cwd, { includeProject });
  // 把索引追加到 system prompt
  return { systemPrompt: event.systemPrompt + memory.prompt };
});
```

### 7.6 拒绝恢复后 Global 记忆为什么还能看到？

```
用户拒绝恢复 → project memory 不注入
但 global memory 仍然注入
```

因为 global 是跨项目共享的（"在所有项目中保持回复简洁"），跟当前项目的活跃状态无关。用户拒绝的是"这个 35 天没碰的项目的陈旧上下文"，不是自己的全局沟通偏好。

---

## 8. 第 4 层：手动保存（SaveMemory）

### 8.1 触发与执行

```
用户: "记住，这个项目禁止使用 any 类型"
  → Agent 调用 SaveMemory({
       category: "rule",
       title: "禁止使用 any",
       content: "项目中所有 TypeScript 代码禁止使用 any 类型。",
       scope: "project"
     })

SaveMemory 执行流程（index.ts）:
  1. 校验 category ∈ ["preference","decision","rule","fact","knowledge"]
     → 不是？返回 "无效分类"
  2. 校验 title/content 非空
     → 为空？返回 "标题和内容不能为空"
  3. 检查 ctx.hasUI
     → false？返回 "当前模式无法显示确认框"
     → 这是代码级安全门——headless/自动化环境不能静默写盘
  4. 检查项目生命周期
     → 冷态/归档？返回 "请先恢复"
  5. ctx.ui.confirm("保存长期记忆？", 显示 scope/category/title/content)
     → 用户点 No？返回 "用户取消"
  6. repository.save() → atomicWrite + 更新索引
  7. 返回 "已保存"
```

### 8.2 为什么必须 ctx.ui.confirm()？

Agent 的安全模型里，**prompt 指令不是授权边界**。你不能靠 prompt 里说"只有在用户明确要求时才保存"来保证安全——LLM 可能误解、可能被 jailbreak、可能幻觉。

真正的安全边界是：
1. **代码级校验**：category/scope 必须在 allowlist 内
2. **人工确认**：`ctx.ui.confirm()` 把最终决定权交给人类用户
3. **环境检查**：`ctx.hasUI` 判断是否有交互界面

这三层组合起来：即使 LLM 被诱导调用了 SaveMemory，人类也会在确认框看到并拒绝。

### 8.3 SaveMemory 不经过 Extraction Pipeline

手动保存跳过了提取-验证-Review-Consolidation 管线，直接写入 repository。因为：
- 用户手动指定的内容已经是"确认过的 truth"
- 不需要 LLM 再审核一次
- provenance 标记为 `source: "manual"`，区别于自动提取

---

## 9. 第 5 层：自动提取（完整的 6 步链路）

这是整个系统最核心、最复杂的部分，也是面试中最值得详细讲的部分。

### 9.0 触发时机：为什么是 agent_settled？

Pi 的生命周期事件：
- `agent_end`：Agent 完成一轮回复，但可能立即触发自动重试、compact-and-retry、queued continuation
- `agent_settled`：确认本轮交互彻底结束，不会再有自动 follow-up

在 `agent_end` 提取是错误的，因为：
- 如果这轮自动重试了 3 次，前 2 次的内容应该被最终版本取代
- 如果在 `agent_end` 提取了第 1 次重试的结果，第 3 次成功后又会提取一次——重复了
- `agent_settled` 保证所有自动流程已完成，此时对话内容是稳定状态

### 9.1 完整链路总览

```
agent_settled 触发
    │
    ▼
Step 1: 构建提取源 (source.ts)
    │  从当前 branch 取 checkpoint 之后的增量对话
    │  计算 sourceHash 做幂等检查
    │
    ▼
Step 2: Secret Redaction (pipeline.ts)
    │  10 种正则模式脱敏 API key / token / password
    │
    ▼
Step 3: LLM 提取候选 (provider.ts)
    │  调用当前 Agent 所用的模型，请求输出 JSON 候选列表
    │
    ▼
Step 4: Strict Validation (pipeline.ts)
    │  精确字段校验、evidence 逐字匹配、secret 二次检测
    │
    ▼
Step 5: Grounded Review (review.ts)
    │  LLM 二次调用，只能 keep/remove，禁止改写
    │
    ▼
Step 6: Signals + Consolidation (signals.ts + consolidation.ts)
    │  确定性规则计算信号、分层匹配去重
    │
    ▼
Step 7: Transactional Commit (repository.ts)
        在一个写锁内：写入 entry + reinforcement + manifest
        失败回滚，成功写 checkpoint
```

### 9.2 Step 1: 构建提取源

```typescript
// source.ts
function buildExtractionSourceFromBranch(
  branch: SessionEntry[],      // 当前 branch 的全部 entry
  branchLeafId: string | null, // 当前分支叶节点
  lastProcessedEntryId?: string // 上一次 checkpoint 的位置
): ExtractionSource | undefined {

  // 1. 找到上一次的 checkpoint
  const checkpoint = findCheckpoint(branch);
  //    checkpoint 是 session tree 里的一个 custom entry
  //    类型为 "triple-pi-memory-checkpoint"
  //    包含 lastEntryId、sourceHash 等信息

  // 2. 只取 checkpoint 之后的新 entry
  const checkpointEntryId = lastProcessedEntryId || checkpoint?.lastEntryId;
  const checkpointIndex = checkpointEntryId
    ? branch.findIndex(entry => entry.id === checkpointEntryId)
    : -1;
  const entries = checkpointIndex >= 0
    ? branch.slice(checkpointIndex + 1)  // 只取新内容
    : branch;                             // 没有 checkpoint，全量处理

  // 3. 提取 user 和 assistant 的文本内容
  const messages = entries
    .map(entryToMessage)     // 把 SessionEntry 转成 {entryId, role, content, timestamp}
    .filter(Boolean);        // 过滤非文本消息（如 tool_use、tool_result）

  // 4. 最低门槛：至少 2 条消息 + 至少 1 条来自 user
  if (messages.length < 2 || !messages.some(m => m.role === "user")) {
    return undefined;  // 没什么可提取的
  }

  // 5. 计算 sourceHash（幂等标记）
  const sourceHash = SHA-256(JSON.stringify({
    version: EXTRACTOR_VERSION,
    sourceEntryIds: messages.map(m => m.entryId),
    messages
  }));

  return { messages, sourceEntryIds, sourceHash, lastEntryId, branchLeafId };
}
```

**关键设计**：
- **Branch-local checkpoint**：不同 branch 各自维护自己的 checkpoint。切 branch 不会丢失或重复处理。
- **增量处理**：只处理新消息，不重复扫描整个对话历史。
- **sourceHash 做幂等**：相同的对话内容产生相同的 hash。如果 crash 后重试，hash 相同 → 跳过处理。

### 9.3 Step 2: Secret Redaction（脱敏）

```typescript
// pipeline.ts
const SECRET_PATTERNS = [
  // AWS Access Key
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,

  // GitHub Personal Access Token
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,

  // Google API Key
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,

  // Slack Token
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,

  // JWT Token
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,

  // Authorization Header
  /\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi,

  // Private Key (PEM format)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,

  // Password / Token assignments
  /\b(?:password|passwd|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,

  // Generic key-like patterns
  /\b(?:sk|pk|api|key|token|secret)[-_][a-zA-Z0-9_-]{12,}\b/gi,
];

function redactSecrets(messages: ExtractionMessage[]): {
  redactedMessages: ExtractionMessage[]
  containedSecrets: boolean
} {
  let containedSecrets = false;
  const redacted = messages.map(msg => {
    let content = msg.content;
    for (const pattern of SECRET_PATTERNS) {
      content = content.replace(pattern, () => {
        containedSecrets = true;
        return "[REDACTED_SECRET]";  // 替换为占位符
      });
    }
    return { ...msg, content };
  });
  return { redactedMessages: redacted, containedSecrets };
}
```

**两个方向都检测**：
1. **发送前检测**：脱敏 user/assistant 消息中的 secret，防止泄露给 LLM Provider
2. **接收后检测**：`containsSecret()` 检查 LLM 返回的内容是否包含 secret（防止 LLM 幻觉出看似真实的 token）

**面试要点**：
> Q: 这些正则能覆盖所有 secret 吗？
> A: 不能。自定义格式（如公司内部的 token 前缀）无法穷举。README 里已经明确声明了这个限制。但 10 种常见模式覆盖了绝大多数真实泄露场景。完全防御需要在组织层面做——比如用 secret scanning tool、pre-commit hook、或者让用户在敏感代码库中手动关闭自动提取。
>
> Q: 为什么不脱敏就传给 LLM？
> A: 因为提取内容要写盘，如果 token 出现在 LLM 的输出里，就会持久化到 `~/.triple-pi/memory-v1/` 里。这个目录权限是 0700，但不是加密的。任何有文件系统访问权限的人（或恶意软件）都能读到。脱敏是最小化风险。

### 9.4 Step 3: LLM 提取候选

```typescript
// provider.ts
async function extractCandidateJson({ model, modelRegistry, messages, signal }): Promise<string> {
  // 1. 获取认证信息（复用用户的 API key、base URL、custom headers）
  const auth = await modelRegistry.getApiKeyAndHeaders(model);

  // 2. 获取 Provider 实例（OpenAI / Anthropic / custom 等）
  const provider = modelRegistry.getProvider(model.provider);

  // 3. 发送提取请求
  const response = await provider.streamSimple(
    model,
    {
      systemPrompt: EXTRACTION_PROMPT,  // 告诉 LLM 提取哪些类型的记忆
      messages: [{ role: "user", content: messages }],
      tools: [],
    },
    { apiKey: auth.apiKey, headers: auth.headers, signal }
  ).result();

  // 4. 检查响应状态
  if (response.stopReason !== "stop") {
    throw new Error("Extraction stopped: " + response.stopReason);
  }

  return response.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}
```

**关键设计——复用 Pi 的认证体系**：
- 不自己读 `auth.json`
- 不通过 API key 前缀猜 Provider（`sk-` → OpenAI, `sk-ant-` → Anthropic）
- 不硬编码 endpoint URL
- 完全复用 Pi 的 `ModelRegistry.getApiKeyAndHeaders()` 和 `getProvider()`
- 支持 OAuth、custom provider、dynamic base URL 等所有 Pi 支持的认证方式

### 9.5 Step 4: Strict Validation（最硬核的安全门）

这是整个提取管线中最关键的一步。LLM 的输出不能直接信任，必须经过严格的格式和内容校验。

```typescript
// pipeline.ts
function validateCandidates(raw: string, source: ExtractionSource): ExtractedCandidate[] {
  // ── 第一关：必须是合法的 JSON ──
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CandidateValidationError("不是合法的 JSON");
  }

  // ── 第二关：必须是数组，且不超过 10 条 ──
  if (!Array.isArray(parsed) || parsed.length > 10) {
    throw new CandidateValidationError("必须是长度 ≤ 10 的数组");
  }

  // ── 第三关：逐条精确校验 ──
  for (const value of parsed) {
    // 必须是纯对象
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new CandidateValidationError("候选项必须是对象");
    }

    // 字段必须恰好是这 6 个，不多不少
    const keys = Object.keys(value).sort();
    const expected = ["category","content","evidence","scope","sourceEntryId","title"];
    if (keys.length !== 6 || keys.some((k, i) => k !== expected[i])) {
      throw new CandidateValidationError("字段不匹配");
      // 多一个字段 → 拒绝。这意味着 LLM 不能自由发挥加 "reason"、"confidence" 等
    }

    // 类型校验
    if (typeof value.category !== "string" || !isMemoryCategory(value.category))
      → 拒绝;
    if (typeof value.title !== "string" || !title.trim() || title.length > 120)
      → 拒绝;
    if (typeof value.content !== "string" || !content.trim() || content.length > 2000)
      → 拒绝;
    if (typeof value.evidence !== "string" || !evidence.trim() || evidence.length > 500)
      → 拒绝;
    if (typeof value.sourceEntryId !== "string")
      → 拒绝;
    if (value.scope !== "project" && value.scope !== "global")
      → 拒绝;

    // ══════════════════════════════════════════════════════
    // 最关键的校验：evidence 必须是 user 消息的逐字子串
    // ══════════════════════════════════════════════════════
    const sourceMessage = userMessages.get(value.sourceEntryId);
    if (!sourceMessage || !sourceMessage.content.includes(value.evidence)) {
      throw new CandidateValidationError("evidence 在原文中不存在");
      // LLM 编造了一个看似合理的 evidence → 拒绝
    }

    // ══════════════════════════════════════════════════════
    // Secret 二次检测
    // ══════════════════════════════════════════════════════
    if (containsSecret(title) || containsSecret(content) || containsSecret(evidence)) {
      throw new CandidateValidationError("候选内容包含 secret");
    }
    if (evidence.includes("[REDACTED_SECRET]") || content.includes("[REDACTED_SECRET]")) {
      throw new CandidateValidationError("候选包含脱敏占位符");
    }
  }
}
```

**为什么 evidence 必须是 user message 的逐字子串？**

这是整个系统关于"可信度"的核心假设：
- **User message 是 ground truth**——是用户真实输入的、人类写的内容
- **Assistant message 不能做证据**——LLM 可能幻觉、可能只是建议、可能在复述时扭曲原意
- **LLM 提取的 evidence 必须能在 user 原文中找到**——否则就是 LLM 自己编的

举例：
```
User: "这个项目统一用 JWT，因为是 stateless 服务。"
LLM 提取: { evidence: "统一用 JWT", content: "使用 JWT 做认证" }
→ ✅ evidence 在 user 原文中存在

User: "这个项目统一用 JWT，因为是 stateless 服务。"
LLM 提取: { evidence: "因为是微服务架构", content: "使用 JWT 做认证" }
→ ❌ "微服务架构" 不在 user 原文中，LLM 编造的 evidence
```

### 9.6 Step 5: Grounded Review（LLM 二次审核）

提取完候选人后，再调用一次 LLM 做二次审核。但这次 LLM 的权限被严格限制：

```
System Prompt for Reviewer:
  你只能做一件事：对每个候选返回 keep 或 remove。
  禁止改写 title / content / evidence / sourceEntryId。
  返回数量和顺序必须与输入完全一致。

输入：
  {
    userMessages: [{ entryId: "u1", content: "原文..." }, ...],
    candidates: [
      { category: "rule", title: "使用 JWT", content: "...", evidence: "统一用 JWT", sourceEntryId: "u1" },
      { category: "fact", title: "临时调试", content: "重试了一次", evidence: "再试一次", sourceEntryId: "u2" }
    ]
  }

期望输出：
  [
    { action: "keep", reason: "用户明确表达的技术决策", title: "使用 JWT", content: "...", evidence: "统一用 JWT", sourceEntryId: "u1" },
    { action: "remove", reason: "临时调试信息，非长期知识", title: "临时调试", content: "重试了一次", evidence: "再试一次", sourceEntryId: "u2" }
  ]
```

**Reviewer 的约束**（代码在 `review.ts`）：

1. **返回数量必须相同**：`parsed.length !== input.candidates.length` → 拒绝
2. **返回顺序必须相同**：第 i 个输出的 `sourceEntryId` 必须等于第 i 个输入
3. **不能改写任何字段**：输出的 title/content/evidence/sourceEntryId 必须和输入完全一致
4. **action 只能是 "keep" 或 "remove"**
5. **格式不对 → 整批 fail closed**：不尝试"部分接受"

**为什么不让 Reviewer 自由改写？**

自由改写（比如"把这两条合并成一条"）需要后续证明新内容仍在 transcript 中有依据——这叫"逐句 evidence mapping"。当前没有这个机制时，最安全的做法是 reviewer 只做 keep/remove，把内容改写留给用户手动 SaveMemory。

### 9.7 Step 6: Signals + Consolidation

#### Signals 计算

```typescript
// signals.ts
function scoreCandidate(candidate, messages, previousReinforcement): CandidateSignals {
  // 1. 语义指纹：基于 scope+category+title+content 的规范化 token 集合
  const fingerprint = SHA-256(scope + "\0" + category + "\0" + sorted_unique_tokens);

  // 2. 纠正信号检测：evidence 中是否包含方向性纠正语言
  const correction = CORRECTION_PATTERNS.some(p => p.test(candidate.evidence));
  // "Actually, use X instead of Y" → correction=true
  // "Don't use any" → correction=false（这是规则，不是纠正）

  // 3. Reinforcement：历史观察次数 + 当前 user message 中的提及次数
  const reinforcement = Math.max(1, previousReinforcement + matchingUserMessages);

  // 4. 综合评分（仅用于审计，不用于准入决策）
  const score = 0.45                          // 基础分：通过了 strict validation + review
    + Math.min(0.2, reinforcement * 0.05)     // 重复出现的加分
    + evidenceRatio * 0.15                    // evidence 和 content 的比例
    + (durableCategory ? 0.1 : 0)             // rule/decision/preference 更高耐久
    + (correction ? 0.1 : 0);                 // 纠正信号加分

  return { fingerprint, correction, reinforcement, score: Number(score.toFixed(4)) };
}
```

**为什么 score 不作为写入阈值？** 旧系统用浮点 score 做准入决策，但那些 score 的词表、权重都未经校准，会系统性漏掉简洁但重要的短规则。当前系统把 score 作为 provenance metadata（可审计信号），真正的准入决策由 strict validation + review + consolidation 共同决定。

#### Consolidation 分层匹配

```typescript
// consolidation.ts
function planConsolidation(candidate, signals, existing): ConsolidationPlan {
  // 缩小搜索空间：只看同 scope + 同 category 的记录
  const sameCategory = existing.filter(r =>
    r.scope === candidate.scope && r.category === candidate.category
  );

  // ── 第 1 层：精确标题匹配 ──
  const exactIdentity = sameCategory.find(r =>
    r.title.toLowerCase() === candidate.title.toLowerCase()
  );
  if (exactIdentity) {
    if (signals.correction) return { action: "replace", existing: exactIdentity };
    return { action: "skip" };  // 同标题、非纠正 → 不重复创建
  }

  // ── 第 2 层：语义指纹匹配 ──
  const fingerprintMatch = sameCategory.find(r =>
    r.provenance.fingerprint === signals.fingerprint
  );
  if (fingerprintMatch) {
    if (signals.correction) return { action: "replace", existing: fingerprintMatch };
    return { action: "skip" };  // 语义相同 → 不重复创建
  }

  // ── 第 3 层：Jaccard 相似度 ≥ 0.72 ──
  const similar = sameCategory
    .map(r => ({ record: r, score: jaccardSimilarity(candidate, r) }))
    .sort((a, b) => b.score - a.score)[0];
  if (similar && similar.score >= 0.72) {
    if (signals.correction) return { action: "replace", existing: similar.record };
    return { action: "skip" };  // 高相似 → 视为重复
  }

  // ── 第 4 层：无匹配 → 创建新记录 ──
  return { action: "create" };
}
```

**Jaccard 相似度是什么？**

```
Jaccard(A, B) = |A ∩ B| / |A ∪ B|

A = "使用 strict TypeScript" → tokens: ["使用","strict","typescript"]
B = "所有代码使用 TypeScript strict mode" → tokens: ["所有","代码","使用","typescript","strict","mode"]

A ∩ B = {"使用","strict","typescript"}  → 3 个
A ∪ B = {"使用","strict","typescript","所有","代码","mode"} → 6 个

Jaccard = 3/6 = 0.5  → < 0.72, 视为不同记忆
```

**为什么是 0.72？** 这是对真实记忆数据的经验值。太低（0.5）会过度合并不同但相关的规则；太高（0.9）会漏掉明显的重复。0.72 在 precision 和 recall 之间取了一个偏保守的点——宁可多存一条相似的，也不要错误合并。

**为什么 Correction 才能 replace？**

普通的高相似可能只是两个不同的规则：
- "所有 API 返回 JSON 格式" ≠ "Dashboard API 返回 JSON 格式"
- Jaccard 很高 → 但它们是两个不同的规则，不能自动合并

当用户说 "Actually, use X instead of Y" 时：
- 有明确的方向性（X 替换 Y）
- correction signal 检测到这种模式
- 此时在高相似条件下执行 replace 是安全的

### 9.8 Step 7: Transactional Commit（详见 §6.8）

### 9.9 Branch-Local Checkpoint

提取成功后，把 checkpoint 写入 session tree：

```typescript
pi.appendEntry(MEMORY_CHECKPOINT_TYPE, {
  version: EXTRACTOR_VERSION,
  sourceHash: "sha256...",
  lastEntryId: "u15",          // 处理到这里
  branchLeafId: "a15",          // 当前 branch 的叶节点
  savedCount: 2                 // 本批保存了几条
});
```

**为什么 checkpoint 放 session tree 而不是放全局文件？**

Session tree 是 append-only 的树结构。Checkpoint 作为 custom entry 插入：
- 不同 branch 各自有各自的 checkpoint（切换 branch 自然恢复各自的进度）
- Checkpoint 不会进入 LLM context（它是 custom entry，不是 message）
- Crash 后恢复：读取当前 branch 的最后一个 checkpoint → 从那里继续

### 9.10 后台任务的 Snapshot 模式

```typescript
// index.ts - agent_settled handler
const snapshot: ExtractionSnapshot = {
  cwd: ctx.cwd,
  sessionId: ctx.sessionManager.getSessionId(),
  branch: ctx.sessionManager.getBranch(),     // 防御性拷贝
  branchLeafId: ctx.sessionManager.getLeafId(),
  lastProcessedEntryId: findCheckpoint(branch)?.lastEntryId,
  model: ctx.model,                           // 防御性拷贝
  modelRegistry: ctx.modelRegistry,           // 引用（Registry 是长生命周期单例）
};

scheduler.start(snapshot, repository, appendCheckpoint, onSettled);
```

**为什么后台任务不持有 `ctx` 引用？**

`ctx` 是 Extension Context，在 session 切换、reload、fork 后可能失效。如果异步任务持有 `ctx`：
- 任务运行时可能已经换了 session
- `ctx.sessionManager.getBranch()` 可能返回新 session 的数据
- `ctx.model` 可能已经变了

解决方案：在同步阶段（`agent_settled` handler 内）创建不可变 snapshot，后台任务只用 snapshot。这样即使 session 已经结束或切换，任务的身份、branch 和模型都是固定的。

---

## 10. 第 6 层：Working State

### 10.1 三层时间模型

| 层 | 存储位置 | 内容 | 语义 |
|---|---|---|---|
| 长期记忆 | `entries/` | 规则、决策、偏好、知识、事实 | 跨 session 的持久真相 |
| Scratchpad | `working/sessions/{hash}/SCRATCHPAD.md` | 当前请求 + 最近结果 | "刚才卡在哪了" |
| Daily | `daily/YYYY-MM-DD.md` | 每次 settled 的时间线 | "今天做了什么" |

**Working State 和长期记忆是两种完全不同的东西：**

- 长期记忆："这个项目用 PostgreSQL"（持久事实）
- Scratchpad："刚才在修 checkout 的竞态条件，改到 payment.ts 第 340 行"（临时进度）
- Daily："7月26日：修了 checkout 竞态、重构了 payment 模块"（当日摘要）

Working State 的文件不在 `entries/` 目录下，所以 `list()` / `search()` / `buildPrompt()` 不会把它们当长期记忆。只有显式 `SearchMemory(scope=working)` 才会查询。

### 10.2 确定性生成（不调 LLM）

Working State 不需要额外 LLM 调用：

```typescript
function buildWorkingStateUpdate(source, sessionId, now) {
  // 1. 复用 Step 2 的 secret redaction
  const redacted = redactSecrets(source.messages);

  // 2. 取最近一条 user 消息 → currentRequest
  const user = latest(redacted, "user");

  // 3. 取最近一条 assistant 消息 → latestOutcome
  const assistant = latest(redacted, "assistant");

  return {
    currentRequest: bounded(user.content, 4_000),   // 上限 4000 字符
    latestOutcome: bounded(assistant.content, 6_000), // 上限 6000 字符
    sourceEntryIds: [user.entryId, assistant.entryId],
    sessionId, date, updatedAt
  };
}
```

**为什么不调 LLM 做总结？**
- 速度：不需要额外的 API 调用
- 确定性：同样的对话产生相同的结果，可重复
- 不新增事实：直接取原文，不会出现 LLM 总结时的扭曲和幻觉

### 10.3 Branch-local Working Checkpoint

长期记忆和 Working State 使用不同的 checkpoint 类型：
- `triple-pi-memory-checkpoint`：长期提取的进度
- `triple-pi-working-checkpoint`：Working State 的进度

两个 checkpoint 独立管理，互不影响。

### 10.4 Prompt 注入策略

```
before_agent_start 时：
  contextWindow（模型上下文窗口大小）
    → workingCharBudget = 20% × contextWindow, 最小 1000, 最大 8000
    → memoryCharBudget  = 30% × contextWindow, 最小 2000, 最大 12000

  Scratchpad: workingCharBudget × 60% = 4800 字符上限
  Recent Daily: workingCharBudget × 40% = 3200 字符上限
  长期记忆索引: memoryCharBudget = 12000 字符上限
```

Prompt 注入标记：
```
## Persistent Memory
Current project: my-app (my-app-xxx)
- [project/rule] 使用 Strict TypeScript
- [project/decision] 使用 JWT 认证
- [global/preference] 保持回复简洁

## Working State
This is recent, temporary project state. Do not treat it as durable truth.

### Scratchpad
## Current Request
修 checkout 竞态条件...

## Latest Outcome
已修改 payment.ts...
```

注意 Prompt 里明确标注 "Do not treat it as durable truth"——防止模型把临时进度和长期规则搞混。

---

## 11. 安全设计

### 11.1 多层防线

```
第 1 层：文件系统权限
  root 目录 0700（只有 owner 能读写）
  entry 文件 0600（只有 owner 能读写）

第 2 层：Secret Redaction
  发送 LLM 前脱敏（10 种常见 secret 模式）
  LLM 返回后再检测一次

第 3 层：Strict Validation
  evidence 必须是 user message 的逐字子串
  category/scope 必须符合 allowlist
  不允许额外字段

第 4 层：Grounded Review
  Reviewer 只能 keep/remove
  改写内容 → 整批拒绝

第 5 层：人工授权
  SaveMemory 必须用户确认
  无 UI 环境 → fail closed
  归档项目 → 拒绝写入

第 6 层：Fail-Closed
  任何一步失败 → 不写 checkpoint → 下次重试
  绝不静默降级或跳过
```

### 11.2 默认安全原则

- **默认不共享**：project scope 是默认值，global 必须显式指定
- **默认不删除**：归档是 rename，不永久删除
- **默认需要确认**：手动保存弹确认框，冷态恢复弹确认框
- **默认拒绝**：无 UI、项目冷态、项目归档 → 拒绝写入

---

## 12. 为什么不做 X？

### 12.1 为什么不用向量数据库（Pinecone/Chroma/Qdrant 等）？

当前数据规模下（一个项目通常只有几十条记忆），关键词搜索（子字符串匹配）完全够用。引入向量数据库的成本远超收益：

- **运维成本**：需要额外运行一个数据库服务
- **学习成本**：用户需要了解 embedding、chunking、similarity threshold
- **恢复成本**：数据库损坏比 Markdown 文件损坏难恢复
- **审计成本**：不能简单地 `cat` 或 `grep` 查看数据
- **测试成本**：向量搜索的"正确性"更难验证

**但这是一个 conscious tradeoff**：如果未来记忆数量增长到几百条，子字符串搜索的 recall 会明显下降。那时可以引入 FTS（Full-Text Search，如 SQLite FTS5）或 embedding-based 语义搜索。但应该在**有真实测量数据证明当前方案不足后**再引入，而不是提前优化。

### 12.2 为什么不用 Cron 做定时提取？

旧系统用 cron，问题多多（见 §3）。Pi 已经提供了 `agent_settled` 事件——它比 cron 更精确地知道"什么时候该提取"。

### 12.3 为什么 Reviewer 不能自由改写？

自由改写需要"逐句 evidence mapping"——证明改写的每一句话都有对话中的依据。没有这个机制时，改写 = 引入不可验证的内容 = 破坏了 grounding 保证。

### 12.4 为什么 project identity 不基于 Git remote？

Monorepo 场景下，多个子项目共享同一 remote，会导致记忆污染。详见 §5.3。

### 12.5 为什么不用 SQLite 存记忆？

Markdown 文件的优势在当前规模下更明显：
- 人类可读：用 VS Code、vim、cat 直接看
- 可 Git 版本控制：用户可以选择把 `~/.triple-pi/memory-v1/` 纳入备份
- 损坏可局部恢复：一个文件坏了，删掉就行，不影响其他
- 零依赖：不需要 SQLite binding、schema migration

SQLite 的优势（事务、索引、查询）在记忆数量增长到成百上千条时会体现。当前几十条 Markdown 完全够用。

### 12.6 为什么不自动合并相似记忆？

自动合并不可逆。相似的规则可能是两个不同的含义（见 §9.7 中 Jaccard 的例子）。只有用户明确纠正时（"actually, use X instead of Y"）才自动 replace。这是一个 precision-first 的设计选择。

---

## 13. 测试与验证体系

### 13.1 三层测试

| 层 | 命令 | 内容 | 特点 |
|---|---|---|---|
| 确定性测试 | `npm test` | 99 个 vitest 测试 | 无网络，mock 文件系统 |
| Recorded Eval | `npm run eval:recorded` | 18 个 case，FIFO recorded provider | mock LLM，走完整 pipeline |
| Live Eval | `npm run eval:live` | 真实 LLM 调用 | opt-in，需配置 model |

### 13.2 为什么 Recorded 不能证明模型质量？

Recorded Eval 的测试数据是"录制"的——每个 case 的 LLM 输出是预定义的。它验证的是：
- ✅ pipeline 接线正确
- ✅ strict validation 工作正常
- ✅ repository 读写正确
- ✅ consolidation 逻辑正确
- ✅ project isolation 正确

它不能验证：
- ❌ LLM 是否真的能从真实对话中提取出正确记忆
- ❌ LLM 是否会产生幻觉 evidence
- ❌ Review 是否真的能识别噪声

Live Eval 才是测模型质量的——用真实模型、多轮运行、统计 mean/variance/worst F1。

### 13.3 CI 发布门

```yaml
# .github/workflows/ci.yml
- npm ci --ignore-scripts
- npm run typecheck
- npm test  # 包含 99 个单元测试 + recorded eval
```

Live Eval 不进 CI——它依赖外部 API key、网络、成本、随机性。只用于发布前/模型升级时的统计验证。

---

## 14. 大厂面试 Q&A 逐题详解

### 基础架构类

**Q1: 整个系统怎么工作的？一句话概括。**

> 通过 Pi 的 Extension API，在每个 Session 的 `before_agent_start` 注入记忆索引到 system prompt，在 `agent_settled` 异步从对话中提取记忆。记忆按项目 cwd 隔离，存在本地 Markdown 文件里。手动保存需要用户确认，自动提取经过 secret redaction → strict validation → grounded review → consolidation 六步管线。

**Q2: 为什么选择文件系统而不是数据库？**

> 当前规模下（每项目几十条记忆），Markdown 文件的人类可读性、零运维、可 Git 备份的优势大于数据库的查询性能。文件写入用 temp+rename 保证原子性，用 proper-lockfile 做并发控制。未来如果记忆规模增长到成百上千条，可以考虑 SQLite FTS 或向量搜索。

**Q3: 怎么保证两个 Pi 进程同时写不冲突？**

> 用 `proper-lockfile` 做进程级文件锁。写操作获取排他锁，读操作不持锁（因为 atomicWrite 保证单个文件读到的永远是完整内容）。锁有 stale timeout（10 秒）防止死锁。并发 20 个写入者不丢 entry/index 的测试已通过。

**Q4: 写入中途崩溃了数据会损坏吗？**

> 不会。用 temp+rename 做原子写入——内容先写 `.tmp` 临时文件，再 `fs.rename` 到正式路径。`rename` 是操作系统的原子操作。最坏情况是 `.tmp` 残留（`finally` 块会清理），正式文件永远是完整的。

### 项目隔离类

**Q5: 怎么保证项目 A 的记忆不出现在项目 B？**

> 项目身份由 cwd 的 SHA-256 决定。不同 cwd → 不同 project ID → 不同的文件系统目录（`projects/<project-A-id>/` 和 `projects/<project-B-id>/`）。搜索和 prompt 构建都在当前项目的目录 + global 目录中进行，物理隔离。

**Q6: Monorepo 里两个子项目怎么隔离？**

> 用 cwd 而非 git remote 做 identity——即使共享同一个 git remote，`/workspace/monorepo/packages/backend` 和 `.../frontend` 的 cwd 不同，被识别为不同项目。如果要共享某些记忆，应该在 frontend 项目中显式指定 global scope。

**Q7: 同一台机器上 clone 两次同一个仓库会共享记忆吗？**

> 不会，`/home/user/project-v1` 和 `/home/user/project-v2` 是不同的 cwd → 不同 project ID → 独立记忆。这是正确行为——两个 clone 可能在不同开发阶段，规则不应该混用。

### 自动提取类

**Q8: 为什么 evidence 必须是 user message 的逐字子串？**

> 这是整个系统"可信度"的核心。LLM 可能幻觉 evidence——编造一个看似合理的引用。强制验证 evidence 在 user 原文中逐字出现，保证每一条自动记忆都有真实对话依据。Assistant 内容不能做证据，因为 assistant 本身可能扭曲、幻觉或只是建议。

**Q9: 为什么 LLM 输出有问题要整批拒绝而不是逐条接受？**

> 自动后台任务没有人在场审核。如果 10 条里有 1 条 malformed、1 条 evidence 对不上、1 条带 secret——你不知道剩下 7 条是不是真的安全。在基础协议稳定之前，整批 fail-closed 比部分接受更安全。失败后不写 checkpoint，下个 `agent_settled` 会重试。

**Q10: 两次 LLM 调用（Extraction + Review）不觉得浪费吗？**

> Extraction 负责"从对话中找出可能重要的内容"，Review 负责"判断这些内容是否真的值得长期保留"。两个任务本质不同。Review 用更严格的约束（只能 keep/remove），reviewer 能看到完整的 user message 上下文，可以识别"用户只是在讨论一个概念但并没有承诺使用它"这种断章取义的情况。成本方面，对小 session 确实有影响，但记忆的质量比省一次 API 调用重要。

**Q11: Score 为什么只是记录在 provenance 里而不做阈值判断？**

> 旧系统的阈值（>0.6 才写入）会漏掉简洁但重要的规则——比如"use strict TypeScript"这种短句可能因为缺少重复出现而 score 偏低。Block 4 把 score 降级为审计信号，真正的准入决策由 strict validation + reviewer keep/remove + consolidation 共同决定。

**Q12: 怎么保证同一段对话不会重复提取？**

> 用 sourceHash 做幂等。每次提取前计算当前对话增量的 SHA-256 hash。提取成功后写入 manifest 文件（`extractions/{project-id}/{sourceHash}.json`）。下次看到相同的 sourceHash → 跳过。即使 crash 后重试，也不会重复计数或重复写入。

### 生命周期类

**Q13: 为什么 30 天冷态而不是直接删除？**

> 30 天在真实开发中很常见——季度项目轮换、等依赖、休假。冷态给用户一个显式决策点：恢复（说明项目还有用）或拒绝（保持冷态）。如果直接删除，用户发现后无法恢复。

**Q14: 为什么 90 天归档用 rename 而不是 copy+delete？**

> rename 在同一个文件系统内是原子操作——目录指针从一个位置变更到另一个位置。不会有"copy 了一半 crash 了导致两个目录都不完整"的问题。而且 rename 只修改目录 metadata，不移动实际文件数据，瞬间完成。

**Q15: 用户拒绝恢复冷态项目后，global memory 为什么还可见？**

> 用户拒绝的是"这个特定项目的陈旧上下文"不是"我的全局沟通偏好"。Project 和 Global 生命周期独立——一个冷项目不应该冻结所有跨项目偏好。

### 安全类

**Q16: Secret 检测能覆盖所有格式吗？**

> 不能。10 种正则模式覆盖了最常见的 AWS/GitHub/Google/Slack/JWT/Bearer/Private Key/Password 格式，但组织自定义 token 格式肯定有遗漏。README 明确声明了这个限制。完全防御需要组织级策略（pre-commit hook、secret scanning）。

**Q17: 为什么 Send to LLM 之前要做 redaction？**

> 对话内容会被发送到 LLM Provider 的服务器（OpenAI/Anthropic 等）。如果对话里包含了 API key 或 token，相当于把 secret 发给了第三方。Redaction 在发送前把匹配的内容替换为 `[REDACTED_SECRET]`，LLM 收到的是已脱敏的文本。

**Q18: SaveMemory 为什么需要代码级确认而不是依赖 prompt 指令？**

> Prompt 指令不是安全边界。LLM 可能被 jailbreak、可能误解、可能对"记住"这个词过度敏感。`ctx.ui.confirm()` 是代码级的授权门——无论 LLM 怎么决定，最终必须人类点击 Yes 才会写盘。无 UI 时 fail-closed。

### 设计取舍类

**Q19: 这个系统最大的 tradeoff 是什么？**

> Precision over Recall。宁可漏掉一些信息（下次可以手动保存或重试），也绝不能写入未经证实的错误记忆（会跨 session 反复污染决策）。strict validation 的 evidence 校验、reviewer 的 keep-only 权限、consolidation 的 0.72 Jaccard 阈值都是这个原则的体现。

**Q20: 有什么你不满意的？**

> 1. 没有 metrics/telemetry——提取失败率、review 过滤率都没暴露。2. 字符上限可能截断关键信息（虽然可以环境变量调）。3. 没有处理多开发者共享记忆的场景（目前是纯单用户设计）。4. Release candidate 还没有经过真实企业环境的多进程长期 soak test。

**Q21: 如果让你重新设计，你会改什么？**

> 1. 从第一天就引入 structured metrics/logging。2. Source Hash 用 content-addressed 而不是 entry-ID-based，这样跨 branch 也能做幂等。3. Project identity 支持显式 alias 配置（"这两个 cwd 是同一个项目"）。4. 加一个轻量的 SQLite 做索引层，解决记忆数量增长后的搜索问题。

---

## 15. 面试回答模板

### 开场（30秒）

> "我给 Pi Coding Agent 做了一个跨 Session 的 Memory 系统。它通过 Pi 的 Extension API 接入，不修改 Pi 源码。核心功能是：Agent 能记住用户的项目规则、偏好和决策，在下次启动时自动加载。支持手动保存和从对话中自动提取。"

### 架构（45秒）

> "系统分四层：最下面是文件系统存储，每个项目按 cwd hash 隔离，用 Markdown 文件存记忆，temp+rename 做原子写入，proper-lockfile 做并发控制。往上是生命周期管理，30/90 天的 hot/cold/archive 状态机。再往上是两条写入路径——SaveMemory 手动保存经过用户确认；自动提取在 agent_settled 后异步执行。最上层是 Pi Extension 接入，注册 lifecycle hooks 和 tools。"

### 提取链路（重点，2分钟）

> "自动提取有六步。第一步构建提取源——从 session tree 取 checkpoint 之后的增量对话，计算 sourceHash 做幂等。第二步 secret redaction——10 种正则给 API key/token 脱敏。第三步调 LLM 提取候选。第四步 strict validation——这是最硬的门。每一条候选必须恰好 6 个字段，category/scope 在 allowlist 里，最关键的是 evidence 必须在原始 user message 里逐字存在——LLM 不能编证据。第五步 grounded review——再调一次 LLM，但它只能 keep/remove，禁止改写内容。第六步 consolidation——确定性规则做分层匹配去重：先看标题完全相同，再看语义指纹，再看 Jaccard 相似度 ≥ 0.72。每一步失败都是 fail-closed，拒绝整批不写 checkpoint，下次重试。"

### 亮点（30秒）

> "最大的亮点是 grounding——自动记忆的风险在于 LLM 幻觉，我用 evidence 逐字校验 + reviewer 禁止改写 + 事务性写入三层保证每一条记忆都有对话原文支撑。测试分三层：99 个确定性单元测试做 CI 门，18 个 recorded case 验证接线，live LLM eval 独立测模型质量。"

### 主动提限制（15秒）

> "当前限制是没有向量检索，搜索是子字符串匹配；secret 检测是正则，不覆盖自定义格式；还没有真实企业环境的多进程 soak test。这些是后续迭代的方向。"

---

## 附录：代码文件索引

| 文件 | 行数 | 职责 |
|---|---|---|
| `extensions/memory/index.ts` | ~450 | Extension 入口：tools, hooks, commands, SessionState, ExtractionScheduler |
| `extensions/memory/domain.ts` | ~60 | 类型定义：MemoryRecord, MemoryScope, MemoryCategory |
| `extensions/memory/repository.ts` | ~820 | 存储核心：CRUD, 锁, 原子写入, 事务, 生命周期 |
| `extensions/memory/project-identity.ts` | ~35 | 项目身份：cwd → SHA-256 → stable ID |
| `extensions/memory/working-state.ts` | ~160 | 工作状态：Scratchpad + Daily 的生成和渲染 |
| `extensions/memory/extraction/source.ts` | ~90 | 提取源：从 branch 构建增量对话 |
| `extensions/memory/extraction/pipeline.ts` | ~120 | 管线：secret redaction + strict validation |
| `extensions/memory/extraction/provider.ts` | ~50 | LLM 调用：复用 Pi ModelRegistry |
| `extensions/memory/extraction/review.ts` | ~90 | Grounded Review：keep/remove 二次审核 |
| `extensions/memory/extraction/signals.ts` | ~65 | 信号计算：fingerprint, correction, reinforcement, score |
| `extensions/memory/extraction/consolidation.ts` | ~60 | 确定性合并：分层匹配 + replace/create/skip |
| `extensions/memory/extraction/coordinator.ts` | ~130 | 协调器：串联整个提取链路 |
| `eval/cases.ts` | ~75 | Eval 用例定义 |
| `eval/metrics.ts` | ~80 | Eval 指标计算 |
| `eval/recorded-cases.ts` | ~40 | Recorded Eval 的录制数据 |
| `test/memory/*.test.ts` | 15 文件 | 99 个确定性测试 |
