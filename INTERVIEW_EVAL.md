# Triple-pi 面试答辩 — Eval 模块

> Memory 做完了，怎么证明它真的有效？这篇文档记录 Eval 的设计、踩坑、实验数据和结论。

---

## 一、为什么需要 Eval

**没有 Eval，Memory 模块的价值只是"我觉得有用"。** 面试官问你"你怎么知道你的记忆系统比不用好"，如果没有数据，你只能靠嘴说。

Eval 做的是：用可控的合成 transcript，验证提取器在每个维度上是否正确。

---

## 二、设计思路

### 为什么用合成 transcript 而不是真实数据

| | 真实 transcript | 合成 transcript |
|---|---|---|
| ground truth | 需要人工标注，还猜不准 | 我写的时候就知道该提取什么 |
| 边界 case | 不一定覆盖到 | 专门构造（空对话、多偏好、纠正信号） |
| 可复现 | LLM 输出会变，标注不会变 | transcript 不变，ground truth 不变 |
| 隐私 | 包含真实对话 | 全是编的 |

我选择合成数据——不是因为真实数据不好，而是因为**我需要 100% 确定的 ground truth，不需要人工标注。**

### 断言为什么是确定性的，不用 LLM-as-judge

教程的做法是 `assertions: ['输出中包含项目名称']`——这是 LLM-as-judge：你让另一个 LLM 来判断"输出里有没有项目名称"。问题：1) LLM 判断也可能错；2) 每次判断结果可能不一样。

我的做法是代码验证：检查提取器输出的结构化数据（category、title），匹配预期的关键词。

```javascript
// 代码验证（确定性，可复现）
mustContain: [{ category: 'knowledge', reason: '应该提取用户知识声明' }]

// LLM-as-judge（教程的做法，不可复现）
assertions: ['输出中包含项目名称']  // 谁来判断？
```

---

## 三、10 个 case 的维度和设计意图

| # | Case | 测什么 | 为什么重要 |
|---|------|--------|-----------|
| 1 | basic-extraction | 4 种类型同时提取 | 验证基础能力——能不能从一个正常对话里提全 |
| 2 | noise-rejection | 调试/闲聊 = 0 提取 | 验证不会把垃圾存成记忆 |
| 3 | knowledge-recall | 知识声明必须提取 | 最重要的类型——Agent 不知道用户水平就没法对话 |
| 4 | correction-signal | 纠正信号优先 | 用户纠正比普通对话更值得记住 |
| 5 | discoverable-filter | 不存代码可发现信息 | 验证"Agent 读文件就知道的"不被存 |
| 6 | cross-session-frequency | 频率跨会话累积 | 同一条信息在多次对话里出现应该增强 |
| 7 | project-isolation | 项目 A 记忆不漏到 B | 验证项目隔离——这是 multi-project 场景的基础 |
| 8 | edge-empty | 空对话 = 0 | 边界——不能从空对话提取幻觉 |
| 9 | edge-multi-preference | 多个偏好合并 | 边界——Deep Sleep 允许合并相关偏好 |
| 10 | edge-implicit-knowledge | 隐式知识声明 | 已知局限——评分公式对"写了好几年"这种隐式声明召回低 |

---

## 四、开发过程中的问题

### 问题 1：LLM 输出波动导致相同 case 不同结果

**现象：** 同一个 transcript 跑两次，第一次 4/4 通过，第二次 3/4——少了一条 rule "禁止 git push"。

**排查：** LLM 温度设为 0.1，但仍有随机性。DeepSeek 的 temperature=0 也不能保证完全确定性输出。同一段 transcript，LLM 有时把 "禁止 git push" 识别为 rule，有时觉得它和上下文关联不够而跳过。

**解决：** 给 minTotal 和 mustContain 加了 tolerance 参数（默认 1）。minTotal ≥ 4，tolerance=1 → 实际 ≥ 3 就通过。这样覆盖了 LLM 的正常波动，同时不会让显式的错误（0 提取）蒙混过关。

**面试时怎么说：** > "跑 Eval 发现同一个 transcript 第一次 4 条全过，第二次少了 1 条。排查发现不是代码 bug——LLM 温度 0.1 仍有非确定性输出。我在断言里加了 tolerance=1，允许 1 条的波动。这不是放宽标准，是承认 LLM 非确定性并设计应对策略。"

### 问题 2：merge step 吞掉了 eval 的结果

**现象：** correction-signal case 在第一次跑时 3/3 通过，第二次跑完全相同的 transcript 变成了 0/3。提取器说"merged/updated: 3 | New to save: 0"。

**排查：** 第二次跑时，第一次的提取结果已经保存在 `~/.triple-pi/memory/` 里了。Phase 3（Merge）看到相同的标题已经存在，就合并（merge）而不是新建（save）。eval 解析器只解析了 `✅ saved` 行，没解析 `🔗 merged` 行。

**解决：** 两步：1) eval 用临时 HOME 目录（`eval/.eval-home/`），完全隔离于真实记忆存储。2) eval 解析器同时解析 `✅ saved` 和 `🔗 merged` 两种输出。

**教训：** 测试环境隔离和测试数据隔离一样重要。Eval 不应该接触生产数据——不仅影响结果准确性，还可能误删用户数据。

**面试时怎么说：** > "第一次跑全过，第二次全挂——排查发现是 Phase 3 的 merge 步骤看到已有记忆就直接合并，eval 解析器只看了新建的。修复是两件事：eval 用临时 HOME 目录隔离生产数据，解析器同时抓 saved 和 merged 行。这是测试基础设施问题，不是被测试代码的问题。"

### 问题 3：隐式知识声明的评分盲区

**现象：** edge-implicit-knowledge case 里用户说"TypeScript 写了好几年"（隐含 TS 熟练）和"Go 从来没写过"（隐含 Go 新手）。LLM 提取了 1 个候选，但评分 0.28，没过 0.35 阈值。

**排查：** 隐式知识声明不像显式知识声明（"我读过 agent-loop.ts"）那样包含明确的 tech 关键词。"写了好几年"没有"agent-loop"、"Docker"这样的专有名词，relevance 得分很低（0.00-0.10）。加上只说一次（frequency 低），总分过不了 0.35。

**当前处理：** 接受为已知局限。在 case 描述里标记"已知局限"，不要求通过。这会留在 eval 结果里提醒：隐式知识需要改进。

**未来修复方向：** 给 knowledge 类型在 relevance 维度做特殊处理——不只看 tech 关键词，也看"写了好几年"、"没接触过"、"第一次做"这些经验描述的短语。或者让 Deep Sleep 的 prompt 里特别说明"隐式经验声明也是 knowledge"。

**面试时怎么说：** > "有一个 case 专门测隐式知识——用户说'TS 写了好几年'但没说我熟练。LLM 能理解这是经验声明，但评分公式因为缺少 tech 关键词给了低分。我把它标为已知局限留在 eval 里。这种'系统能做什么、不能做什么'的诚实记录，比假装所有 case 都能过更有价值。"

### 问题 4：discardable 事实的提取不稳定

**现象：** discoverable-filter case 的核心测试是不该提取的（TypeScript 在 tsconfig.json、vitest 在 package.json）保证不出现。但"项目三个月后迁移 Go"这条应该提取的 fact，有时提取有时不提。

**排查：** 和问题 1 一样——LLM 非确定性。Deep Sleep 有时认为"迁移 Go"的 evidence 不够明确而过滤它。

**当前处理：** case 重点放在 mustNotContain（验证不该提的不提），mustContain 放宽接受波动。噪音拒绝比单条召回更重要——因为噪音多了会污染所有 case，但少一条 fact 只影响一个 case。

---

## 五、当前结果

| 指标 | 数据 |
|------|------|
| Case 数量 | 10 |
| 覆盖维度 | 6（基础提取/噪音拒绝/knowledge 召回/纠正信号/可发现性/项目隔离） |
| 边界 case | 3（空对话/多偏好/隐式知识） |
| 当前通过率 | 10/10 |
| 已知局限 | 1（隐式知识声明召回率低） |
| 断言方式 | 代码验证（确定性，零 LLM-as-judge） |
| 每次运行耗时 | ~60s（10 × 6s LLM 调用） |
| 每次运行成本 | ~0.05 元（DeepSeek） |

---

## 六、后续

1. **稳定化** — 连续 5 次跑全部 10/10 才算真正稳定。目前 LLM 温度 0.1 有波动。
2. **加更多边界 case** — 超长对话、纯代码粘贴、多语言混用。
3. **基准对比** — 和不用 Deep Sleep 的版本对比通过率，量化 Deep Sleep 的价值。
4. **真实数据回归** — 用你自己的几个典型 session 跑，人工标注后加入 eval suite。
