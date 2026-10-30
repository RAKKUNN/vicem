# Compatibility verification — 2026-10-30

| Environment | Result | Scope |
|---|---|---|
| macOS ARM64, Node 25.9.0 | 767 tests passed; 1 Windows-only test deferred to native CI | Complete automated suite, local GUI checks |
| Ubuntu 24.04 ARM64 VM, Node 22.23.4 | 764/764 tests passed | Complete automated suite; actual Linux kernel 6.8.0-101-generic |
| Native Windows GitHub runner, Node 22 and 24 | CI passed | CLI startup, portable handoff contracts, safety tests, npm pack/install and installed-package smoke checks |
| Native macOS and Ubuntu GitHub runners, Node 22 and 24 | CI passed | Same portable and package checks |
| Windows x64 Node 22.23.4 under Wine 7.7 on macOS | 7 compatibility checks + 6 safety tests passed | Windows runtime compatibility layer, not a Windows kernel or desktop certification |
| Codex CLI 0.165.0-alpha.1.2 on macOS | Read proof passed | Synthetic baton; read a token that was changed after baton creation |
| Claude Code 2.1.308 on macOS | Read proof passed | Synthetic baton; read a token that was changed after baton creation |

## Reproduce

Run `npm run test:compat` for the portable contract and `npm test` for the full suite.
The compatibility workflow runs portable and safety tests on macOS, Ubuntu and Windows with Node 22 and 24, then packs, installs, and executes the distributable.

[Native CI evidence — all six jobs passed](https://github.com/RAKKUNN/vicem/actions/runs/41040234570), commit `64c162f62ce4bd13c34b2904f530d89a40e6ddf4`. The current workflow additionally checks GUI failure recovery and executes the copied PowerShell command on Windows, including a missing-directory failure. These are automated headless checks, not desktop usability certification.

## Findings fixed

- Nonzero CLI child exits and signals are reported as failures.
- Headless launches have a two-minute default timeout; callers can supply `timeoutMs`.
- `wrap agent --dry-run` no longer launches the agent. `wrap agent -- ...` explicitly passes remaining arguments through.
- Missing wrapped agents return exit 127 instead of an unhandled process error.
- Setup launchers stop on failure instead of printing success.
- GUI missing binaries/terminal launch verification failures no longer report launch success.

## Limits

Wine's inherited pipe handles produced `EBADF` with Windows Node. Redirecting output to regular files allowed the tests above to pass. This is not evidence that native Windows has the same issue.
Native Windows desktop/terminal launch, Linux graphical terminal launch, and installed-agent flows on those operating systems remain unverified. No Windows VM was available. Codex and Claude were tested with synthetic data and constrained/read-only execution, not a complete production-project migration. Antigravity was the synthetic source label, not an automated real source-app round trip. The product still reports reception as unconfirmed; the read proof is test evidence, not a shipped automatic acknowledgment protocol.


## Support shown in the product

- Windows is labeled **Windows Preview**. Native CLI/package checks passed on Node 22 and 24; desktop app and terminal auto-launch remain best effort.
- macOS and Linux also show the verified CLI/package scope, a CI evidence link, and the desktop limitation.
- Saving or launching a handoff never implies that the receiving agent has read it. Reception remains unconfirmed.

## If automatic launch fails

The saved `.vicem/BATON.md` remains available. GUI results show **Your handoff is saved**, a copyable OS-specific command, a copyable start prompt, and the saved file path. CLI launch failures return the same manual guide in JSON and print it in interactive output.

1. Run the supplied command when the destination CLI is installed, or open the destination app manually.
2. Select the project folder shown in the guide.
3. Paste the start prompt so the agent reads `.vicem/BATON.md` and continues from Section 2.
4. Check the destination conversation to confirm that it read the handoff.

PowerShell commands quote literal paths, including spaces and apostrophes, and stop if the project folder cannot be selected. For destinations without a known CLI command, the guide explicitly tells users to open the destination manually.
