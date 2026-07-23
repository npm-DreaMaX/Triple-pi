# Triple-pi

基于 [Pi Agent Runtime](https://github.com/earendil-works/pi) 的个人 Coding Agent，增加了跨会话持久化记忆。

## 项目结构

```
Triple-pi/
├── pi-runtime/                  ← Pi 源码（git submodule，不改）
├── src/
│   ├── memory/
│   │   ├── types.ts             ← 类型定义 + 分类指南
│   │   └── index.ts             ← 核心：CRUD / 搜索 / 去重 / system prompt
│   ├── tools/
│   │   ├── save-memory.ts       ← Pi 工具：写入记忆
│   │   └── search-memory.ts     ← Pi 工具：检索记忆
│   └── main.ts                  ← 入口：组装 + 启动
├── INTERVIEW.md                 ← 面试答辩手册（设计决策 + 问答话术）
├── package.json
├── tsconfig.json
└── README.md
```

## 快速开始

```bash
# 1. 克隆（必须带 --recurse-submodules，否则 pi-runtime 是空的）
git clone --recurse-submodules https://github.com/npm-DreaMaX/Triple-pi.git
cd Triple-pi

# 2. 一键安装 + 构建 Pi + 构建 Triple-pi
npm run setup

# 3. 配置 LLM API Key（以 DeepSeek 为例）
export DEEPSEEK_API_KEY=sk-xxx

# 4. 运行
npm start
```

## 与 Pi 的关系

Pi 提供 Agent Loop、LLM 抽象、工具系统。Triple-pi 在此基础上增加持久化记忆层。

| 层 | 提供方 | Triple-pi 是否修改 |
|----|--------|-------------------|
| Agent Loop (双层 while 循环) | Pi Runtime | ❌ |
| LLM 抽象 (多 Provider) | Pi AI | ❌ |
| 工具系统 (Read/Write/Edit/Bash/Grep) | Pi Coding Agent | ❌ |
| Session 管理 + Compaction | Pi Coding Agent | ❌ |
| 持久化记忆 (跨 Session) | **Triple-pi** | ✅ |
| Memory 工具 (SaveMemory/SearchMemory) | **Triple-pi** | ✅ |

## Memory 设计

借鉴 OpenClaw 的索引 + 分文件模式：

- `~/.triple-pi/memory/MEMORY.md` — 索引（< 200 tokens），始终在 system prompt
- `~/.triple-pi/memory/{preference,decision,rule,fact}/` — 具体记忆，按需读取

四个分类：preference（偏好）、decision（决策）、rule（规则）、fact（事实）

**为什么不是全量注入？**
- Token 预算。一年积累 500 条记忆 → 全量注入浪费 token 且稀释关键信息
- 索引告诉 Agent 它知道什么；需要时再读具体内容

**为什么不用数据库？**
- 人类可读可编辑（vim 直接改）
- Git 可追踪
- 零依赖（个人 Agent，< 500 条记忆不需要数据库）

详见 [INTERVIEW.md](./INTERVIEW.md)

## License

MIT
