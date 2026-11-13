---
name: vicem
description: Zero-dependency AI Agent Context Baton & Diet Suite. Use this skill when handing off coding tasks between AI agents (Claude Code, OpenAI Codex, Antigravity IDE, Cursor, VS Code, Gemini CLI, Web AI), compacting bloated sessions (Context Rot Rescue), or rehydrating skeletonized functions from .vicem/ledger.json.
---

# Vicem (`vicem.mjs`) — Universal Agent Baton & Diet Skill

Vicem packages the active project state, git diff, task progress, and compressed code skeletons into a bookended U-Shaped Attention Baton (`.vicem/BATON.md`), redacts secrets (`‹REDACTED:PROVIDER:HASH4›`), and hands off or compacts sessions in a single command.

## 1. Receiving a Baton (Mandatory Rules for Target Agents)

1. **Read `.vicem/BATON.md` First:**
   - **Zone 1 (Top Primacy Zone):** Read `## 1. Goal` and `## 2. Immediate NEXT` first.
   - **Zone 2 (Middle Evidence Zone):** Review `## 3. Done`, `## 4. Work Evidence (Git Diff & Slimmed Logs)`, and `## 5. Architectural Context (Code Skeletons)`.
   - **Zone 3 (Bottom Recency Anchor):** Begin immediately from **Immediate NEXT #1**.
2. **NEVER Write Skeleton Placeholders or Defanged Tokens to Disk (`SkeletonWriteGuard` & `BatonInjectionGuard`):**
   - Functions `>= 12` lines in Section 5 have their bodies replaced with `/* ... [pure] */`, `/* ... [effects: ...] */`, or `pass  # [effects: ...]` to save tokens while surfacing side effects (`fs-write`, `proc`, `net`, `state`, `fs-read`, `throws`, `async`).
   - **Strictly Forbidden:** Never write `{ ... }`, `/* ... */`, `⋮`, `‹REDACTED:...›`, or `‹DEFANGED:...›` tokens into real source files.
   - **How to Rehydrate:** Call MCP tool `vicem_rehydrate(file_path, symbol_name, include_callees)` (or read the original file directly) before modifying a skeletonized function.

## 2. Daily Zero-Flag Commands

```bash
# Auto-detect active session and pass baton to recommended target
node vicem.mjs

# Hand off to a specific CLI, IDE, or Web AI target
node vicem.mjs codex
node vicem.mjs claude
node vicem.mjs ide
node vicem.mjs web

# Compact current bloated session (Context Rot Rescue)
node vicem.mjs self

# Return baton to previous agent & auto-unmount temporary rule files
node vicem.mjs back

# Restore pre-handoff file snapshot or roll back session
node vicem.mjs rollback

# Install Git pre-commit safety guard hook (+ optional Claude PreCompact/Stop lifecycle hooks)
node vicem.mjs init
node vicem.mjs init --agent-hooks

# Build reversible whole-repo structural map or pin architectural decisions at 100% salience
node vicem.mjs map
node vicem.mjs decide "Keep zero runtime npm dependencies"

# Inspect Skeleton Cache Hit Rate (CHR) & Net Token Reduction (NTR)
node vicem.mjs stats

# Run <50ms zero-spawn environment & agent storage diagnostics
node vicem.mjs doctor

# Apply Web AI clipboard reply safely (4-Pillar Guard + SmartPatchApplier)
node vicem.mjs land
```

## 3. MCP Tools & Resources Provided (`node vicem.mjs mcp`)

- `vicem_create_baton`: Build `.vicem/BATON.md` with AST side-effect tags, 4-layer `BatonInjectionGuard`, and 3-tier Secret Redaction.
- `vicem_read_baton`: Read `.vicem/BATON.md` and check `StalenessDriftGuard` (`git HEAD` drift).
- `vicem_rehydrate(file_path, symbol_name, include_callees)`: SHA-256-checked, secret-redacted AST rehydration from `.vicem/ledger.json` (with live disk drift fallback and `.vicem/metrics.json` telemetry).
- `vicem_check_guard`: Verify diffs against `SkeletonWriteGuard`, `SecretCommitGuard`, `BatonInjectionGuard`, and `StalenessDriftGuard`.
- Resources: `vicem://baton/current`, `vicem://ledger/index`, `vicem://salience/report`, `vicem://metrics/cache`.
