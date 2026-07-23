# Triple-pi

基于 [Pi Agent Runtime](https://github.com/earendil-works/pi) 的个人 Coding Agent，增加 OpenClaw 风格的跨会话持久化记忆。

**不改 Pi 一行源码。** 通过 Pi Extension 机制集成。

## 项目结构

```
Triple-pi/
├── extensions/memory/             ← Pi Extension（Pi TUI 自动加载）
│   ├── index.ts                   ← SaveMemory + SearchMemory 工具
│   └── storage.ts                 ← 项目隔离存储 + 休眠跟踪
├── scripts/
│   ├── extract.mjs                ← 5 阶段异步提取管道
│   ├── install-cron.mjs           ← 自动安装每日提取 cron
│   └── remove-cron.mjs            ← 移除 cron
├── pi-runtime/                    ← Pi 源码（git submodule，只读）
├── INTERVIEW.md                   ← 面试答辩手册（15 版本迭代 + 7 个 trade-off）
├── package.json
└── README.md
```

## 快速开始

```bash
git clone --recurse-submodules https://github.com/npm-DreaMaX/Triple-pi.git
cd Triple-pi
npm run setup    # 构建 Pi + 安装 Extension + 设置每日自动提取 cron
```

配置 API Key（选一种）：

```bash
# 环境变量
export DEEPSEEK_API_KEY=sk-xxx

# 或 Pi 内置登录
cd pi-runtime && ./pi-test.sh   # 进入后输入 /login
```

启动：

```bash
cd pi-runtime && ./pi-test.sh
```

**每天凌晨 3 点自动提取记忆**（`npm run setup` 已安装 cron，无需手动操作）。手动提取：`npm run extract`。

## 与 Pi 的关系

| 层 | 提供方 | 修改？ |
|----|--------|--------|
| Agent Loop | Pi Runtime | ❌ |
| LLM 多 Provider | Pi AI | ❌ |
| 工具系统 | Pi Coding Agent | ❌ |
| Session 管理 + Compaction | Pi Coding Agent | ❌ |
| 持久化记忆层 | **Triple-pi** | ✅ |
| Memory 提取管道 | **Triple-pi** | ✅ |

## Memory 架构

借鉴 OpenClaw 的 Dreaming 系统，适应个人开发者规模。

### 提取管道（5 阶段）

```
Phase 1 (Light Sleep)    → LLM 扫描 transcript，提取候选 + 证据引用
Phase 2 (Scoring)        → 6 维加权评分（同 OpenClaw 权重）
Phase 2.5 (Deep Sleep)   → 二次 LLM 审核：去噪、合并相似、过滤可发现信息
Phase 3 (Merge)          → Jaccard 确定性去重
Phase 4 (REM)            → 跨主题关联（> 500 条记忆后启用）

30 天不活跃的项目 → 记忆自动删除
```

### 存储结构

```
~/.triple-pi/memory/
├── global/                            ← 跨项目（沟通风格、通用偏好）
│   ├── MEMORY.md
│   └── knowledge/ preference/ decision/ rule/ fact/
├── github-com-xxx-project-a/          ← 项目 A（仅在 cd 到该项目时加载）
└── home-user-projects-b/              ← 项目 B
```

### 5 种记忆类型

| 类型 | 用途 | 示例 |
|------|------|------|
| **knowledge** | 用户知识水平 | "用户已读过 agent-loop.ts 源码" |
| **preference** | 工作偏好 | "偏好简洁回复，代码注释用英文" |
| **decision** | 技术决策及原因 | "选 JWT 而非 session，因为多服务无状态" |
| **rule** | 行为约束 | "禁止 git push 到 main" |
| **fact** | 不在代码中的上下文 | "项目三个月后迁移到 Go" |

### 核心 Trade-off

| 选择 | 为什么 |
|------|------|
| 异步提取而非实时写入 | LLM 实时调用会过度写入垃圾 |
| 文件存储而非数据库 | 人类可编辑、Git 跟踪、零运维 |
| 确定性评分 + Deep Sleep LLM 审核 | 各做各擅长的：评分快，审核准 |
| 项目隔离而非全局池 | 做 React 时不加载 Pi 的记忆 |
| 30 天休眠删除 | 个人项目周期短，废弃自动清理 |
| Pi Extension 不改源码 | Pi 升级不受影响 |

详见 [INTERVIEW.md](./INTERVIEW.md) — 完整 15 版本迭代记录、设计决策、面试答辩话术。

## License

MIT
