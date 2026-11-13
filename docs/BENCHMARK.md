# Vicem v1.3.0 — Skeleton Cache Hit Rate & Net Token Benchmark

> **100% Reproducible Local Evaluation** — Run `npm run bench` in any clone of this repository to reproduce all measurements below on your own machine with `0` network calls and `0` external dependencies.

## 1. Definitions & Formulas

External engineering reviews rightly note that **initial baton compression alone is an incomplete metric**: if a receiving agent has to call `vicem_rehydrate` on every elided function body, RPC round-trips would erode token savings. Vicem v1.3.0 instruments `.vicem/metrics.json` (`vicem stats` / `vicem://metrics/cache`) with three CPU-cache-style metrics:

1. **Symbol Cache Hit Rate ($\text{CHR}_{\text{symbol}}$)** — Share of skeletonized functions whose L1 representation in `BATON.md` (signature + `[pure]`/`[effects: ...]` tag + 1-hop call graph) satisfied the task **without** L2 body rehydration:
   $$\text{CHR}_{\text{symbol}} = \left(1 - \frac{|S_{\text{rehydrated}}|}{\max(1, N_{\text{skeletonized}})}\right) \times 100\%$$
2. **Token-Weighted Cache Hit Rate ($\text{CHR}_{\text{token}}$)** — Share of elided body tokens that remained un-fetched across the entire session.
3. **Net Effective Token Reduction ($\text{NTR}$)** — True end-to-end savings **after charging both the initial `BATON.md` tokens AND every `vicem_rehydrate` JSON-RPC response**:
   $$\text{NTR} = \left(1 - \frac{T_{\text{baton}} + \sum_{i=1}^{k} T_{\text{rehydrate\_resp}, i}}{T_{\text{raw}}}\right) \times 100\%$$

---

## 2. Standard Handoff Scenarios (Polyglot JS/TS/Python Corpus)

Measured on Node `v25.9.0` (`darwin-arm64`) across a 125-symbol polyglot workspace (`src/engine.mjs`, `src/security_service.ts`, `app/etl.py`):

| Scenario | Workload | Raw Context | Baton + All Rehydrate RPCs | Rehydrated Symbols | Skeleton Cache Hit Rate | Net Effective Savings (NTR) | Avg RPC Latency |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **`S0-HotFix`** | Active Diff/Error Bugfix (Hot-Expanded, 0 RPCs) | 66.3k | 5.0k | 0 / 124 (0 RPCs) | **100%** (100% tok) | **-92.4%** | 0 ms |
| **`S1-Bugfix`** | Targeted Bugfix (2 symbols) | 66.2k | 5.3k | 2 / 125 (2 RPCs) | **98.4%** (99.1% tok) | **-92.1%** | 15.32 ms |
| **`S2-Refactor`** | Module Refactor (5 roots + 1-hop callees) | 66.2k | 9.9k | 11 / 125 (5 RPCs) | **91.2%** (95.3% tok) | **-85%** | 31.55 ms |
| **`S3-Audit`** | Effect-Guided Security Audit (v1.3.0 vs Blind) | 66.2k | 5.4k | 4 / 125 (4 RPCs) | **96.8%** (98.9% tok) | **-91.9%** | 10.9 ms |

### Impact of v1.3.0 AST Side-Effect Tags (`S3-Audit` Ablation)

When auditing `src/security_service.ts` and `app/etl.py` (10 total functions) for filesystem writes (`fs-write`) and subprocess execution (`proc`):
- **Without Effect Tags (v1.2.0 Blind Inspection)**: Agent must rehydrate all **10** functions to check their bodies.
- **With `[pure]` & `[effects: fs-write, proc]` + 1-Hop Propagation (v1.3.0)**: Agent skips `[pure]` and `[effects: fs-read]`-only functions (while still catching `enforceAndAuditAccess` via 1-hop transitive propagation from `persistAuditTrail`), requiring only **4** rehydrations (**-60% fewer MCP tool calls**).

---

## 3. Stress Test & Honest Break-Even Curve (`S4-Stress`)

Skeletonization is designed for **targeted bugfixes, feature continuations, and code reviews** where 1–30% of functions require body edits. Below is the measured degradation curve as an agent rehydrates larger fractions of the entire codebase:

| % of Codebase Rehydrated | Symbol Cache Hit Rate | Token Cache Hit Rate | Consumed / Raw Tokens | Net Effective Savings (NTR) | Recommended Strategy |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **10%** (13/125 syms) | 89.6% | 94.9% | 8.6k / 66.2k | **-87%** | Use Skeleton + Rehydrate |
| **30%** (38/125 syms) | 69.6% | 73% | 31.4k / 66.2k | **-52.6%** | Use Skeleton + Rehydrate |
| **50%** (57/125 syms) | 54.4% | 53.7% | 51.5k / 66.2k | **-22.2%** | Use Skeleton + Rehydrate |
| **80%** (87/125 syms) | 30.4% | 24.5% | 85.0k / 66.2k | **+28.4% (Overhead)** | Read Raw File Directly |
| **100%** (111/125 syms) | 11.2% | 7.6% | 103.4k / 66.2k | **+56.2% (Overhead)** | Read Raw File Directly |

> **Engineering Takeaway:** As long as a task edits or inspects **$\le 60\%$** of skeletonized functions in ranked files (break-even point $\approx 65\%$), selective MCP rehydration yields net positive token savings. When rewriting **$> 70\%$** of a single file from scratch, reading the file directly from disk is simpler and incurs fewer round-trips.

---

## 4. Architectural Comparison vs. Existing Repo Packers

Measured on Apple M2 Pro (`darwin-arm64`, Node `v25.9.0`, `/usr/bin/time -l` median of 5 runs, OpenAI `o200k_base` BPE tokenizer) across an `87,460`-token polyglot JS/TS/Python/JSON repository (`70,682` code-only tokens):

| Tool / Architecture Category | Install Footprint (Deps) | Median Time | Peak RSS | Output (`o200k_base`) | Reduction | Reversible (`rehydrate`) | Secret / Injection Guard |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Vicem v1.3.0 (`diet` — Task Baton + Hot-Expand)** | **0.47 MB (`0`)** | **133 ms** | **55 MB** | **1,051 tok** | **-98.8%** | **Yes (active fn inline)** | **Redacted / Defanged** |
| **Vicem v1.3.0 (`vicem map` — Whole-Repo Map)** | **0.47 MB (`0`)** | **161 ms** | **77 MB** | **8,678 tok** | **-90.1%** | **Yes (221 symbols)** | **Redacted / Defanged** |
| **Vicem v1.3.0 (`--compact-all` Full Baton)** | **0.47 MB (`0`)** | **219 ms** | **77 MB** | **9,721 tok** | **-88.9%** | **Yes (221 symbols)** | **Redacted / Defanged** |
| Tree-sitter WASM Repo Packer (`--compress`, Full) | ~102 MB (`84`) | 333 ms | 208 MB | 18,587 tok | -78.7% | No (one-way deletion) | Secrets only / Injection leaked |
| Tree-sitter WASM Repo Packer (`--compress`, Code-Only) | ~102 MB (`84`) | 331 ms | 207 MB | 9,844 tok | -86.1%* | No (one-way deletion) | Secrets only / Injection leaked |
| Standard XML Repo Packer (Default) | ~102 MB (`84`) | 274 ms | 164 MB | 79,934 tok | -8.6% | Full raw dump | Leaked / Leaked |
| Python Repo Ingestor | ~25 MB | 419 ms | 145 MB | 79,650 tok | -8.9% | Full raw dump | Leaked / Leaked |
| Raw File Concatenator | ~0.2 MB | 36 ms | 18 MB | 87,537 tok | 0% | Full raw dump | Leaked / Leaked |

*On code-only files (`70,682` raw tokens, excluding JSON fixtures), `vicem map` produces **8,583 tok (-87.9%)** in **160 ms** while preserving 100% symbol reversibility in `.vicem/ledger.json`.
