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
2. **NEVER Write Skeleton Placeholders to Disk (`SkeletonWriteGuard`):**
   - Functions `>= 12` lines in Section 5 have their bodies replaced with `/* ... */` or `pass` to save tokens.
   - **Strictly Forbidden:** Never write `{ ... }`, `/* ... */`, `⋮`, or `‹REDACTED:...›` tokens into real source files.
   - **How to Rehydrate:** Call MCP tool `vicem_rehydrate(file_path, symbol_name)` (or read the original file directly) before modifying a skeletonized function.

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

# Install idempotent Git pre-commit safety guard hook
node vicem.mjs init

# Run <50ms zero-spawn environment & agent storage diagnostics
node vicem.mjs doctor

# Apply Web AI clipboard reply safely (2-Phase Guard + SmartPatchApplier)
node vicem.mjs land
```

## 3. MCP Tools Provided (`node vicem.mjs mcp`)

- `vicem_create_baton`: Build `.vicem/BATON.md` with 4-stage Context Diet and 3-tier Secret Redaction.
- `vicem_read_baton`: Read `.vicem/BATON.md` and check `StalenessDriftGuard` (`git HEAD` drift).
- `vicem_rehydrate(file_path, symbol_name)`: Retrieve omitted raw function/method bodies from `.vicem/ledger.json`.
- `vicem_check_guard`: Verify diffs against `SkeletonWriteGuard` and `SecretCommitGuard`.
