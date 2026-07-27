# Triple-pi

Persistent memory and project-aware code review for coding agents.

[![CI](https://github.com/npm-DreaMaX/Triple-pi/actions/workflows/ci.yml/badge.svg)](https://github.com/npm-DreaMaX/Triple-pi/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## What it does

### Persistent Memory

Coding agents forget everything between sessions. You re-explain conventions. You re-state preferences. You catch the same mistakes. Triple-pi remembers.

After each conversation, the system extracts rules, preferences, and technical decisions — then saves them. Next session, the agent loads them automatically.

- Agent learns "this project uses pino, not console.log" — and it sticks across sessions
- When you say "actually, GraphQL, not REST" — the old rule is replaced, not duplicated
- Open a project untouched for 35 days — the agent asks before injecting stale context
- Working in a monorepo — frontend rules don't leak into backend projects

### Project-aware Code Review

`review_current_changes` checks your working diff against your project's stored rules. The reviewer is a separate, read-only agent — it can't modify files. It tells you which file, which line, what's wrong, and how severe.

- Catches `any` types, missing transaction timeouts, missing tests — not from lint, from your project's own rules
- Reviewer's session has no write tools loaded. Not "asked to be read-only." Configured that way
- Large diffs are chunked. Skipped files are reported. Nothing is silently omitted
- Model returns garbage → you get a parse error. Not a silent "no issues found"
- Agent is instructed to invoke it before committing when project rules exist

---

## What makes it different

The agent memory and code review space is full of demos that work in a 5-minute video and break in production. Here's what Triple-pi does differently.

**Memory: a pipeline, not a save button.**

| Common approach | Triple-pi |
|---|---|
| LLM output written directly to disk | 6-stage pipeline; any stage can reject the batch |
| No evidence required — trust the model | Evidence must be a verbatim user message substring |
| LLM picks global/project scope freely | Global auto-downgraded to project without explicit cross-project evidence |
| Overwrite on save, no history | Immutable revision snapshots, proper chain pointers |
| Memory lives forever or gets deleted | 30d hot → 31-90d cold (asks) → >90d archive (renamed, not deleted) |
| Silent on failure | Fail-closed; stage-classified errors; transient retry with backoff |
| No concurrent write protection | Process lock; branch-safe scheduler with generation tracking |

**Reviewer: isolation in code, not in a prompt.**

| Common approach | Triple-pi |
|---|---|
| System prompt: "please don't modify files" | Session configured: no extensions, no skills, no context files loaded |
| No actual tool restriction, trust the model | Tool allowlist `[read, grep, find, ls]` — write tools don't exist in the session |
| No proof files weren't modified | Git status + file hash snapshot before and after the review |
| Raw model output; hope it's valid JSON | Strict schema enforced in code; `passed` ↔ zero findings; parse ≠ schema ≠ semantic failure |
| Full diff dumped into one prompt | Chunked by file and hunk; binary/unreadable skipped with reason; partial coverage recorded |
| Manual memory lookup | Multi-keyword OR-search from diff content, ranked by relevance |

**Evaluation: a system, not an anecdote.**

| Common approach | Triple-pi |
|---|---|
| Run it a few times, screenshot | 178 deterministic + 46 recorded full-pipeline tests |
| "Looks right" | Live eval with exit code semantics: infra failure ≠ semantic failure |
| Noise case "passes" because empty=empty | Noise precision = null, excluded from macro averaging |

---

## Install

Node.js `>=22.19.0` required. Uses [Pi](https://github.com/earendil-works/pi) as the agent runtime.

```bash
git clone --recurse-submodules https://github.com/npm-DreaMaX/Triple-pi.git
cd Triple-pi
npm run setup
```

`npm run setup` builds Pi, installs the extension, and links the `trip` command to `~/.local/bin/` (Linux/macOS). On Windows, add `bin\` to your PATH manually.

### Platform notes

| | Linux | macOS | Windows |
|---|---|---|---|
| Shell | `trip` | `trip` | `trip.bat` or `trip.ps1` |
| Launcher path | `~/.local/bin/trip` | `~/.local/bin/trip` | `<repo>\bin\trip.bat` |
| Restart shell if `trip` not found | `source ~/.zshrc` | `source ~/.zshrc` | restart terminal |

## Usage

```bash
trip
```

Triple-pi's tools are loaded automatically — `SaveMemory`, `SearchMemory`, `review_current_changes`. No separate command, no separate process.

## Usage

After setup, run from any directory:

```bash
trip
```

Triple-pi's tools are loaded automatically — `SaveMemory`, `SearchMemory`, `review_current_changes`.

`trip` is linked to `~/.local/bin/` during setup. If `trip` isn't found, restart your shell or add `~/.local/bin` to your PATH.

## Verify

```bash
npm run typecheck
npm test
npm run eval:recorded
npm run demo
```

---

## Evaluation

| Layer | Runs | Validates |
|---|---|---|
| 178 deterministic tests | Every push, 0 LLM | Code logic: parsing, locking, validation, scheduling |
| 46 recorded pipeline tests | Every push, mock LLM | End-to-end wiring: extraction through commit |
| Live eval | Opt-in, model required | Model quality: precision, recall, noise rejection |

Exit codes: 2 = infra failure, 1 = semantic mismatch, 0 = pass.

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
