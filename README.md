# Triple-pi

基于 [Pi Agent Runtime](https://github.com/earendil-works/pi) 的项目隔离、跨 Session Coding Agent Memory Extension。

**不修改 Pi Runtime 源码。** Memory 通过 Pi Extension lifecycle、tool system、session tree 和 ModelRegistry 接入。

## 当前状态

版本：`1.0.0-rc.1`

已实现并经过确定性测试：

- global + per-project 长期记忆
- SaveMemory 写入前用户确认
- 新 Session 在第一次模型请求前召回
- 30 天冷态恢复确认、90 天无损归档
- 当前 branch 的异步提取和 branch-local checkpoint
- Pi 原生 Provider/Auth/OAuth/custom-provider 路径
- user-only evidence、secret redaction、Grounded Review
- correction、project-scoped reinforcement、确定性 consolidation
- Scratchpad + 按日 Daily Working State
- recorded/full-stack/live/product 三层 Eval

完整重做过程、工程取舍、验收数据和面试问答见 [MEMORY_REBUILD.md](./MEMORY_REBUILD.md)。

## 安装

要求：

- Node.js `>=22.19.0`
- Git submodule
- 至少一个通过 Pi 配置可用的模型

```bash
git clone --recurse-submodules https://github.com/npm-DreaMaX/Triple-pi.git
cd Triple-pi
npm run setup
```

`setup` 会：

1. 构建本仓库固定版本的 Pi Runtime；
2. 安装根依赖；
3. 将 `extensions/memory` 安装为 `~/.pi/agent/extensions/memory` symlink；
4. 运行只读 Memory 自检。

它**不会**安装 cron、删除旧数据或自动运行 Live Eval。

如果 `~/.pi/agent/extensions/memory` 已是普通文件/目录，安装器会拒绝覆盖。

## 启动 Pi

```bash
cd pi-runtime
./pi-test.sh
```

通过 Pi 的 `/login` 或 Pi 支持的环境变量配置 Provider。Triple-pi 不直接读取 `auth.json`、不猜 Provider，也不把其他 Provider 的 key 发往错误 endpoint。

## Memory 行为

### 手动保存

用户明确要求“记住”时，Agent 可调用 `SaveMemory`。每次写盘前 Pi UI 会展示完整 scope/category/title/content，并要求用户确认。无交互 UI 时默认拒绝写入。

### 自动提取

在 `agent_settled` 后异步执行：

```text
current branch delta
→ secret redaction
→ extraction
→ strict user evidence validation
→ Grounded Review
→ correction/reinforcement/consolidation
→ transactional repository commit
→ branch-local checkpoint
```

只处理当前 session tree branch，不扫描或猜测“最新 JSONL”。

### 生命周期

| 闲置时间 | 行为 |
|---|---|
| 0–30 天 | hot：正常注入和搜索 |
| >30–90 天 | cold：再次打开时询问是否恢复 |
| >90 天 | 自动移动到 archive，不删除 |

归档记忆默认不进入 prompt 或普通搜索，可使用 `/memory-restore` 恢复，或 `SearchMemory(includeArchived=true)` 显式查询。

### Working State

```text
projects/<project-id>/working/sessions/<session-hash>/SCRATCHPAD.md
projects/<project-id>/daily/YYYY-MM-DD.md
```

Working State 是临时进度数据，不属于长期 Memory，不参与长期 consolidation。SearchMemory 只有显式 `scope=working` 才查询它。

## 存储

默认根目录：

```text
~/.triple-pi/memory-v1/
├── global/entries/
├── projects/<project-id>/
│   ├── entries/
│   ├── MEMORY.md
│   ├── project.json
│   ├── working/
│   └── daily/
├── archive/projects/
├── extractions/
├── signals/
└── working-manifests/
```

Entry Markdown 是权威数据，`MEMORY.md` 是可重建索引。目录权限为 0700，文件为 0600；写入使用 repository lock 和 temp+rename。

旧 `~/.triple-pi/memory/` 不迁移、不读取。

## 运维

### 状态检查

```bash
npm run memory:status
npm run memory:status -- --cwd=/path/to/project
```

输出 extension 安装状态、schema、project ID、hot/cold/archive、条目数、manifest 数和 root mode；不输出 Memory 正文。

Pi 内也可使用：

```text
/memory-status
/memory-archive
/memory-restore
```

### Reset

先查看目标：

```bash
npm run memory:reset:dry-run
```

交互确认删除：

```bash
npm run memory:reset
```

自动化环境必须显式授权：

```bash
npm run memory:reset -- --yes
```

默认 Reset 只将当前项目的 active/archive、extraction manifest、signals 和 working manifests 移入 quarantine。`--scope=all` 处理整个 canonical root，`--scope=legacy` 处理旧 root；都不删除 Pi sessions、auth 或 Extension 安装。Quarantine 不会自动 purge。

旧版本安装过 cron 时，可显式移除：

```bash
npm run cron:remove
```

## 测试与 Eval

```bash
npm run typecheck
npm test
npm run eval:recorded
```

Live Eval 是显式 opt-in：

```bash
TRIPLE_PI_EVAL_MODEL=provider/model \
TRIPLE_PI_EVAL_RUNS=3 \
npm run eval:live
```

- deterministic/recorded：无网络，作为 CI 门
- live：真实模型统计，不进入 CI
- product：memory off/manual/async 的用户可观察行为对照
- legacy：`npm run eval:legacy` 仅供历史分析，不是发布信号

## 数据与安全边界

- 自动提取会把经过 secret redaction 的当前 branch 文本发送给当前 Pi 模型 Provider。
- 提取和 Review 都复用当前 Provider/Auth/Base URL/headers/env。
- 常见 API key、GitHub PAT、AWS key、JWT、Bearer、Slack token、private key 和 password assignment 会在发送前脱敏，并在模型输出后再次检测。
- Secret 检测不能保证覆盖所有私有格式；处理敏感代码库前应确认 Provider 与组织政策。
- 没有向量数据库；本地 Markdown 优先保证审计、恢复和零运维。

## 当前限制

- 当前 correction 只自动替换同 scope/category 的确定性高相似目标；模糊冲突保守地保留为独立记录。
- Working State 是最近 user/assistant 的确定性投影，不是完整任务规划器。
- Live Eval 需要用户明确选择模型和凭证。
- Release candidate 尚未执行真实企业多进程长期 soak test。

## 文档

- [MEMORY_REBUILD.md](./MEMORY_REBUILD.md)：逐 Block 重做、问题证据、设计决策、验收与面试问答
- [INTERVIEW_MEMORY.md](./INTERVIEW_MEMORY.md)：历史 Memory 设计文档；以重做文档和当前代码为准
- [INTERVIEW_EVAL.md](./INTERVIEW_EVAL.md)：历史 Eval 设计文档；旧“10/10”不再作为当前质量信号

## License

MIT
