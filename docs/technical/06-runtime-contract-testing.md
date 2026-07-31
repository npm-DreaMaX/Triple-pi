# 06. Runtime 契约测试：从 Faux Provider 到真实 AgentSession

> **校正声明**：本章按“缺陷修复后的目标语义”撰写。本文中的 Pi Runtime 类型名、事件顺序、provider 接口、AgentSession 工厂参数、工具事件结构与测试辅助函数均须由最终源码和锁定依赖版本校正。若伪实现与真实 runtime 不一致，以最终源码与可执行契约测试为准，并应同步更新本文。

## 1. 为什么普通单元测试不够

Reviewer 的核心风险不在某个纯函数，而在多个边界组合：

```text
应用代码
  │ createAgentSession(options)
  v
Pi Agent Runtime
  │ 调用 provider / 注册工具 / 维护事件和状态
  v
Provider 实现
  │ 返回文本、tool call、错误、流中断
  v
Parser + Aggregator + Cleanup
```

只 mock `SubAgentManager.review()` 最终返回值，只能证明调用方会处理一个人为对象，不能证明：

- 真正的 `createAgentSession` 接受这些 options；
- resource loader 确实关闭扩展与上下文加载；
- 最终工具集合真的是只读白名单；
- provider 输出如何进入 session；
- timeout/abort/dispose 的真实顺序；
- runtime 升级后事件名或状态机是否漂移。

因此需要分层契约测试：

```text
L0 纯函数单元测试
L1 Faux provider + 真实 AgentSession（进程内契约）
L2 真实 provider + 真实 AgentSession（opt-in 冒烟/质量测试）
L3 故障注入与资源清理测试
```

---

## 2. Test Double 分类

“Mock”常被泛指所有替身，但不同替身验证的问题不同。

| 类型 | 行为 | 适用 |
|---|---|---|
| Stub | 固定返回值 | parser、单一路径 |
| Spy | 记录调用 | dispose/abort 调用次数 |
| Mock | 预设交互顺序并断言 | 小范围协议 |
| Fake/Faux | 可运行的简化实现 | provider 状态、流、错误注入 |
| Simulator | 更完整模拟外部系统 | 多事件、多轮工具调用 |

本项目适合 Faux Provider：它不访问网络，但实现 runtime 所期望的 provider 接口，允许真实 AgentSession 完整运行。

关键区别：

```text
错误做法：mock createAgentSession() -> 返回 { prompt: vi.fn() }
正确方向：真实 createAgentSession() + faux provider
```

前者绕过了最想验证的边界。

---

## 3. 契约是什么

契约不是“函数被调用一次”，而是跨组件不变量。

### 3.1 Session 创建契约

```text
给定：合法 model、registry、workingDirectory、resource loader
当：创建 reviewer session
则：
  - session 可启动并接收 prompt；
  - session history 与主会话隔离；
  - 不加载 project extension/skill/context；
  - 最终工具集是允许集的子集；
  - 结束时可 abort/dispose。
```

### 3.2 Provider 契约

```text
给定：runtime 发来的模型请求
Faux provider 必须：
  - 接受最终渲染后的消息/系统提示；
  - 以 runtime 支持的事件或完整响应形态返回；
  - 能表达文本完成、tool call、provider error、hang、abort；
  - 记录请求，供测试断言；
  - 不静默容忍未知请求形态。
```

### 3.3 Reviewer 结果契约

```text
合法 JSON     -> success/partial
非法 JSON     -> parse-failed
合法 JSON 错 schema -> schema-failed
provider throw -> provider-failed
deadline       -> timeout
parent abort   -> aborted
快照变化       -> worktree-changed
```

任何失败都不得映射成 `success + findings=[]`。

---

## 4. Faux Provider 设计

### 4.1 脚本化响应队列

一个实用 fake 应采用 FIFO script：

```ts
type FauxStep =
  | { kind: "text"; text: string; usage?: Usage }
  | { kind: "tool-call"; name: string; input: unknown }
  | { kind: "error"; error: Error }
  | { kind: "delay"; ms: number; then: FauxStep }
  | { kind: "hang" }
  | { kind: "stream"; chunks: string[]; failAt?: number };

class FauxProvider {
  readonly requests: ProviderRequest[] = [];
  private readonly steps: FauxStep[];

  async run(request: ProviderRequest, signal?: AbortSignal) {
    this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (!step) throw new Error("Unexpected provider request");
    return executeStep(step, signal);
  }

  assertDrained() {
    if (this.steps.length !== 0) {
      throw new Error(`Unused faux steps: ${this.steps.length}`);
    }
  }
}
```

具体 provider 方法名和响应形态必须由最终 Pi Runtime 接口校正。这里真正重要的是四个属性：

1. **严格 FIFO**：额外或缺失请求立即暴露；
2. **可观察**：保存真实 runtime 请求；
3. **可取消**：delay/hang 响应 AbortSignal；
4. **可组合**：支持多轮工具调用和流式错误。

### 4.2 为什么不能“无限返回最后一个响应”

宽松 fake 常写成：

```ts
return responses.shift() ?? responses.at(-1)
```

这会隐藏无限循环：runtime 即使意外发出第 100 次请求，测试仍然“成功”。目标 fake 必须在队列耗尽时失败。

### 4.3 请求匹配

可以为每一步增加 matcher：

```ts
interface ExpectedRequest {
  assert(request: ProviderRequest): void;
  reply: FauxStep;
}
```

但不要断言整段序列化 prompt 的每个字节，否则无关格式变化会造成脆弱测试。优先断言 load-bearing 字段：

```text
- model identity
- reviewer system policy 存在
- task/diff/memory 分区存在
- 写工具 schema 不存在
- 当前 chunk 标识正确
- 对话历史没有主 session 内容
```

同时保留少量 golden/snapshot 测试检查完整渲染，以发现协议漂移。

---

## 5. 用真实 AgentSession 做进程内测试

### 5.1 测试拓扑

```text
Vitest
  │
  ├─ 临时 Git repo（真实 fs + 真实 git）
  ├─ Faux model/provider（无网络）
  ├─ 真实 ModelRegistry（注册 faux model）
  ├─ 真实 createAgentSession
  └─ 真实 SubAgentManager + parser + aggregator
```

这类测试既确定性，又能覆盖 runtime 接线。

### 5.2 最小 happy path

概念代码：

```ts
it("runs reviewer through a real AgentSession", async () => {
  const repo = await createTempGitRepo();
  await repo.write("src/a.ts", "export const n = 1\n");
  await repo.commitAll("base");
  await repo.write("src/a.ts", "export const n = 0\n");

  const faux = new FauxProvider([
    {
      kind: "text",
      text: JSON.stringify({
        status: "issues_found",
        summary: "发现除零风险。",
        findings: [{
          severity: "high",
          file: "src/a.ts",
          line: 1,
          description: "n 被设为 0，作为除数时会产生错误。",
        }],
      }),
    },
  ]);

  const { model, registry } = registerFauxModel(faux);
  const manager = makeManager({ model, modelRegistry: registry });
  const outcome = await manager.review({ cwd: repo.path, task: "审查当前改动" });

  expect(outcome.kind).toBe("success");
  expect(faux.requests).toHaveLength(1);
  faux.assertDrained();
});
```

最终测试应使用项目真实构造路径，避免另造一套仅测试使用的 session factory。

### 5.3 验证工具能力

至少采用两种独立方法：

**静态观察**：检查发给模型的工具 schema。

```ts
expect(toolNames(faux.requests[0])).toEqual(["find", "grep", "ls", "read"]);
```

**动态挑战**：让 faux provider 请求写工具。

```text
provider 返回：tool_use(name="write", ...)
期望：runtime 不执行；结果为 provider/protocol failure 或工具不存在
并断言临时仓库字节完全未变
```

若 fake provider 无法产生 runtime 原生 tool-call 事件，这一测试应在最终接口校正时调整，而不能降级成“检查 prompt 里写了只读”。

### 5.4 验证资源隔离

在临时仓库放置诱饵：

```text
.pi/extensions/evil-extension...
AGENTS.md / CLAUDE.md / context file
skill manifest
prompt template
```

测试目标：

```text
- faux provider 收到的 system/messages 不包含诱饵标记；
- tool list 不包含诱饵扩展注册的工具；
- session 创建过程不执行诱饵副作用。
```

这比断言 `noExtensions: true` 被传入更强，因为它验证最终效果。

---

## 6. 真实 Provider 测试与真实 AgentSession 测试不是一回事

### 6.1 Faux + Real Session

验证：

- 本地 runtime 接口；
- prompt/工具接线；
- 状态传播；
- timeout 和清理；
- parser、chunk、coverage。

它不验证：模型是否真的能发现 bug。

### 6.2 Real Provider + Real Session

验证：

- 认证与 provider 可用性；
- 真实模型输出适配；
- 模型遵守 JSON 协议与只读角色的概率；
- latency、token、finding quality。

它不应作为默认 CI 门，因为存在：

- 网络与配额波动；
- 模型非确定性；
- 成本；
- provider 模型版本漂移；
- 认证环境差异。

### 6.3 Opt-in 原则

```text
没有显式 model 配置 -> 不猜模型，不触网，报告配置缺失
有显式 opt-in       -> 运行 live test
认证/provider 失败   -> infra failure，不计为 semantic pass/fail
```

真实测试必须记录：模型 ID、provider、runtime 版本、commit、dirty 状态、prompt hash、case hash、时间、usage。

---

## 7. Fault Injection

故障注入不是随意 `throw new Error()`；它要精准落在协议边界。

### 7.1 故障点地图

```text
Git collect
  ├─ process spawn fail
  ├─ non-zero exit
  ├─ timeout
  └─ malformed path/output

Session create
  ├─ invalid model
  ├─ resource loader fail
  └─ runtime API drift

Provider
  ├─ throw before response
  ├─ reject after partial stream
  ├─ hang until abort
  ├─ malformed tool call
  └─ empty completion

Parser
  ├─ invalid JSON
  ├─ code fence edge case
  ├─ extra fields
  ├─ bad enum/line
  └─ cross-field contradiction

Aggregation
  ├─ one chunk fails
  ├─ duplicates
  ├─ conflicting severity
  └─ late completion after timeout

Integrity
  ├─ external worktree write
  ├─ symlink swap
  └─ snapshot read failure

Cleanup
  ├─ abort throws
  ├─ dispose rejects
  └─ double dispose
```

### 7.2 注入 API

不要在生产代码散布 `if (process.env.FAIL_X)`。使用依赖边界：

```ts
interface ReviewerDeps {
  runGit: GitRunner;
  createSession: SessionFactory;
  snapshot: Snapshotter;
  clock: Clock;
  setTimer: TimerFactory;
}
```

生产使用真实实现，测试注入 failpoint。这样不会把测试开关带入生产安全边界。

### 7.3 流式中途失败

模型已经输出半个 JSON 后断流：

```text
{"status":"issues_found","summary":"...","findings":[
                                      ^ connection reset
```

目标语义是 provider-failed 或 parse-failed，取决于 runtime 是否把传输错误保留下来。优先保留更靠近根因的 provider-failed；绝不能把已收到的 partial text 补成合法 JSON。

### 7.4 Hanging provider 与虚拟时钟

测试 timeout 时，应避免真的等待几秒。用 fake timers，但要谨慎：真实 runtime 的 Promise、流和 AbortSignal 可能混合宏任务/微任务。

```ts
vi.useFakeTimers();
const pending = manager.review({ timeoutMs: 5_000, ... });
await vi.advanceTimersByTimeAsync(5_001);
expect(await pending).toEqual({ kind: "timeout" });
```

随后还要：

```text
- resolve faux provider 的晚到 promise；
- flush microtasks；
- 断言 outcome 没改变；
- 断言 dispose 恰好一次；
- 断言没有 unhandled rejection。
```

### 7.5 Cleanup failure 的优先级

假设主操作成功，但 `dispose()` 失败。可选策略：

1. 把整体升级为 failure；
2. 返回 success，但记录 cleanup warning；
3. 若清理失败可能泄露敏感资源，则 fail-closed。

必须显式选定并测试。不能让 `finally` 中的异常随机覆盖原始 provider failure。推荐保留主因并附加 cleanup cause：

```ts
class ReviewExecutionError extends Error {
  constructor(
    readonly primary: Error,
    readonly cleanup?: Error,
  ) { super(primary.message); }
}
```

---

## 8. 并发、顺序与幂等性

### 8.1 Chunk 并发测试

若 N 个 chunk 并行执行：

```text
wall latency ≈ max(L_i) + aggregation
```

若串行：

```text
wall latency ≈ Σ L_i + aggregation
```

测试不能依赖哪个 chunk 先完成。结果合并应按稳定 chunk ID 或输入顺序，而不是 Promise 完成顺序。

### 8.2 一次终态

可把 reviewer run 建模为状态机：

```text
created -> running -> {success | partial | failed | timeout | aborted}
                         terminal states
```

不变量：

```text
terminal transition count = 1
```

可用 latch 保护：

```ts
function settleOnce<T>(resolve: (v: T) => void) {
  let settled = false;
  return (v: T) => {
    if (settled) return false;
    settled = true;
    resolve(v);
    return true;
  };
}
```

但优先让结构化 Promise 控制流天然保证一次 resolve，避免 callback 共享可变状态。

### 8.3 Dispose 幂等性

测试至少覆盖：

```text
dispose after success
abort then dispose
timeout and late completion
session create partially succeeds then throws
caller abort simultaneous with deadline
```

理想契约：`dispose()` 可重复调用且无副作用；若 runtime 不保证，manager 自己必须保证只调用一次。

---

## 9. 契约测试的反模式

### 9.1 复制生产实现到测试

测试中重新实现 `buildReviewerInput`，然后比较两份相同逻辑，只会让同一个错误同时存在。测试应从外部可观察结果断言。

### 9.2 只断言 happy-path status

```ts
expect(result.status).toBe("success")
```

不足以发现：coverage 丢失、工具越权、快照变化、telemetry 错误、raw parse failure 被吞。

### 9.3 过度 snapshot

完整 provider request snapshot 可发现漂移，但会把 UUID、时间、绝对临时路径变成噪声。先规范化动态字段：

```ts
normalizeRequest(req, {
  cwd: "<TMP_REPO>",
  requestId: "<ID>",
  timestamp: "<TIME>",
});
```

### 9.4 Fake 比真实实现更宽松

如果 fake 接受真实 provider 不接受的参数，测试会虚假通过。每次 runtime/provider 依赖升级，应先运行真实 AgentSession 契约测试，并校正 fake。

---

## 10. 推荐测试矩阵

| 测试 | Session | Provider | 网络 | 目标 |
|---|---|---|---:|---|
| parser unit | 无 | stub text | 否 | JSON/schema |
| chunk unit | 无 | 无 | 否 | 边界与 coverage 计划 |
| manager faux happy | 真实 | faux | 否 | 全接线 |
| tool allowlist | 真实 | faux tool call | 否 | capability |
| resource isolation | 真实 | faux | 否 | loader 配置效果 |
| provider error | 真实 | faux throw | 否 | failure 传播 |
| timeout/late result | 真实 | faux hang | 否 | deadline/cleanup |
| partial chunks | 真实 | FIFO mixed | 否 | coverage |
| worktree mutation | 真实 | delayed faux | 否 | 快照检测 |
| live smoke | 真实 | 真实 | 是 | 认证/协议 |
| live eval | 真实 | 真实 | 是 | finding quality |

---

## 11. 面试问答

### Q1：为什么要 Faux Provider，而不是直接 mock manager？

**答**：Mock manager 绕过了 AgentSession、resource loader、工具注册、provider 请求形态和清理状态机。Faux provider 把网络与模型随机性替换掉，但保留真实 runtime 边界，因此能在 CI 中确定性验证接线。

### Q2：Faux provider 能证明真实模型质量吗？

**答**：不能。它证明协议和控制流。真实模型的 recall、precision、JSON 遵循率、latency 必须由 opt-in live eval 测量。两者验证的问题不同，不能互相替代。

### Q3：怎样防止 fake 隐藏无限请求循环？

**答**：使用严格 FIFO script；队列耗尽时立即失败；测试结束时 `assertDrained()`，同时设置 session 最大轮数或总 deadline。

### Q4：怎样证明真实 AgentSession 没加载扩展？

**答**：不仅检查构造参数，还在临时仓库放入能注册独特工具或写标记的诱饵扩展，断言最终工具 schema、provider prompt 和文件系统都没有诱饵效果。

### Q5：Timeout 测试最容易漏什么？

**答**：只断言按时返回，没处理晚到 provider completion。应在 timeout 后主动让 late promise 完成，flush 微任务，并断言终态不变、无未处理拒绝、dispose 恰好一次。

### Q6：Provider 中途断流应算 parse failure 还是 provider failure？

**答**：若 runtime 保留传输错误，应优先 provider-failed，因为它是根因；只有完整传输成功但文本非法才是 parse-failed。最终分类必须由真实 runtime 行为校正。

### Q7：为什么不用 live test 作为唯一 E2E？

**答**：Live test 混合基础设施、非确定性和语义质量。失败时难定位，且会产生 flake 和成本。分层后，faux+real session 负责协议，live 负责质量。

### Q8：依赖升级时先看什么？

**答**：先跑真实 AgentSession 契约测试：session factory、provider 请求、工具事件、abort/dispose。然后校正 fake，再跑全部确定性测试和小规模 live smoke。

---

## 12. 最终源码校正清单

- Pi Runtime 中 provider 的准确接口、流事件和 usage 字段；
- `createAgentSession`、model registry、resource loader 的真实构造方法；
- session prompt/subscribe/abort/dispose 的准确调用顺序；
- 工具调用不存在时 runtime 的真实 failure 表达；
- faux provider 是否复用已有 `pi-ai` 测试设施，而非重复造轮子；
- fake timers 与 runtime 定时器是否兼容；
- `provider-failed` 与 `parse-failed` 在流中断场景的最终边界；
- cleanup error 的产品语义；
- live tests 的显式 opt-in 环境变量与退出码。
