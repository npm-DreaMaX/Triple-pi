<p align="center">
  <b>Triple-pi</b>
  <br/>
  Persistent memory and project-aware code review for coding agents.
</p>

<p align="center">
  <a href="https://github.com/npm-DreaMaX/Triple-pi/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/npm-DreaMaX/Triple-pi/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://nodejs.org"><img alt="Node" src="https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue" /></a>
</p>

---

Coding agents forget everything between sessions — your conventions, your decisions, your preferences. Triple-pi remembers.

Two systems, sharing one memory store:

| | |
|---|---|
| **Memory** | Extracts rules, preferences, and decisions from your conversations. Injects them into future sessions automatically. |
| **Reviewer** | Checks staged and unstaged changes against your project's stored rules before you commit. Read-only, run on demand. |

---

## How it works

### Memory

Memory flows through two paths. One automatic, one explicit. Both land in the same store.

| Path | Trigger | What happens |
|---|---|---|
| **Automatic extraction** | After each conversation ends (`agent_settled`) | 6-stage pipeline runs in the background — redact secrets, ask LLM, validate every field, second LLM review, merge with existing, atomic write |
| **Manual save** | You or the agent call `SaveMemory` | Confirmation dialog shown, then written immediately |

Once saved, memory is loaded on the next session via `before_agent_start` — the agent sees an index of what it knows about this project. It uses `SearchMemory` to pull full content when needed.

```
Conversation ends
  → secret redaction
  → LLM extraction
  → strict validation (evidence must be user's verbatim words)
  → grounded review (keep/remove only, no rewriting)
  → consolidation (merge, replace, or skip)
  → atomic write
```

Every extracted record carries a `provenance.evidence` — a quote from what you actually said. If the LLM fabricates an evidence that isn't in the conversation, the candidate is rejected.

Scope is resolved deterministically. If the LLM marks something `global`, it's downgraded to `project` unless your quoted evidence explicitly says it applies across projects (e.g. "all my projects", "跨项目").

Memory isn't forever. Projects inactive for 31–90 days prompt before injecting context. After 90 days, memory is renamed into `archive/` — not deleted, restorable with `/memory-restore`.

### Reviewer

The reviewer is a separate, isolated agent session. It reads your diff, searches your project memory for relevant rules, and checks the changes against them.

```
review_current_changes
  → collect staged + unstaged + untracked (git)
  → extract search terms from diff content
  → multi-keyword OR-search against project memory
  → chunk diff by file and hunk
  → spawn isolated reviewer session
  → strict schema validation
  → verify worktree unchanged
```

The reviewer cannot modify files — its session is created with `noExtensions`, `noSkills`, `noContextFiles`, and only four tools: `read`, `grep`, `find`, `ls`. Write tools don't exist in the session. A git status and file hash snapshot taken before and after the review proves nothing changed.

Output is strictly validated. `passed` requires zero findings. `issues_found` requires at least one finding. A JSON parse failure is never reported as "no issues found."

Diffs are chunked by file and hunk. Large diffs report `coverage: partial` with skipped files listed explicitly. Nothing is silently omitted.

---

## Compared to common approaches

**Memory**

| Common approach | Triple-pi |
|---|---|
| LLM output saved directly | 6-stage pipeline; any stage can reject |
| No evidence required | Verbatim user message substring mandatory |
| LLM picks project/global | Automatic global → project downgrade without cross-project evidence |
| Overwrite on save | Immutable revision snapshots |
| No lifecycle | 30d hot → 31-90d cold (asks) → >90d archive (renamed) |
| Silent on failure | Fail-closed; stage-classified errors |

**Reviewer**

| Common approach | Triple-pi |
|---|---|
| Prompt requests read-only | Session configured with noExtensions, noSkills, noContextFiles |
| Trust the model | Tool allowlist enforced by registry |
| No proof files unchanged | Git status + hash snapshot before/after |
| Raw output, hope it's JSON | Strict schema; parse failure ≠ passed |
| Full diff in one prompt | Chunked; skipped files recorded |
| No memory integration | Multi-keyword OR-search, relevance-ranked |

---

## Install

Node.js `>=22.19.0` required.

```bash
git clone --recurse-submodules https://github.com/npm-DreaMaX/Triple-pi.git
cd Triple-pi
npm run setup
```

`npm run setup` builds the runtime, installs dependencies, and links the `trip` command globally.

**Linux / macOS**

```bash
trip
```

If `trip` is not found:

```bash
source ~/.zshrc     # or: source ~/.bashrc
```

**Windows**

```powershell
.\bin\trip.ps1
```

Or add the repo's `bin\` directory to your PATH.

---

## Verify

```bash
npm run typecheck
npm test
npm run eval:recorded
npm run demo
```

---

## Evaluation

| Layer | Scale | Runs on | Validates |
|---|---|---|---|
| Deterministic | 178 tests | Every push, 0 LLM | Code logic |
| Recorded | 46 tests | Every push, mock LLM | Pipeline wiring |
| Live | Opt-in | Explicit model config | Model quality |

Exit codes: `2` = infra failure, `1` = semantic mismatch, `0` = pass.

---

## Structure

```
extensions/
├── index.ts                    # Single entry point
├── memory/
│   ├── index.ts                # Extension lifecycle, tools
│   ├── repository.ts           # Locking, atomic I/O, search, revisions
│   ├── extraction/             # 6-stage pipeline
│   └── validation.ts           # Shared write validation
└── subagent/
    ├── index.ts                # Reviewer tool registration
    ├── manager.ts              # Session lifecycle, timeout, cleanup
    └── review-core.ts          # Diff collection, search, chunking, parsing

eval/                           # Evaluation harness
test/                           # 178 tests
```

---

## Limitations

- Keyword search. No semantic or vector retrieval yet.
- Secret redaction covers 10 common patterns, not custom formats.
- Single-user. No shared memory.
- `temp → rename` = atomic visibility, not `fsync` durability.

---

## Docs

[Memory design](./docs/design/memory.md)
· [Reviewer design](./docs/design/reviewer.md)
· [Evaluation](./docs/evaluation.md)
· [Demo](./docs/demo.md)
· [Interview prep](./docs/interview.md)
· [History](./docs/history/MEMORY_REBUILD.md)

## License

MIT
