#!/usr/bin/env python3
"""调用 DeepSeek 最强模型 (deepseek-v4-pro) 生成 Triple-pi 演示网页。"""
import json, urllib.request, sys, re

AUTH = json.load(open('/home/FangWang/.pi/agent/auth.json'))
KEY = AUTH['deepseek']['key']
MODEL = 'deepseek-v4-pro'
URL = 'https://api.deepseek.com/chat/completions'

FACTS = """
项目：Triple-pi —— 基于 Pi Agent Runtime（GitHub 近 8 万 star）的本地 Coding Agent 增强层。
GitHub: https://github.com/npm-DreaMaX/Triple-pi  (MIT License)
一句话：Coding agents 在会话之间忘记一切；Triple-pi 记住它们，并在每次提交前用这些规则审查改动。

两项核心功能：

【功能一】Persistent Memory 跨会话持久记忆
- 工具：SaveMemory（明确要求时保存，展示全文并确认后才写入）、SearchMemory（关键词检索项目/全局记忆，也支持检索临时 Working State）
- 5 个分类：preference / decision / rule / fact / knowledge
- 2 个作用域：project（默认，仅当前项目）/ global（所有项目）
- 自动提取 6 阶段管线（任意一环可拒绝，fail-closed）：
  01 脱敏（10 类常见密钥正则）
  02 LLM 提取（复用 Pi ModelRegistry）
  03 严格校验（schema + evidence 逐字命中用户原话 + 二次脱敏）
  04 Grounded Review（二次 LLM，只允许 keep/remove，禁止改写）
  05 信号评分 + consolidation（指纹去重，Jaccard>=0.72 视为重复）
  06 事务提交（写锁内 temp→rename 原子写 entry + manifest，manifest 最后发布）
- 每条记录携带 provenance.evidence（用户原话引用）；LLM 捏造不存在的证据 → 候选直接拒绝
- scope 确定性解析：LLM 标记 global 但无跨项目证据（如"所有项目/跨项目"）→ 自动降级 project
- 生命周期：hot(<30天 正常注入) / cold(30-90天 注入前询问) / archived(>90天 无损归档，可 /memory-restore 恢复)
- 存储：~/.triple-pi/memory-v1/  (entry 为权威数据，MEMORY.md 为可重建的派生索引，revisions 为不可变快照)
- Working State（Scratchpad/Daily）确定性生成，不调 LLM，标注 derived/temporary/untrusted，与长期记忆物理隔离

【功能二】Project-aware Code Review 项目感知代码审查
- 工具：review_current_changes（提交前必须调用；自动 git diff + Memory 检索 → 只读 Reviewer）、delegate_review（手动传入 task+diff+rules）
- 流程：collectGitChanges(staged+unstaged+untracked) → extractReviewSearchTerms → searchRelevantMemories(多关键词 OR 搜索) → buildReviewChunks(每 12KB 一片) → 只读 Reviewer 会话 → strict parse → 前后 worktree 快照对比
- 只读保证（代码级，非 prompt 约束）：会话以 noExtensions/noSkills/noContextFiles 创建，工具白名单仅 read/grep/find/ls（写工具不存在）
- 严格 schema 校验：passed 必须有 0 findings；issues_found 必须 >=1 findings；JSON 解析失败绝不报告为"无问题"
- 分片透明：大 diff 报告 coverage=partial，跳过的文件显式列出，不静默省略
- 输出字段：status / summary / findings[{severity(high/medium/low), file, line, description}]

【测试与评估】（实际运行结果，当前 main）
- 全量：207 tests / 26 files 全部通过（npx vitest run）
- Memory：86 tests / 12 files；Reviewer(subagent)：58 tests / 5 files
- 三层验证：Deterministic（178 纯逻辑测试，0 LLM）/ Recorded（mock LLM 走全链路验证接线）/ Live（显式配置真实模型，opt-in）
- 退出码：2=infra failure, 1=semantic mismatch, 0=pass

【配色要求】深紫黑底 #0a0a0f，主色渐变 紫#c084fc → 粉#e879f9 → 蓝#818cf8 → 青#38bdf8，多层径向渐变光晕背景，毛玻璃导航，卡片 hover 动效，响应式。
"""

PROMPT = f"""你是资深前端工程师。请基于以下【准确的项目事实】生成一个完整、可直接打开的**单文件 HTML 网页**，用于展示 Triple-pi 的两项核心功能：Persistent Memory 与 Project-aware Code Review。

【准确的项目事实】
{FACTS}

【页面硬性要求】
1. 输出**纯 HTML 代码**，以 <!DOCTYPE html> 开头、以 </html> 结尾，不要任何解释、不要 markdown 代码围栏（```）。
2. 单文件自包含：内联 CSS + 内联 JS，不依赖任何外部资源（不引 CDN、字体用系统栈）。
3. 中文内容。结构包含：导航 + Hero + 功能一(记忆) + 功能二(审查) + 测试结果 + 对比表(常见做法 vs Triple-pi) + 架构/存储布局 + footer。
4. 每个功能配一个**可交互的 JS 演示**：
   - 记忆演示：模拟"用户说一句话 → 6 阶段提取管线逐步打印 → SaveMemory → SearchMemory 检索命中"。
   - 审查演示：展示一段故意违反两条项目规则(禁止 any 类型 / 事务必须 timeout)的 diff，点击运行后逐步打印审查流程，最终输出 findings(带 severity 徽章)。
5. 用打字机/逐行打印效果，按钮触发，纯原生 JS。
6. 配色严格按上面的渐变体系，观感要高级、现代。

只输出 HTML 代码本身。"""

def call(prompt):
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "你只输出网页源码，绝不输出解释或代码围栏。"},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 40000,
        "temperature": 0.6,
        "stream": False,
    }
    req = urllib.request.Request(
        URL,
        data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {KEY}'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            resp = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        print('HTTP', e.code, e.read().decode('utf-8')[:500], file=sys.stderr)
        sys.exit(1)
    msg = resp['choices'][0]['message']
    content = msg.get('content') or ''
    if not content.strip():
        # 某些 reasoning 模型把正文放 reasoning_content
        content = msg.get('reasoning_content') or ''
    return content, resp.get('usage', {})

def extract_html(s):
    s = s.strip()
    # 去掉可能残留的代码围栏
    s = re.sub(r'^```(?:html|HTML)?\s*', '', s)
    s = re.sub(r'\s*```$', '', s)
    # 定位到 doctype 起点
    i = s.lower().find('<!doctype html>')
    if i > 0:
        s = s[i:]
    j = s.lower().rfind('</html>')
    if j > 0:
        s = s[:j+7]
    return s

if __name__ == '__main__':
    print(f'[*] 调用 {MODEL} 生成网页 ...', file=sys.stderr)
    content, usage = call(PROMPT)
    html = extract_html(content)
    out = '/home/FangWang/Triple-pi/features.html'
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'[+] 已写入 {out}  ({len(html)} bytes)', file=sys.stderr)
    print(json.dumps(usage, ensure_ascii=False))
