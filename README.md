# Triple-pi

Persistent memory and project-aware code review for coding agents.

[![CI](https://github.com/npm-DreaMaX/Triple-pi/actions/workflows/ci.yml/badge.svg)](https://github.com/npm-DreaMaX/Triple-pi/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## What it does

Two modules that share one memory store.

### Persistent Memory

The agent forgets everything between sessions. You re-explain conventions, re-state preferences, re-teach decisions. Triple-pi remembers for it.

After each conversation, the system extracts what's worth keeping — rules, preferences, technical decisions — and saves them. Next time you open the project, the agent loads them automatically.

What you get in practice:

- Agent learns "this project uses pino, not console.log." It sticks.
- You say "actually, use GraphQL instead of REST." The old rule is replaced, not duplicated.
- You open a project you haven't touched in 35 days. The agent asks: "Restore project memory?" Your choice.
- Working on a monorepo? Frontend rules don't leak into backend projects.

### Project-aware Code Review

Before you commit — or at any point — `review_current_changes` checks your working diff against your project's stored rules. You call it when you want a review. The agent can also decide to invoke it proactively. It doesn't run automatically on every keystroke; each invocation is an explicit LLM call.

What you get in practice:

- Catches `any` types, missing transaction timeouts, console.log calls — not from a lint config, but from your project's own rules.
- Reviewer has no write tools loaded. Not "asked to be read-only." Configured that way.
- Diff is chunked. Large diffs report which files were covered and which were skipped.
- If the model returns garbage, you get a parse error, not a silent "no issues found."

---

## Compared to Pi's built-in tools

Pi ships a Memory tool and a SubAgent session API. These are the building blocks. Triple-pi uses them and adds the parts that make them trustworthy outside of demos.

**Memory pipeline — 6 stages, each can reject the batch**

| Pi built-in | Triple-pi |
|---|---|
| Saves whatever the LLM outputs | Extraction → validation → review → consolidation → commit |
| No evidence required | Evidence must be a verbatim user message substring |
| LLM picks scope | Global downgraded to project without explicit cross-project evidence |
| No review step | Second LLM pass: keep or remove only, cannot rewrite |
| Overwrite on save | Immutable revision snapshots |
| No lifecycle | 30d hot → 31-90d cold (asks) → >90d archive (rename, not delete) |

**Reviewer — code-level isolation, not prompt-level**

| Pi built-in | Triple-pi |
|---|---|
| Prompt says "read only" | Session configured with noExtensions, noSkills, noContextFiles |
| No write-tool restriction | Tool allowlist `[read, grep, find, ls]` enforced by registry |
| No change verification | Git status + file hash snapshot before and after |
| Raw model output | Strict schema: passed ↔ zero findings, line positive integer, etc. |
| Full diff in prompt | Chunked by file/hunk; partial coverage tracked |
| No memory integration | Multi-keyword OR-search from diff content |

---

## Install

```bash
git clone --recurse-submodules https://github.com/npm-DreaMaX/Triple-pi.git
cd Triple-pi
npm run setup
```

Node.js `>=22.19.0`.

## Verify

```bash
npm run typecheck
npm test               # 178 tests, 0 network, 0 LLM
npm run eval:recorded   # 46 full-pipeline tests
npm run demo            # Offline smoke test
```

---

## Evaluation

Three layers, different goals.

| Layer | Runs | Validates |
|---|---|---|
| 178 deterministic tests | Every push, 0 LLM | Code logic: parsing, locking, validation, scheduling |
| 46 recorded pipeline tests | Every push, mock LLM | End-to-end wiring: extraction through commit |
| Live eval | Opt-in, model required | Model quality: precision, recall, noise rejection |

Live eval exit codes: 2 = infra failure, 1 = semantic mismatch, 0 = pass.

---

## Limitations

- Keyword search, no semantic retrieval
- Secret redaction: 10 patterns, not custom formats
- Single-user, no shared memory
- `temp → rename` = atomic visibility, not `fsync` durability

---

## Docs

[Memory design](./docs/design/memory.md) · [Reviewer design](./docs/design/reviewer.md) · [Evaluation](./docs/evaluation.md) · [Demo](./docs/demo.md) · [Interview prep](./docs/interview.md) · [History](./docs/history/MEMORY_REBUILD.md)

## License

MIT
