# Changelog

## 0.2.0 — 2026-11-11

Multi-plan release. Works out of the box on OpenCode Free, Go, Go Plus, Go Teams and Zen.

### Changed
- **Package renamed to `6eyes-limitless`** (`npm i 6eyes-limitless`), repository set to https://github.com/backup-alt/6eyes. Plugin id stays `6eyes`, so the `/6eyes` command and `@6eyes` are unchanged.

### Added
- **Automatic plan detection** — at startup the plugin inspects connected providers: `opencode-go` means a paid plan, otherwise `free`. `OPENCODE_PLAN` / `plan` still override it for exact Plus/Teams caps.
- **Free-tier load balancing** — requests are spread across the best three free models (least-used first) so a single daily request cap is not burned while the others idle.
- **Auth-failure routing** — a 401/402/403 cools that model for an hour so routing moves to a model the account can actually use.
- **Plan-aware catalog (v2)** — one `catalog.json` covers `free`, `go`, `plus`, `teams` and `zen`, with per-model monthly allowances for each paid plan (verified against the OpenCode Go docs).
- **`OPENCODE_PLAN`** env var and `plan` plugin option; `resolvePlan()` normalizes `go-plus`/`go-teams` aliases.
- **Derived caps** — 5-hour and weekly limits computed from the monthly allowance (`limitsRule`), so no plan needs a hand-maintained request table.
- **Never-run-out ladder** — paid cheapest → best-remaining paid → flash → **free models ($0)**. Routing never returns "no model".
- **Free-plan mode** — on `free`, only free-tier models are used, with no key required.
- **Heuristic classifier fallback** — if `laya-router` is absent, a deterministic keyword/size classifier still escalates security, refactor, architecture and debugging work instead of pinning everything to the cheapest model.
- **5-hour window guard** — routing reroutes when a model crosses 20% of its monthly allowance within a 5-hour window, plus an in-context warning at 80%.
- `tsconfig.json` + `npm run typecheck`; `README.md`, `LICENSE`, `CHANGELOG.md`.

### Changed
- `budget.status()` is plan-aware and reports `usd5h`, `usd5hCap`, `reqWeekCap`, `reqMonthCap`.
- `route()` and `auxModel()` take a plan argument; decisions now carry the correct `providerID` (free models live on `opencode`, paid ones on `opencode-go`).
- Budget line in the injected prompt shows `free` instead of `$∞` for unmetered models.
- Graph digest reports changed files and hubs instead of naming a map path.

### Fixed
- **Prompt digest no longer a turn behind** — graph stats are read from the map on disk (and built on demand if missing) instead of the previous turn's cached digest.
- **Portability** — no hardcoded `C:\Users\...` paths. Defaults are `laya-router` on PATH and `python`/`python3`.
- **Command injection** — the classifier is invoked with `execFile(argv)`; prompt text never reaches a shell. Windows `.cmd` shims are resolved to their interpreter.
- **Classifier server binding** — `laya_server.py` always binds `127.0.0.1`; non-loopback `LAYA_HOST` is refused with a warning.
- **Python import edges** — relative imports (`from .x import y`, `from . import x`) resolve correctly; the demo project went from 0 to 25 edges. Graph cache marker bumped to `v2` to invalidate stale maps.
- **`.6eyes/.gitignore`** is created automatically so spend and session IDs never get committed.

## 0.1.2

- Initial working plugin: Laya verdict on prompt, cheap/heavy routing, per-model budget ledger, 429 cooling, `/6eyes` command, HTML report, incremental code graph.
