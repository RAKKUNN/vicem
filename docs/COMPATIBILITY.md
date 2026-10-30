# Compatibility verification — 2026-10-30

| Environment | Result | Scope |
|---|---|---|
| macOS ARM64, Node 25.9.0 | 764/764 tests passed | Complete automated suite, local GUI checks |
| Ubuntu 24.04 ARM64 VM, Node 22.23.4 | 764/764 tests passed | Complete automated suite; actual Linux kernel 6.8.0-101-generic |
| Windows x64 Node 22.23.4 under Wine 7.7 on macOS | 7 compatibility checks + 6 safety tests passed | Windows runtime compatibility layer, not a Windows kernel or desktop certification |
| Codex CLI 0.165.0-alpha.1.2 on macOS | Read proof passed | Synthetic baton; read a token that was changed after baton creation |
| Claude Code 2.1.308 on macOS | Read proof passed | Synthetic baton; read a token that was changed after baton creation |

## Reproduce

Run `npm run test:compat` for the portable contract and `npm test` for the full suite.
The compatibility workflow runs portable and safety tests on macOS, Ubuntu and Windows with Node 22 and 24. It has been added locally; no hosted workflow run is claimed.

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
