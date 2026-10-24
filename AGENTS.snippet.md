<!-- VICEM-AGENTS-SNIPPET -->
## Vicem Baton & Context Diet Protocol

- If `.vicem/BATON.md` exists in the workspace, read it before starting work and execute **Section 2 (`Immediate NEXT #1`)**.
- **Safety Rule (`SkeletonWriteGuard`):** Code blocks in `.vicem/BATON.md` may contain skeletonized function bodies (`/* ... */` or `pass`) and redacted secrets (`‹REDACTED:PROVIDER:HASH4›`). **Never** write these placeholders into real source files.
- If you need the full implementation of a skeletonized function, call the MCP tool `vicem_rehydrate(file_path, symbol_name)` or read the source file directly before editing.
- Before finishing or handing back work, run `node vicem.mjs guard` to verify zero placeholder or redaction token leaks.
