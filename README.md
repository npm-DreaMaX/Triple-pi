# Triple-pi

Persistent memory and project-aware code review for the [Pi coding agent](https://github.com/earendil-works/pi). Built as a Pi extension — does not modify runtime source.

[![CI](https://github.com/npm-DreaMaX/Triple-pi/actions/workflows/ci.yml/badge.svg)](https://github.com/npm-DreaMaX/Triple-pi/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## What it does

Two modules, one repository:

| Module | Description |
|---|---|
| **Memory** | Extracts project rules, decisions and preferences from agent conversations. Injects them into future sessions so the agent remembers your project context across sessions. |
| **Reviewer** | Spawns a read-only sub-agent to check staged and unstaged changes against your project's memory before you commit. |

Memory and Reviewer share one `FilesystemMemoryRepository` — rules you save are available to both modules.

---

## Install

```bash
git clone --recurse-submodules https://github.com/npm-DreaMaX/Triple-pi.git
cd Triple-pi
npm run setup          # Build Pi, install deps, symlink the extension
```

Requires Node.js `>=22.19.0`.

`npm run setup` installs `extensions/` into Pi's agent directory as the `triple-pi` extension. The extension registers `SaveMemory`, `SearchMemory`, `delegate_review`, and `review_current_changes` tools. It also hooks into `agent_settled` (auto-extraction) and `before_agent_start` (memory injection).

---

## Verify

```bash
npm run typecheck      # TypeScript strict mode
npm test               # 178 deterministic tests (no network, no LLM)
npm run eval:recorded   # 46 full-pipeline tests with mock LLM
npm run demo            # Offline end-to-end smoke test
```

Live evaluation against real models is opt-in:

```bash
TRIPLE_PI_EVAL_MODEL=<provider>/<model> npm run eval:live
```

---

## What this project adds on top of Pi

Pi ships with a Memory tool (file I/O for a `/memories` directory) and SubAgent session templates. They work for demos.

This project adds the parts that make them usable outside of demos:

- **Extraction pipeline.** Pi's stock Memory tool saves whatever the agent asks it to save. Triple-pi adds a 6-stage automatic extraction pipeline (redact → extract → validate → review → consolidate → commit). Each stage can reject the batch. If any stage fails, nothing is written.
- **Evidence grounding.** Every automatically extracted record carries a `provenance.evidence` field — a verbatim quote from a user message. The LLM cannot fabricate evidence. Assistant text is never accepted as a source.
- **Deterministic scope resolution.** A candidate marked `global` by the LLM is downgraded to `project` unless the user's quoted evidence explicitly states cross-project intent. No extra confirmation dialog, no user interruption — the code decides.
- **Grounded review.** A second LLM call reviews extraction candidates. It can only keep or remove them. It cannot rewrite titles, content, or evidence. The schema is enforced — any attempt to modify a field causes rejection.
- **Immutable revision history.** Every update to a record saves the prior version to `revisions/`. The chain is a proper linked list (`previousRevisionId` links to the prior snapshot), not a self-referencing pointer.
- **Lifecycle state machine.** 0-30 days hot, 31-90 days cold (asks before injecting), >90 days auto-archived (renamed, not deleted). Project isolation is based on `realpath(cwd)`, not git remote, so monorepo subdirectories are naturally separate.
- **Branch-safe extraction.** The scheduler tracks `generation + sessionId + branchLeafId` per job. A checkpoint from a discarded branch cannot commit to the current tree.
- **Reviewer isolation through ResourceLoader, not prompts.** The reviewer session is created with `noExtensions: true`, `noSkills: true`, `noContextFiles: true`. Only `read`, `grep`, `find`, `ls` are loaded. Pi's tool registry enforces the allowlist — the model cannot request a write tool because none exists in the session.
- **Worktree snapshot verification.** Git status and file hashes are captured before and after the review. If they differ, the result is `worktree-changed`, not a silent "no files modified."
- **Strict output schema.** `passed` requires zero findings. `issues_found` requires at least one. `description` must be non-empty. `line` must be a positive integer. Severity must be `low | medium | high`. JSON parse failure and schema violation are distinct outcomes and never reported as "no issues found."
- **Chunked diff review with partial coverage tracking.** Files are chunked by hunk. If the diff exceeds the budget, skipped files are recorded explicitly. The result carries a `coverage` field (`complete` or `partial`). Nothing is silently dropped.
- **Three-layer eval with exit-code semantics.** 178 deterministic tests (0 network, 0 LLM) run on every push. 46 recorded full-pipeline tests verify wiring with mock LLM. Live eval is opt-in and exits 2 on infrastructure failure, 1 on semantic mismatch, 0 on all-pass. A noise case does not "pass" because the repository happened to be empty after a crash.

---

## Storage layout

```
~/.triple-pi/memory-v1/
├── global/entries/                 # Shared across all projects
├── projects/<id>/entries/          # Per-project records
├── projects/<id>/revisions/        # Immutable record history
├── projects/<id>/working/          # Scratchpad and daily timeline
├── archive/projects/<id>/          # Auto-archived after 90 days of inactivity
├── extractions/<project-id>/       # Idempotent source manifests
└── signals/<project-id>/           # Reinforcement state
```

Project identity is derived from `realpath(cwd)`. To share memory across different clone paths, drop a `.triple-pi/project.json` with a stable `projectId` in the project root.

---

## Lifecycle

| Inactivity | State | Behavior |
|---|---|---|
| 0–30 days | hot | Memory injected normally. Activity marker refreshed on each session. |
| 31–90 days | cold | On next session start, asks whether to restore project memory. If declined, project memory stays cold this session; global memory remains visible. |
| >90 days | archive-due | On next session start, the project directory is atomically renamed into `archive/`. A notification is shown. Restorable with `/memory-restore`. |

Archived projects reject writes. Global records and manual saves are never archived.

---

## Project structure

```
extensions/
├── index.ts                  # Unified entry point
├── memory/
│   ├── index.ts              # Extension lifecycle, tools, hooks
│   ├── repository.ts         # Locking, atomic I/O, search, revisions
│   ├── domain.ts             # Shared types
│   ├── project-identity.ts   # cwd → project ID resolution
│   ├── validation.ts         # Manual and automatic write validation
│   ├── working-state.ts      # Session working state management
│   └── extraction/           # Automatic extraction pipeline
└── subagent/
    ├── index.ts              # Reviewer tool registration
    ├── manager.ts            # Session creation, timeout, cleanup
    ├── review-core.ts        # Git diff collection, search, chunking, parsing
    └── types.ts              # Discriminated result types

eval/     # Evaluation harness (3-layer)
docs/     # Design docs, interview prep, demo runbook
test/     # 21 files, 178 tests
scripts/  # Installer, status diagnostics, demo
```

---

## Limitations

- Search is keyword-based (substring match on title + content). No semantic or vector retrieval.
- Secret redaction covers common patterns (AWS, GitHub, JWT, Bearer, private keys) but not arbitrary custom formats.
- Single-user. No shared or multi-tenant memory.
- File writes use `temp + rename` for atomic visibility, not `fsync`. A power loss during write may lose the in-flight record.

---

## Docs

| | |
|---|---|
| [Memory design](./docs/design/memory.md) | Identity, scope, lifecycle, extraction pipeline |
| [Reviewer design](./docs/design/reviewer.md) | Wiring, diff collection, retrieval, chunking, isolation |
| [Evaluation](./docs/evaluation.md) | Three-layer validation, metrics, evidence contracts |
| [Demo runbook](./docs/demo.md) | Offline end-to-end smoke test |
| [Interview prep](./docs/interview.md) | Common questions, STAR stories, bug stories |
| [History](./docs/history/MEMORY_REBUILD.md) | Design iteration log (historical, not current) |

## License

MIT
