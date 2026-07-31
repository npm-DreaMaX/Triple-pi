# 13　实验与练习

本文是一组面向 Triple-pi 当前实现的可复现实验。目标不是演示界面，而是直接观察 Git 采集、提示词注入、模型替身、调度器交错、补偿事务、证据约束、修订快照、评估公式、安装器符号链接边界与性能分布。

所有结论均以当前仓库中的实现和测试为准。实验若揭示“设计意图”和“当前行为”不一致，应把它记录为观测结果，不要为了得到预期输出而修改生产代码。

---

## 13.1 实验约定

### 13.1.1 环境基线

在仓库根目录执行：

```bash
node --version
git --version
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short
npm run typecheck
```

当前项目要求 Node.js `>=22.19.0`。实验中的 TypeScript 直跑命令统一使用：

```bash
node --experimental-strip-types
```

确定性测试统一使用：

```bash
npx vitest run <测试文件>
```

### 13.1.2 隔离原则

1. Git 破坏性实验必须在 `mktemp -d` 创建的临时仓库中执行。
2. Memory 存储根必须显式指向临时目录，不要使用默认的 `~/.triple-pi/memory-v1/`。
3. 安装器实验必须同时隔离 `PI_CODING_AGENT_DIR` 和启动器使用的用户主目录。
4. Live Eval 会触网且产生费用，不属于本章确定性验收的必需项。
5. 性能实验应在功能测试通过之后执行；错误结果上的“高吞吐”没有意义。
6. 实验数据、临时脚本和输出应放在仓库外；实验结束后再次检查 `git status --short`。

建议定义：

```bash
export REPO_ROOT="$(git rev-parse --show-toplevel)"
export LAB_ROOT="$(mktemp -d)"
printf 'REPO_ROOT=%s\nLAB_ROOT=%s\n' "$REPO_ROOT" "$LAB_ROOT"
```

结束时：

```bash
git -C "$REPO_ROOT" status --short
rm -rf "$LAB_ROOT"
```

### 13.1.3 结果记录模板

每个实验至少记录：

```text
commit：
Node.js：
Git：
操作系统与文件系统：
实验参数：
原始输出：
是否满足验收条件：
与参考思路的差异：
```

不要只保存最后一行“通过”。竞态和性能实验必须保存事件序列或原始样本。

---

## 13.2 实验一：真实 Git staged、unstaged 与 untracked 采集

### 目标

1. 在真实临时 Git 仓库中构造 staged、unstaged、untracked 三类变化。
2. 验证 `collectGitChanges()` 使用的三个 Git 视图：`git diff --cached`、`git diff`、`git ls-files --others --exclude-standard -z`。
3. 观察同一文件同时存在 staged 与 unstaged 修改时的当前去重行为。
4. 验证 `ChangeFile.status` 的排序和二进制跳过语义。

生产入口位于 `extensions/subagent/review-core.ts`，结果类型为 `CollectGitChangesResult`，文件对象类型为 `ChangeFile`。

### 步骤

#### 步骤一：创建真实仓库和基线提交

```bash
GIT_LAB="$LAB_ROOT/git-state"
mkdir -p "$GIT_LAB"
git -C "$GIT_LAB" init
git -C "$GIT_LAB" config user.name lab
git -C "$GIT_LAB" config user.email lab@example.invalid
printf 'line-1\nline-2\nline-3\n' > "$GIT_LAB/mixed.txt"
printf 'base\n' > "$GIT_LAB/unstaged.txt"
git -C "$GIT_LAB" add mixed.txt unstaged.txt
git -C "$GIT_LAB" commit -m baseline
```

#### 步骤二：在同一文件上制造 staged 与 unstaged 两层状态

```bash
printf 'line-1\nstaged-value\nline-3\n' > "$GIT_LAB/mixed.txt"
git -C "$GIT_LAB" add mixed.txt
printf 'line-1\nstaged-value\nunstaged-value\n' > "$GIT_LAB/mixed.txt"
printf 'base\nworking-tree-only\n' > "$GIT_LAB/unstaged.txt"
printf 'untracked text\n' > "$GIT_LAB/new.txt"
printf '\x00\x01\x02' > "$GIT_LAB/blob.bin"
```

先直接观察 Git 真值：

```bash
git -C "$GIT_LAB" status --short
git -C "$GIT_LAB" diff --cached --no-ext-diff
git -C "$GIT_LAB" diff --no-ext-diff
git -C "$GIT_LAB" ls-files --others --exclude-standard -z | xargs -0 -n1 printf 'untracked=%s\n'
```

`mixed.txt` 的短状态应为 `MM`：索引相对 `HEAD` 有变化，工作树相对索引也有变化。

#### 步骤三：调用生产采集函数

把以下脚本写到仓库外：

```bash
cat > "$LAB_ROOT/inspect-git.mjs" <<'EOF'
import { collectGitChanges } from "REPO/extensions/subagent/review-core.ts";

const result = collectGitChanges(process.argv[2]);
if (!result.ok) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(result.changes.map((change) => ({
  path: change.path,
  status: change.status,
  binary: change.binary,
  unreadable: change.unreadable,
  skipped: change.skipped,
  diffChars: change.diff.length,
  contentChars: change.content?.length ?? 0,
})), null, 2));
EOF
perl -pi -e 's#REPO#'"$REPO_ROOT"'#g' "$LAB_ROOT/inspect-git.mjs"
node --experimental-strip-types "$LAB_ROOT/inspect-git.mjs" "$GIT_LAB"
```

如果环境不允许从仓库外导入 TypeScript，可把脚本中的绝对导入保留，并从仓库根启动 Node；不要把脚本移入版本库。

#### 步骤四：检查同文件双层变化

执行：

```bash
node --experimental-strip-types "$LAB_ROOT/inspect-git.mjs" "$GIT_LAB" \
  | tee "$LAB_ROOT/git-observation.json"
```

比较 `mixed.txt` 在原始两个 diff 中均出现，与 `collectGitChanges()` 返回数组中的出现次数。

#### 步骤五：验证排序和二进制状态

检查以下顺序约束：

```text
staged 在 unstaged 之前；
unstaged 在 untracked 之前；
blob.bin 为 untracked、binary=true、skipped=true；
new.txt 为 untracked、binary=false、skipped=false。
```

### 预期

1. Git 原生命令能分别看到 `mixed.txt` 的 staged diff 和 unstaged diff。
2. 当前 `collectGitChanges()` 先加入 staged 文件；处理 unstaged 时，如果同一路径已经以 staged 状态存在，会跳过该路径的整个 unstaged 表示。
3. 因而 `mixed.txt` 在 `changes` 中只出现一次，状态为 `staged`；其工作树相对索引的额外修改未作为独立 `ChangeFile` 保留。
4. 独立的 `unstaged.txt` 以 `unstaged` 出现。
5. `new.txt` 和 `blob.bin` 以 `untracked` 出现；含空字节的 `blob.bin` 被判为二进制并跳过。

这里必须区分“Git 采集命令执行了两种 diff”和“结果模型完整保留了同一文件的两层 diff”。前者成立，后者在当前实现中不成立。

### 验收

- [ ] 临时仓库中真实出现 `MM mixed.txt`。
- [ ] 保存了 cached diff 和 working-tree diff，能指出两者的基线不同。
- [ ] `collectGitChanges()` 返回 staged、unstaged、untracked 三种状态中的至少一个实例。
- [ ] 明确记录 `mixed.txt` 只保留 staged 视图的当前行为。
- [ ] 二进制文件满足 `binary=true` 与 `skipped=true`。
- [ ] 原仓库 `git status --short` 未增加实验文件。

### 参考思路

Git 的三个比较面分别是：

```text
staged：   HEAD ↔ index
unstaged：index ↔ working tree
untracked：不在 index 中的工作树路径
```

`collectGitChanges()` 的数组不是 Git 状态的无损事件流。它以路径为键，在 staged 优先的策略下压掉同路径的 unstaged 项。因此 Reviewer 输入上的 `staged > unstaged > untracked` 不仅是排序规则，也会在同路径冲突时影响覆盖范围。若要评估审查完整性，应以原始两个 diff 为对照，而不能仅统计 `ChangeFile[]` 的路径数。

---

## 13.3 实验二：`before_agent_start` 提示词捕获与预算

### 目标

1. 不启动真实模型，直接捕获 Memory extension 对 `before_agent_start` 的返回值。
2. 区分长期记忆进入 `systemPrompt` 与 Working State 进入隐藏 custom message 的路径。
3. 验证 project/global 可见性、冷态门控和字符预算。
4. 证明提示词捕获是生命周期处理器输出的确定性观测，不需要网络。

### 步骤

#### 步骤一：运行现有集成断言

```bash
npx vitest run test/memory/extension.integration.test.ts
npx vitest run test/memory/extension-lifecycle.integration.test.ts
```

重点定位以下断言：

```text
长期记忆标题出现在 result.systemPrompt；
Working State 出现在 customType=triple-pi-working-context 的消息；
project A 的记忆不进入 project B；
冷态拒绝恢复时 project 不注入，但 global 仍注入。
```

#### 步骤二：构造捕获器

参考 `test/memory/extension.integration.test.ts`，创建一个仅在内存中记录 handler 的 `ExtensionAPI` 替身：

```ts
const handlers = new Map<string, (...args: any[]) => any>();
const pi = {
  registerTool() {},
  registerCommand() {},
  appendEntry() {},
  on(event: string, handler: (...args: any[]) => any) {
    handlers.set(event, handler);
  },
} as ExtensionAPI;
```

用临时 root 创建 `FilesystemMemoryRepository`，调用 `registerMemoryExtension(pi, repository)`，然后取得：

```ts
const beforeAgentStart = handlers.get("before_agent_start")!;
```

保存一条 project 规则和一条 global 偏好，再传入固定上下文：

```ts
const event = { systemPrompt: "BASE" };
const ctx = {
  cwd,
  model: { contextWindow: 32000 },
  sessionManager: {
    getSessionId: () => "prompt-capture",
  },
};
const captured = await beforeAgentStart(event, ctx);
```

将 `captured.systemPrompt`、`captured.messages`、各自字符数输出到临时文件。

#### 步骤三：验证预算函数

当前预算由上下文窗口决定：

```text
workingCharBudget = clamp(floor(contextWindow × 0.2), 1000, 8000)
memoryCharBudget  = clamp(floor(contextWindow × 0.3), 2000, 12000)
```

分别用 `contextWindow` 为 `4000`、`32000`、`200000` 捕获结果。长期记忆索引由 `buildPrompt()` 限制；Working State 再按 60% scratchpad、40% daily 分配。

#### 步骤四：验证注入通道

对捕获结果执行以下分类：

```text
systemPrompt：BASE + Persistent Memory 索引；
messages：Working State custom message；
Working State 文本必须带 derived、temporary、untrusted 语义标记；
长期记忆正文不一定完整进入 systemPrompt，索引提示 SearchMemory 加载全文。
```

#### 步骤五：验证旧 custom message 的替换

在 event 中预置一条旧的 `triple-pi-working-context` 和一条无关 custom message。再次调用 handler，统计相同 `customType` 的数量。当前实现会过滤旧 Working State，再追加新值，避免每轮累积。

### 预期

1. 捕获过程不调用 Provider，也不需要 API key。
2. 长期 Memory 的索引追加到原始 system prompt 后方。
3. Working State 不进入 system prompt，而作为 `type: "custom"`、`customType: "triple-pi-working-context"` 的消息返回。
4. project 记忆受 cwd 身份和生命周期门控；global 记忆跨项目可见且不随 project 冷态冻结。
5. 空 Memory 时 system prompt 保留原值；空 Working State 时不必返回 working custom message。

### 验收

- [ ] 保存了完整捕获对象，而不只是布尔断言。
- [ ] 能指出每一段上下文的来源、信任等级和注入通道。
- [ ] 三个 `contextWindow` 输入的预算符合 clamp 公式。
- [ ] 旧 Working State custom message 不发生重复累积。
- [ ] 整个实验未发起模型请求。

### 参考思路

提示词捕获的观察边界是 extension handler 的返回值。它比抓取终端输出更精确，因为可以区分 `systemPrompt` 和 `messages`。长期 Memory 是持久化、经过边界校验的数据；Working State 是确定性派生但未验证的临时上下文，两者不应合并成同一可信通道。

`MemoryPrompt.count` 表示可见记录总数，不等于真正写入 prompt 的行数。受 `maxEntries` 和 `maxChars` 限制时，索引可能截断，但 count 仍可大于已注入条目数。验收时应分别统计总记录数和实际索引行数。

---

## 13.4 实验三：Fake Provider、请求捕获与 fail-closed

### 目标

1. 用 fake provider 代替真实模型，同时走 `extractCandidateJson()` 或 `runExtraction()` 的生产接线。
2. 捕获 Provider 收到的 model、system prompt、messages、tools、认证头和 `AbortSignal`。
3. 验证合法输出、空数组、非 JSON、非 stop 结束原因和 provider 异常。
4. 区分“录制输出验证接线”和“真实模型质量评估”。

### 步骤

#### 步骤一：运行已有 coordinator 测试

```bash
npx vitest run test/memory/extraction-coordinator.test.ts
npx vitest run test/eval/recorded-full-stack.test.ts
```

第一个测试用 Vitest 模块替身隔离 provider/reviewer；第二个测试使用 FIFO recorded provider 走完整管线。

#### 步骤二：定义 fake stream

Fake provider 的最小行为应与生产调用兼容：

```ts
const calls: unknown[] = [];
const fakeProvider = {
  streamSimple(model, context, options) {
    calls.push({ model, context, options });
    return {
      async result() {
        return {
          stopReason: "stop",
          content: [{ type: "text", text: JSON.stringify(candidateArray) }],
        };
      },
    };
  },
};
```

Fake registry 至少提供：

```ts
const fakeRegistry = {
  async getApiKeyAndHeaders() {
    return { ok: true, apiKey: "fake", headers: { "x-lab": "1" }, env: {} };
  },
  async getProviderAuth() {
    return undefined;
  },
  getProvider() {
    return fakeProvider;
  },
};
```

`candidateArray` 的每一项必须严格只有六个字段：`category`、`title`、`content`、`evidence`、`sourceEntryId`、`scope`。

#### 步骤三：捕获请求结构

调用 `extractCandidateJson()` 后检查：

```text
context.systemPrompt 包含只从 USER 文本提取、evidence 逐字引用、优先 project 等规则；
context.messages 只有一个 user message；
该 user message 将原始段落编码为 <message entryId="..." role="...">；
context.tools 是空数组；
options.signal 与调用方传入的对象相同；
认证材料来自 registry，而不是脚本硬编码到 model 中。
```

#### 步骤四：验证 secret 预处理

通过 `runExtraction()` 输入一段含测试用假凭证模式的用户消息。检查 fake provider 捕获的 transcript 中只出现 `[REDACTED_SECRET]`，不出现原字符串。随后让 fake provider 错误地把占位符放入 candidate evidence，验证 `validateCandidates()` 拒绝整批。

#### 步骤五：建立失败矩阵

依次设置 fake provider 行为：

| 场景 | fake 行为 | 预期 |
|---|---|---|
| 合法候选 | `stopReason="stop"`，合法 JSON | 保存并生成 checkpoint |
| 合法空集 | `[]` | 不保存，仍生成 checkpoint |
| 非 JSON | 文本 `not-json` | 抛 `CandidateValidationError`，不写记录、不推进 checkpoint |
| schema 多字段 | candidate 增加 `extra` | strict validation 失败 |
| 非 stop | `stopReason="error"` | provider 层抛错 |
| provider 异常 | `result()` 抛错 | 整次 extraction fail-closed |
| 已取消 | 调用前 abort | 不调用 provider，状态为 `aborted` |

每个场景使用新的临时 repository root，避免前一轮 manifest 造成幂等短路。

### 预期

1. fake provider 能复现真实接口形状，但不会触网。
2. 只有 `stopReason === "stop"` 才读取文本结果。
3. 合法 `[]` 表示模型成功判断无候选，因此可以推进 checkpoint。
4. provider、解析、schema、证据或 secret 校验失败均不得写入记录，也不得伪装成合法空集。
5. 相同 `sourceHash` 成功提交后再次执行会在 provider 之前被 manifest 幂等短路。

### 验收

- [ ] 至少捕获一次完整 `streamSimple` 入参。
- [ ] `tools=[]` 且 signal 完整传播。
- [ ] secret 原文未进入 fake provider 捕获内容。
- [ ] 合法空集与 provider 失败产生不同结果。
- [ ] 同 source replay 时 provider 调用次数保持一次。
- [ ] 未设置任何真实 Provider 凭证。

### 参考思路

Fake provider 的职责是控制不确定边界，而不是复制模型推理。实验应保留真实的 source 构建、脱敏、严格校验、review、consolidation 和 repository commit。若把 `runExtraction()` 整体 mock 掉，只能测试调用次数，不能证明接线。

Recorded Eval 同理：它证明“已知正确输出能通过生产管线并得到正确指标”，不证明模型能从自然语言中生成该输出。真实质量只能由 opt-in Live Eval 测量，并且基础设施失败必须与语义失败分开。

---

## 13.5 实验四：Scheduler deferred 竞态与 generation 交错

### 目标

1. 用手工 deferred promise 精确控制 `ExtractionScheduler` 的完成顺序。
2. 观察运行任务、pending snapshot、`generation`、abort 和 checkpoint commit 的交错。
3. 验证 `cancel()`、`bumpGeneration()`、`shutdown()` 的差异。
4. 检测 tree switch 时旧 pending snapshot 是否会在新 generation 下重新启动。

### 步骤

#### 步骤一：实现 deferred 控制器

在临时 Vitest 文件中定义：

```ts
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
```

用 `vi.mock()` 替换 `runExtraction()`，每次调用都返回一个独立 deferred，并记录 snapshot 与 signal：

```ts
const calls: Array<{ snapshot: any; signal: AbortSignal; gate: ReturnType<typeof deferred> }> = [];
```

必须在导入 `ExtractionScheduler` 前完成模块 mock。

#### 步骤二：基线串行化

事件序列：

```text
t0：start(A)，A 立即成为 current task；
t1：start(B)，B 进入 pending，不启动第二个 extraction；
t2：resolve(A)，A 完成；
t3：finally 取出 B 并启动；
t4：resolve(B)，B 完成。
```

记录：

- `runExtraction` 调用次数；
- checkpoint append 顺序；
- `onSettled` 次数；
- 每个 signal 是否 aborted。

#### 步骤三：`cancel()` 交错

事件序列：

```text
start(A) → start(B) → cancel() → resolve(A)
```

当前 `cancel()`：

```text
generation += 1；
abort current；
clear pending；
clear currentJob。
```

验证 A checkpoint 不提交，B 不启动。

#### 步骤四：`bumpGeneration()` 交错

事件序列：

```text
start(A-old-tree)
start(B-old-tree)，B 进入 pending
bumpGeneration()
resolve(A-old-tree)
观察 finally
若 B 启动，再 resolve(B-old-tree)
```

保存实际事件日志，例如：

```text
start:A:g0
queue:B
bump:g1
abort:A
settle:A:no-checkpoint
start:B:g1
settle:B:checkpoint
```

不要预先把期望写成“pending 一定清除”。当前 `bumpGeneration()` 只递增 generation 并 abort current，没有清空 pending。A 的 checkpoint 会因 generation 不匹配被挡住；但 finally 仍可能把旧树 B 作为下一任务，以新 generation 重新启动。这个实验的目的正是检测该 stale pending 窗口。

#### 步骤五：`shutdown()` 超时

让 fake `runExtraction()` 永不 resolve，调用 `shutdown()` 并测量返回时间。当前实现等待当前 task 或 1000ms 超时中的较早者。验收允许事件循环调度误差，不要断言恰好 `1000.000ms`。

### 预期

#### 基线

- 任意时刻最多一个 `runExtraction()` 活动实例。
- 后到 snapshot 覆盖 `pending`，不是无界队列。
- 当前任务 finally 后启动最新 pending。

#### `cancel()`

- 当前 signal 被 abort。
- generation 失配阻止旧 checkpoint。
- pending 清空，不会自动重启。

#### `bumpGeneration()`

- 当前 signal 被 abort。
- 当前任务 checkpoint 被 generation guard 阻止。
- 当前实现保留 pending；旧 pending 可能在 finally 中以新 generation 启动并提交。若观测到这一序列，应将实验判为“竞态已复现”，而不是把它误判为测试失败。

#### `shutdown()`

- pending 清空。
- 当前任务收到 abort。
- 最长约一秒后调用方返回；协作式取消不等于强制终止底层工作。

### 验收

- [ ] 使用 deferred 控制顺序，而不是依赖随机 `setTimeout`。
- [ ] 事件日志同时包含 snapshot 名、generation 语义、abort 状态和 checkpoint。
- [ ] 基线证明调度器是单飞加一个 pending 槽。
- [ ] `cancel()` 场景中 B 未启动。
- [ ] `bumpGeneration()` 场景明确记录旧 pending 的当前行为。
- [ ] 没有用“测试跑一百次没失败”代替确定性交错。

### 参考思路

调度器正确性不能只看 promise 最终是否 resolve。需要把安全条件拆成：

```text
C1：同一时刻至多一个 active task；
C2：旧 generation 的 checkpoint 不发布；
C3：tree switch 后旧 branch snapshot 不重新进入执行；
C4：shutdown 后不再启动 pending；
C5：diagnostics 回调不得反向抛错破坏调度器。
```

当前 checkpoint guard 检查 generation、sessionId、branchLeafId 和 aborted，但 guard 只约束“发布 checkpoint”，不约束“是否启动旧 snapshot”。因此 C2 可以成立而 C3 仍不成立。竞态分析必须把执行资格和提交资格分开。

---

## 13.6 实验五：补偿事务 fault injection

### 目标

1. 对 `saveExtractionBatch()` 的有序写入点进行确定性故障注入。
2. 验证 entry、revision、reinforcement、project metadata、manifest 的发布顺序。
3. 检查逆序 rollback 和 `rollbackErrors` 附加信息。
4. 明确 temp+rename、批量补偿事务与 ACID 事务的边界。

### 步骤

#### 步骤一：准备基线记录

创建临时 repository root，先保存一条可被 replacement 的 project 记录，并保存初始内容、目录树和文件 hash：

```text
head entry：旧内容
revision：尚无或已有历史
reinforcement：可选旧计数
manifest：不存在
```

使用 64 位小写十六进制 sourceHash。

#### 步骤二：建立注入器

实验代码可以在测试环境中包装实例的私有方法；这是故障注入，不是生产调用接口：

```ts
const repoAny = repository as any;
const originalAtomicWrite = repoAny.atomicWrite.bind(repository);
let writeOrdinal = 0;
repoAny.atomicWrite = async (file: string, content: string) => {
  writeOrdinal += 1;
  events.push({ phase: "before", writeOrdinal, file });
  if (writeOrdinal === failAt) {
    throw new Error(`FAULT_AT_${failAt}`);
  }
  await originalAtomicWrite(file, content);
  events.push({ phase: "after", writeOrdinal, file });
};
```

如果 TypeScript private 编译约束阻止访问，使用 `(repository as unknown as Record<string, any>)["atomicWrite"]`。实验脚本仍放仓库外。

#### 步骤三：枚举事务写序

构造至少一条 replace 和一条 create，并带 reinforcement update。根据事件日志确认逻辑顺序：

```text
1. revision snapshot；
2. authoritative head entries；
3. reinforcement.json；
4. project.json；
5. extraction manifest，最后发布；
6. MEMORY.md 派生索引，在事务成功后重建，失败可忽略。
```

注意当前实现可能在正式 write phase 前调用一次 `writeActiveMetadataUnlocked()`。因此不要只依赖理论序号；应先执行无故障基线，以实际事件日志建立本版本 fault-point 映射。

#### 步骤四：逐点注入

对 `failAt=1..N` 每次使用全新临时 root：

1. 建立相同基线；
2. 保存事务前所有权威文件的内容 hash；
3. 注入第 N 次 `atomicWrite` 失败；
4. 调用 `saveExtractionBatch()`；
5. 捕获原始异常和 `error.rollbackErrors`；
6. 重新读取记录、manifest、reinforcement、revision 目录和 project metadata；
7. 检查是否残留 `.tmp` 文件。

#### 步骤五：注入 rollback 二次失败

让 forward write 在某一点失败，同时让 rollback 恢复某个既有文件时再次失败。预期原始错误仍被抛出，并附带：

```ts
(error as any).rollbackErrors
```

不要让 rollback 错误覆盖最初故障，否则会丢失真正的触发原因。

#### 步骤六：检查幂等发布点

无故障运行一次后：

```text
manifest 必须存在；
再次提交相同 sourceHash 返回空数组；
head updatedAt 不应再次变化；
Provider 上层可通过 hasExtractionSource() 在调用前短路。
```

### 预期

1. manifest 是幂等发布点，最后写入。
2. manifest 之前失败时，同一 sourceHash 后续仍可重试。
3. 已被覆盖的 entry、revision、reinforcement 按备份尽量恢复；新建文件在 rollback 时删除。
4. 原子写采用同目录临时文件、`rename`、最终 `chmod 0600`，finally 删除临时文件。
5. 派生 `MEMORY.md` 失败不否定权威 entry 的成功。
6. rollback 是 best-effort 补偿；若 rollback 自身失败，异常携带 `rollbackErrors`，系统不能宣称 ACID。

### 验收

- [ ] 先从无故障事件建立本版本写点编号。
- [ ] 每个 fault point 使用独立 repository root。
- [ ] 事务失败后不存在误发布的 sourceHash manifest。
- [ ] 既有 head 内容在可成功 rollback 的场景恢复。
- [ ] `.tmp` 文件不残留。
- [ ] 至少复现一次 rollback 二次失败并保留原始错误。
- [ ] 报告中明确区分权威 entry、幂等 manifest 和派生 index。

### 参考思路

单文件 `atomicWrite()` 提供的是可见性原子性：读者看到旧文件或新文件，不看到半写文件。它没有执行 `fsync(temp)` 和 `fsync(parent directory)`，因此不保证断电持久性。

批量提交则是补偿事务：先备份，顺序写，失败后逆序恢复。它没有数据库日志、隔离级别或崩溃后自动恢复过程。注入器应检查业务不变量，而不是套用 ACID 术语：

```text
T1：无 manifest 时允许重试；
T2：manifest 存在时该 source 已发布；
T3：任何单个 entry 文件始终可完整解析；
T4：索引损坏不隐藏权威 entry；
T5：rollback 失败必须可诊断。
```

---

## 13.7 实验六：scope 与 evidence 真值边界

### 目标

1. 验证 automatic scope guard 的真值关系。
2. 验证 evidence 必须来自指定 user entry 的逐字子串。
3. 验证 assistant-only、大小写变化、幻觉引用、redaction placeholder 和 secret 的拒绝路径。
4. 观察 `ScopeDecision.requested` 在当前调用链中的信息损失边界。

### 步骤

#### 步骤一：运行严格校验测试

```bash
npx vitest run test/memory/extraction-pipeline.test.ts
npx vitest run test/memory/extraction-coordinator.test.ts
```

#### 步骤二：列出 scope 真值矩阵

用以下输入调用 `resolveAutomaticScope()`：

| candidate scope | evidence | 预期 resolved |
|---|---|---|
| project | `Across all my projects...` | project |
| global | `Use pnpm in this repository.` | project |
| global | `Across all my projects, use pnpm.` | global |
| global | `所有项目都使用 pnpm。` | global |
| global | `以后每个项目使用 pnpm。` | global |

可执行命令：

```bash
node --experimental-strip-types --input-type=module -e '
import { resolveAutomaticScope } from "./extensions/memory/validation.ts";
for (const [scope, evidence] of [
  ["project", "Across all my projects, use pnpm."],
  ["global", "Use pnpm in this repository."],
  ["global", "Across all my projects, use pnpm."],
  ["global", "所有项目都使用 pnpm。"],
]) console.log(scope, "=>", resolveAutomaticScope(scope, evidence), evidence);
'
```

#### 步骤三：建立 evidence 反例集

对同一 source 分别提交：

| 反例 | `sourceEntryId` | evidence | 结果 |
|---|---|---|---|
| 正例 | user entry | user 原文逐字子串 | 接受 |
| assistant-only | assistant entry | assistant 原文 | 拒绝 |
| 幻觉 | user entry | 原文不存在 | 拒绝 |
| 大小写变化 | user entry | 仅大小写不同 | 拒绝 |
| 跨 user entry 拼接 | 任一 user entry | 两条消息片段拼接 | 拒绝 |
| 占位符 | user entry | `[REDACTED_SECRET]` | 拒绝 |
| provider 回传凭证 | user entry | 命中 secret pattern | 拒绝 |

`includes()` 是区分大小写的逐字子串检查，不是规范化或语义匹配。

#### 步骤四：检查 provenance

成功 extraction 后读取 `record.provenance`，验证：

```text
evidence[0].quote 为原文；
evidence[0].sourceEntryId 指向 user；
evidence[0].role 固定为 user；
quoteHash 为 evidence 文本 SHA-256 的前 16 位；
scopeDecision 包含 requested、resolved、reason。
```

#### 步骤五：观察 requested scope 边界

让 Provider 请求 `scope="global"`，但 evidence 不含跨项目表达。`validateCandidates()` 会先把候选 scope 降为 project；coordinator 后续基于已经解析后的 candidate 构造 `ScopeDecision`。因此当前落盘结果可能表现为：

```text
requested=project
resolved=project
reason=default-project
```

而不是保留原始模型请求 `global` 和 `missing-cross-project-evidence`。记录实际值，并注明这是“类型可以表达”与“当前调用链实际保留”之间的差异。

### 预期

1. manual save 显式 global 与 automatic extraction 的 global guard 不同；自动路径要求跨项目 evidence。
2. global evidence 缺失时自动降为 project，而不是整条拒绝。
3. evidence 只信 user message，且必须位于指定 `sourceEntryId` 对应消息中。
4. reviewer 只能 keep/remove，不得改写 evidence、scope、category、title 或 content。
5. 当前 eval 匹配与生产 evidence validator 不是同一严格度：生产写入要求证据存在；`evaluateRecords()` 对 provenance 中 evidence 缺失的记录仍可能允许匹配。

### 验收

- [ ] scope 矩阵五行全部有实际输出。
- [ ] evidence 正例与至少五个反例均被执行。
- [ ] 成功记录的 quoteHash 可独立重算。
- [ ] 明确区分 manual scope 和 automatic scope。
- [ ] 报告包含 requested scope 当前信息损失的观测。

### 参考思路

这里有三道独立边界：

```text
Provider 输出意图
  ↓ strict candidate schema
用户原文证据边界
  ↓ automatic scope guard
持久化 provenance
```

不能把 `scope="global"` 当作授权，也不能把 assistant 对用户意图的转述当作证据。scope 决策依赖 evidence 文本本身，而非标题或 content。只要任一候选违反严格 schema，当前 `validateCandidates()` 会抛错，整批 fail-closed。

---

## 13.8 实验七：修订快照与 revision traversal

### 目标

1. 连续更新同一逻辑记录，观察稳定 record ID、head 和不可变 revision snapshot。
2. 使用 `listRevisions()` 和 `getRevision()` 做时间顺序遍历。
3. 检查损坏 revision 的跳过行为。
4. 验证 revision pointer 与实际 snapshot ID 的当前一致性，不预设链一定可达。

### 步骤

#### 步骤一：连续三次 manual save

使用固定 `now()`：

```text
t1：title="API Style"，content="Use REST."
t2：同 scope/category/title，content="Use GraphQL."
t3：同 scope/category/title，content="Use gRPC."
```

记录每次返回的：

```text
id
createdAt
updatedAt
provenance.revision
```

相同 scope、projectId、category 和规范化标题会生成相同 record ID。

#### 步骤二：列出修订

```ts
const revisions = await repository.listRevisions(head.id, cwd);
```

打印：

```text
revisionId
capturedAt
content
provenance.revision
```

修订按 `capturedAt` 升序返回。三次写入应形成一个 head 和两个旧版本 snapshot。

#### 步骤三：按 ID 读取

对 `listRevisions()` 返回的每个 `revisionId` 调用：

```ts
await repository.getRevision(head.id, revision.revisionId, cwd)
```

再测试：

```text
非法 recordId；
不存在 revisionId；
revision 文件内 recordId 与目录不一致。
```

预期返回 `undefined` 或空数组，而不是越界读取。

#### 步骤四：损坏单个 revision

在 revision 目录添加一个无法解析的 `.md` 文件，或把某个实验生成的 revision 内容改为非法 JSON。再次 `listRevisions()`。健康修订仍应返回，损坏项被跳过。

#### 步骤五：检查 pointer traversal

从当前 head 的 `provenance.revision.revisionId` 开始调用 `getRevision()`，再尝试沿 `previousRevisionId` 继续。把结果与目录枚举得到的修订集合对比。

当前实现需要实测，不能仅凭类型声明断言链可遍历。manual `save()` 创建旧 head snapshot 时使用一个随机 `revisionId`，随后给新 head provenance 写入的 pointer 又可能使用另一个随机 ID；batch replacement 还会在 coordinator 与 repository 两层处理 pointer。若 head pointer 无法解析到快照，应记录为当前一致性缺口，并以 `listRevisions()` 的时间序遍历作为可工作的读取方式。

#### 步骤六：验证作用域边界

当前 `listRevisions()` 和 `getRevision()` 从 project base 的 `revisions/<recordId>/` 读取。额外创建 global 记录并更新，检查该 API 是否能枚举 global revision。把实际结果记录为 API 边界，不要推断两个 scope 自动合并。

### 预期

1. 同标题更新保持 record ID 和 createdAt，推进 updatedAt。
2. revision snapshot 保存“更新前”的 title、content、provenance、createdAt，并增加 capturedAt。
3. `listRevisions()` 通过目录枚举和 capturedAt 排序提供稳定的历史视图。
4. 损坏 revision 不阻断健康历史。
5. pointer chain 的可达性必须由 `getRevision()` 实测；当前可能与落盘 snapshot ID 不一致。
6. revision 是不可变快照语义，不是 Git commit，也没有分支合并语义。

### 验收

- [ ] 三次更新得到一个 head、两个历史 snapshot。
- [ ] 所有健康 snapshot 都能按其真实 `revisionId` 读取。
- [ ] 损坏项被跳过且健康项仍可见。
- [ ] head pointer traversal 与目录遍历结果被并列记录。
- [ ] global revision API 边界经过实测。

### 参考思路

修订系统包含两个不同概念：

```text
snapshot：磁盘上的旧版本事实，具有真实 revisionId；
pointer：新 head provenance 中试图描述前序关系的引用。
```

可靠遍历需要满足：pointer ID 与 snapshot ID 相同、`previousRevisionId` 指向更早 snapshot、scope 与 recordId 定位一致。类型存在并不证明这三个不变量已经成立。实验应优先信任磁盘枚举与 `getRevision()` 的实际返回。

---

## 13.9 实验八：Eval metrics、noise 与 failure 分类

### 目标

1. 手算并验证 TP、FP、FN、Precision、Recall、F1、FDR 和 noise rejection。
2. 验证一对一 greedy matching 与 forbidden prediction-level penalty。
3. 区分 per-case metrics、`computeSummary()` macro 和 Live Eval 退出码。
4. 识别 null、0、1 三种边界值的不同含义。

### 步骤

#### 步骤一：运行确定性指标测试

```bash
npx vitest run test/eval/metrics.test.ts
npx vitest run test/eval/trace.test.ts
npm run eval:recorded
```

#### 步骤二：建立最小矩阵

对同一个正例 case 构造：

| TP | FP | FN | P | R | F1 |
|---:|---:|---:|---:|---:|---:|
| 1 | 0 | 0 | 1 | 1 | 1 |
| 0 | 1 | 1 | 0 | 0 | 0 |
| 1 | 1 | 0 | 0.5 | 1 | 2/3 |
| 1 | 0 | 2 | 1 | 1/3 | 0.5 |

对 noise case 构造：

```text
expected=0, predicted=0：noiseRejected=true，P/R/F1=null；
expected=0, predicted>0：noiseRejected=false，P=0，R=null，F1=null。
```

`null` 表示数学上未定义，不等于 0，也不应在 per-case 层伪造为 1。

#### 步骤三：验证 forbidden penalty

构造三个 unmatched records，多个记录均含一个或多个 forbidden term。验证：

```text
基础 FP = unmatched record 数；
forbidden 额外惩罚最多 +1；
不是每个 term +1，也不是每个 contaminated record +1。
```

再构造一个本可匹配 expected、但同时含 forbidden 的记录，观察其从 TP 降级，并形成 FN 与 forbidden FP。

#### 步骤四：验证 evidence 匹配边界

`matchesExpected()` 检查 category、scope、title/content includes、source、sourceEntryIds、sessionId、64 位 sourceHash。随后 `evaluateRecords()` 对存在的 evidence quotes 检查是否至少一条为 user input 的子串。

额外测试：

```text
provenance.evidence 缺失；
evidence 存在但全部不在 user input；
ExpectedMemory.evidenceIncludes 与 provenance quote 不同。
```

记录当前实现：evidence 数组缺失时 grounding 检查仍允许通过；`ExpectedMemory.evidenceIncludes` 当前不参与 `matchesExpected()`。

#### 步骤五：验证普通 FP/FN 与 failures

构造一个只有普通 FN、没有 forbidden 的 case，以及一个普通 unmatched FP。比较：

```text
metrics.falseNegative / falsePositive
metrics.failures
```

当前 `failures` 主要由 forbidden 相关路径填充，普通 FP/FN 不一定写入字符串。因此不能用 `failures.length===0` 推导 `FP=FN=0`。

#### 步骤六：验证 summary

创建 `EvalObservation[]`，调用 `computeSummary()`，分别包含：

```text
正例成功；
正例失败；
noiseRejected=true；
infraFailure=true。
```

检查：

```text
all-observation macro 中 noise rejection 被当作 P=R=F1=1；
positive macro 排除 noiseRejected=true；
variance 使用总体方差，分母 N；
infraFailureCount 独立统计；
semanticFailureCount 依据 failures 且排除 infra。
```

再添加一个 expected=0 但有 FP 的 observation。由于 observation 没有 expectedCount，且 `noiseRejected=false`，它会进入当前 `positiveObs`；记录这一 schema 推断边界。

### 预期

基本公式：

```text
P = TP / (TP + FP)，分母为 0 时 null
R = TP / (TP + FN)，在 evaluateRecords 中 expected=0 时 null
F1 = 2PR / (P + R)，P 或 R 为 null 时 null
FDR = FP / (TP + FP)，分母为 0 时 null
noiseRejected = (expected=0 ∧ TP=0 ∧ FP=0)
```

一对一匹配是按 expected 顺序、选择第一个尚未占用的 record，属于 greedy，不是最大二分匹配。模糊 fixture 的结果可能依赖数组顺序。

Live Eval 的失败优先级设计为：

```text
infra/pipeline failure → exit 2
semantic failure       → exit 1
全部通过               → exit 0
```

但若 runner 仅依据 `metrics.failures` 判语义失败，普通 FP/FN 可能不触发 exit 1。实验报告必须同时看计数和 failure 字符串。

### 验收

- [ ] 四个正例矩阵和两个 noise 边界均完成手算与代码核对。
- [ ] forbidden 多 term、多 record 仍最多只加一个额外 penalty。
- [ ] 能解释 null 与 0 的差异。
- [ ] 复现 evidenceIncludes 未直接参与匹配的当前行为。
- [ ] 复现普通 FP/FN 与 failures 数组可能不一致。
- [ ] summary 的 positive macro 与 all-observation macro 分开报告。

### 参考思路

评估必须保留三层事实：

```text
原始 observation
  → per-case TP/FP/FN 与 null 边界
  → 可重算 summary
```

禁止只保存平均 F1。否则无法判断平均值来自正例、noise、基础设施失败还是缺失数据。`EvalEvidenceV1.summary` 应由 observations 推导，不能单独手填。

`falsePositiveRate`、`falseDiscoveryRate` 和 `caseFPIncidence` 也不是同一个量：前者可表示“有 FP 的观测占比”，FDR 是预测级比例，incidence 是用于定位的标题集合。

---

## 13.10 实验九：安装器符号链接安全边界

### 目标

1. 在完全临时的 agent 目录和主目录中运行真实安装器。
2. 验证正确链接、幂等、断链替换、非符号链接拒绝和 legacy 迁移。
3. 测试父目录符号链接导致的路径逃逸边界。
4. 确保实验不改写真实 `~/.local/bin/trip`。

### 步骤

#### 步骤一：建立硬隔离并验证 `homedir()`

```bash
INSTALL_LAB="$LAB_ROOT/install"
mkdir -p "$INSTALL_LAB/home" "$INSTALL_LAB/agent"
LAB_HOME="$INSTALL_LAB/home"
OBSERVED_HOME="$(HOME="$LAB_HOME" node --input-type=module -e 'import { homedir } from "node:os"; process.stdout.write(homedir())')"
test "$OBSERVED_HOME" = "$LAB_HOME" || {
  printf '拒绝运行：Node homedir=%s，不等于隔离目录=%s\n' "$OBSERVED_HOME" "$LAB_HOME" >&2
  exit 1
}
```

只有该断言通过后才能运行安装器。若平台不遵从临时 HOME，应改在容器或一次性系统用户中运行。

#### 步骤二：正常安装与幂等

```bash
HOME="$LAB_HOME" PI_CODING_AGENT_DIR="$INSTALL_LAB/agent" \
  node scripts/install-extension.mjs
HOME="$LAB_HOME" PI_CODING_AGENT_DIR="$INSTALL_LAB/agent" \
  node scripts/install-extension.mjs
```

检查：

```bash
readlink "$INSTALL_LAB/agent/extensions/triple-pi"
readlink "$LAB_HOME/.local/bin/trip"
```

extension target 应指向当前仓库 `extensions/`；launcher target 应指向当前仓库 `bin/trip`。第二次应报告 already installed/already linked。

#### 步骤三：断链和错误目标替换

删除临时 extension link，创建指向临时缺失路径的断链，再运行安装器。随后创建指向另一个存在目录的 symlink，再运行。两种情况都应先 unlink，再安装正确链接。

#### 步骤四：非符号链接拒绝

```bash
rm -f "$INSTALL_LAB/agent/extensions/triple-pi"
mkdir -p "$INSTALL_LAB/agent/extensions/triple-pi"
set +e
HOME="$LAB_HOME" PI_CODING_AGENT_DIR="$INSTALL_LAB/agent" \
  node scripts/install-extension.mjs
status=$?
set -e
printf 'exit=%s\n' "$status"
```

预期 extension target 是普通目录时退出码为 1，内容不被删除。

#### 步骤五：legacy link 迁移

在 `agent/extensions/memory` 创建一个 symlink，再确保统一 target 不存在，运行安装器。legacy symlink 应删除，统一 `extensions/triple-pi` 应创建。若 legacy path 是普通目录，安装器不应按 legacy cleanup 分支删除它。

#### 步骤六：父目录 symlink 边界

只在 `$INSTALL_LAB` 内构造：

```bash
ESCAPE="$INSTALL_LAB/escaped-parent"
AGENT2="$INSTALL_LAB/agent-parent-link"
mkdir -p "$ESCAPE" "$AGENT2"
ln -s "$ESCAPE" "$AGENT2/extensions"
HOME="$LAB_HOME" PI_CODING_AGENT_DIR="$AGENT2" \
  node scripts/install-extension.mjs
find "$INSTALL_LAB" -maxdepth 4 -type l -print -exec readlink {} \;
```

观察 `triple-pi` 实际创建位置。当前安装器对 `agentDir` 只做 `path.resolve()`，对父目录没有 canonical containment 检查；`mkdir` 和 `symlink` 会跟随已存在的父目录链接。因此 target 可能物理落在 `$ESCAPE/triple-pi`。这证明 lexical target 位于 agentDir 之下，不等于 canonical path 也位于其中。

#### 步骤七：检查真实用户路径未变化

实验前后分别记录真实路径：

```bash
ls -ld ~/.local/bin/trip 2>/dev/null || true
```

更稳妥的验收是对实验前存在的真实 launcher 记录 `lstat`、`readlink` 或 hash，并在实验后比较。

### 预期

1. extension target 为 symlink 且 realpath 与 source 相同时幂等。
2. extension target 为错误 symlink或断链时会替换。
3. extension target 为普通文件或目录时拒绝覆盖。
4. legacy cleanup 只删除 symlink。
5. launcher 逻辑与 extension target 的保护不完全相同：现有错误目标甚至普通路径可能被 unlink 后替换，必须单独审计。
6. 父目录 symlink 可改变物理落点，当前实现没有 `realpath(parent)` 后的 containment 验证。

### 验收

- [ ] 运行前断言 Node `homedir()` 确实被隔离。
- [ ] 正常、幂等、断链、错误 symlink、非 symlink、legacy 六种情形均有记录。
- [ ] 父目录 symlink 的 lexical path 与 canonical path 都被打印。
- [ ] 所有物理写入均位于 `$INSTALL_LAB` 或明确的当前仓库 source 链接目标。
- [ ] 真实 `~/.local/bin/trip` 未变化。

### 参考思路

符号链接安全要分别检查：

```text
对象类型：lstat(target)；
链接解析：realpath(target)；
父目录解析：realpath(parent)；
包含关系：canonical target 是否仍在 canonical root 下；
替换策略：只替换自己管理的 symlink，还是删除任意现有对象。
```

`lstat()` 能避免把目标目录误认为 symlink 本身，但不能阻止父目录链接。`path.resolve()` 只处理 `.`、`..` 和相对路径，不解析文件系统符号链接。安全实验必须使用物理路径观测，而不能只打印构造出的字符串。

现有 `test/scripts/install-extension.test.ts` 只显式隔离 `PI_CODING_AGENT_DIR`。直接运行它之前仍应确认 launcher 主目录不会影响真实用户；本实验的临时 HOME 前置断言是额外保护。

---

## 13.11 实验十：确定性性能 benchmark

### 目标

1. 测量不依赖网络的核心路径：source 构建、candidate validation、repository 写入/读取/搜索/prompt、review chunk 聚合。
2. 报告 warm-up 后的 median、p95、吞吐和输入规模，不只报告单次耗时。
3. 分离 CPU 路径、文件系统路径和锁竞争路径。
4. 建立可重复基线，而不是提出脱离环境的绝对性能承诺。

### 步骤

#### 步骤一：功能门

```bash
npm run typecheck
npm test
```

任何失败都应先解决或记录；不要在功能错误上继续比较性能。

#### 步骤二：固定环境元数据

```bash
node --version
git rev-parse HEAD
git status --short
uname -a
```

记录临时目录所在文件系统。WSL、容器 overlay、网络盘和本地 ext4 的 rename/lock 延迟不可直接横比。

#### 步骤三：定义统计函数

benchmark 脚本使用 `performance.now()` 或 `process.hrtime.bigint()`：

```ts
function percentile(sorted: number[], q: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}
function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    n: sorted.length,
    mean,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted.at(-1),
  };
}
```

先 warm-up 20 次，再采样至少 100 次。微操作应在一次 sample 内批量循环，避免时钟分辨率主导结果。

#### 步骤四：CPU benchmark

测量：

1. `buildExtractionSourceFromBranch()`：消息数取 2、20、200、2000；
2. `validateCandidates()`：候选数取 0、1、10，content 接近 2000 字符上限；
3. `evaluateRecords()`：records 数取 0、10、100、1000；
4. `aggregateFindings()`：chunk 数取 1、10、100，重复 finding 比例取 0%、50%、100%。

每组报告：

```text
输入条数
输入总字符
iterations
median ms
p95 ms
ops/s
```

不要把不同输入规模混在同一个平均值中。

#### 步骤五：repository benchmark

每次 trial 使用独立临时 root，至少测量：

```text
串行 save N 条唯一记录；
Promise.all 并发 save N 条；
list()；
search() 命中与未命中；
buildPrompt() 默认限制；
rebuildIndex()。
```

建议 N 为 10、100、500。记录最终记录数，确保吞吐测试没有丢写。

并发 benchmark 实际测的是 `proper-lockfile` 串行化、目录创建、temp+rename、chmod 和 index 重建的组合成本，不是纯并行 I/O。

#### 步骤六：事务 benchmark

对 `saveExtractionBatch()` 分别测量：

```text
空 entries + reinforcement；
10 条 create；
10 条 replace 并生成 revisions；
相同 sourceHash 的幂等 replay。
```

replay 应显著更短，因为 manifest 已存在后直接返回。报告时必须注明 replay 路径没有执行完整写入。

#### 步骤七：提示词预算 benchmark

预填 10、100、1000 条记录，测量 `buildPrompt()`。同时记录：

```text
repository 总记录数；
返回 count；
prompt 实际字符数；
索引实际行数；
maxEntries/maxChars。
```

prompt 长度被上限截断后，耗时仍可能随 list 全量扫描增长；不能用最终字符串长度推断全部 I/O 成本。

#### 步骤八：冷缓存与热缓存分开

同一进程重复调用通常受操作系统页缓存影响。至少报告：

```text
首次调用；
同进程 warm 调用分布；
重新创建 repository 实例但复用磁盘数据；
全新临时 root。
```

不要使用清系统缓存的特权命令作为常规实验步骤。

#### 步骤九：结果正确性哨兵

每个 benchmark 后断言：

```text
记录数符合预期；
所有 JSON/Markdown 可读；
无 .tmp 残留；
并发写没有丢失；
幂等 replay 没有改 updatedAt；
metrics 输出与基线相同。
```

### 预期

1. CPU 路径随消息、候选、record 或 finding 数增长；具体斜率由环境决定。
2. repository 写入明显慢于纯函数，因为每次涉及锁、目录权限、临时文件、rename、chmod 和索引处理。
3. 当前 `save()` 每次可触发 index rebuild；大量单条写入与 batch 写入的成本结构不同。
4. 并发 `save()` 不应丢记录，但由于全局 repository write lock，不应期待线性加速。
5. manifest replay 是短路路径，不能与首次完整 extraction commit 直接平均。
6. p95 比 mean 更能显示锁等待和文件系统抖动；max 只作为异常点记录。

### 验收

- [ ] 功能门全部通过或有明确已知失败记录。
- [ ] 所有结果带 commit、Node、OS、文件系统和参数。
- [ ] 每组先 warm-up，再至少 100 个样本或等价批量样本。
- [ ] 至少报告 median 与 p95。
- [ ] CPU、文件系统、锁竞争分组报告。
- [ ] benchmark 内含正确性哨兵。
- [ ] 临时数据位于仓库外，结束后工作树不变。

### 参考思路

性能结论应写成条件化命题：

```text
在环境 E、commit C、输入规模 N、参数 P 下，
路径 X 的 median 为 M，p95 为 Q，结果不变量 I 成立。
```

不要写“系统能处理百万条”之类未测声明。当前 repository 的 list/search 是文件系统遍历和 substring 过滤，不是数据库索引；prompt 有输出预算，但读取路径仍可能扫描更多记录。性能优化前必须先用 profile 区分锁等待、文件读取、Markdown 解析、index rebuild 和哈希计算。

---

## 13.12 综合练习：从事件到证据包

### 目标

把前十个实验的结果整理成可复算证据包，验证不同模块的不变量能否同时成立。

### 步骤

1. 选择一个固定 commit。
2. 运行 Git staged/unstaged 实验，保存原始 diff 和 `ChangeFile[]`。
3. 捕获一次 `before_agent_start` 输出，保存长期与临时上下文的分离结果。
4. 运行 fake provider 合法、空集、失败三条路径。
5. 保存 scheduler deferred 的完整事件序列。
6. 对一个事务 fault point 保存写序和 rollback 文件 hash。
7. 保存 scope/evidence 真值矩阵和一条 provenance。
8. 保存 revision 目录遍历与 pointer traversal 对比。
9. 保存 per-case observations 并独立重算 summary。
10. 保存 installer lexical/canonical path 对比。
11. 保存 benchmark 原始样本，而非只有汇总。

建议证据包结构放在仓库外：

```text
lab-evidence/
  environment.json
  git/
  prompt/
  provider/
  scheduler/
  transaction/
  grounding/
  revisions/
  eval/
  installer/
  benchmark/
```

### 预期

任何汇总结论都能追溯到原始事件或文件；任何“不适用”都用 null 或显式状态表达，而不是填 0；任何基础设施失败都不被计为语义正确。

### 验收

- [ ] summary 可由 raw observations 重算。
- [ ] 每个竞态结论有事件时序。
- [ ] 每个事务结论有事务前后 hash。
- [ ] 每个安全结论同时包含 lexical 与 canonical path。
- [ ] 每个性能结论包含输入规模和原始样本。
- [ ] 原仓库仅保留预期文档变更。

### 参考思路

完整证据链不是“所有测试绿色”的截图，而是：

```text
输入 → 事件/调用 → 状态转换 → 权威输出 → 指标 → 汇总
```

当实现存在已知边界时，证据包应忠实保存。技术验证的价值在于缩小可声明范围，而不是把所有结果包装为成功。
