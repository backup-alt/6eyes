import { execFile, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// 6eyes — local Laya decision call (zero plan tokens, runs on CPU).
//
// Speed model:
//  - A fresh `laya-router decide` CLI call costs ~12-14s here (python+torch
//    startup, then checkpoint load, then CPU inference — every call).
//  - So we prefer a persistent local server (laya_server.py) that keeps the
//    checkpoint hot: ~1-2s per novel prompt after the first load.
//  - Trivial prompts (greetings/acks/"continue") and repeated exact texts are
//    answered from memory in 0ms.
//  - If the server is unavailable, we fall back to the CLI (unchanged behavior).
//
// Environment variables (all optional — defaults are portable, no absolute paths):
//   LAYA_ROUTER_CMD      laya-router CLI to run                   default "laya-router" (on PATH)
//   LAYA_SERVER_PY       python that runs laya_server.py          default "python3" (posix) / "python" (win32)
//   LAYA_SERVER_URL      base URL of the hot server               default http://127.0.0.1:7801
//   LAYA_TIMEOUT_MS      per-call timeout in ms                   default 25000 (cold CLI ~13s)
//   LAYA_SERVER_WAIT_MS  budget for server warm-up in ms          default 40000
//   LAYA_NO_SERVER       set (to anything) to skip the server and use the CLI only

const LAYA_CMD = (process.env.LAYA_ROUTER_CMD ?? "").trim() || "laya-router"
const LAYA_PY =
  (process.env.LAYA_SERVER_PY ?? "").trim() ||
  (process.platform === "win32" ? "python" : "python3")
const SERVER_SCRIPT = fileURLToPath(new URL("./laya_server.py", import.meta.url))
const SERVER_URL = process.env.LAYA_SERVER_URL ?? "http://127.0.0.1:7801"

// Full cold CLI inference is ~13-14s, so the old 8s timeout made every verdict
// fail. 25s leaves headroom for the CLI fallback path.
const DEFAULT_TIMEOUT_MS = Number(process.env.LAYA_TIMEOUT_MS) || 25_000
// Starting the server includes one checkpoint load; allow it to warm up.
const SERVER_WAIT_MS = Number(process.env.LAYA_SERVER_WAIT_MS) || 40_000

export interface Verdict {
  ok: boolean
  task_type?: string
  complexity?: number
  reasoning?: number
  security?: number
  tools?: number
  risk?: string
  /** Which classifier produced this: "laya" | "heuristic" | "trivial" */
  engine?: string
}

const verdictCache = new Map<string, { v: Verdict; at: number }>()
const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX = 200

const TRIVIAL_RE = /^\s*(@6eyes\b\s*|\/6eyes\b\s*)?(hi+|hello+|hey+|yo|thanks?|thank\s+you|ok|okay|k|sure|yes|no|yep|nope|continue|go|proceed|next|do\s+it|fix\s+it)[!.,]*\s*$/i

function cacheKey(task: string): string {
  return String(task ?? "")
    .replace(/["\r\n]/g, " ")
    .replace(/^\s*(@6eyes\b\s*|\/6eyes\b\s*)/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 300)
}

let serverProc: any = null
let serverStartTried = false
let serverUnavailable = false

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function serverHealth(ms = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), ms)
    const res = await fetch(SERVER_URL + "/health", { signal: ctrl.signal })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}

function startServer(): void {
  if (serverProc || serverStartTried) return
  serverStartTried = true
  try {
    serverProc = spawn(LAYA_PY, [SERVER_SCRIPT], {
      windowsHide: true,
      detached: false,
      stdio: "ignore",
      env: process.env,
    })
    serverProc.on?.("error", () => {
      serverUnavailable = true
    })
    serverProc.unref?.()
  } catch {
    serverUnavailable = true
  }
}

async function ensureServer(): Promise<boolean> {
  if (serverUnavailable) return false
  if (await serverHealth()) return true
  // allow a respawn if the previous child died
  if (serverProc && serverProc.exitCode !== null) {
    serverProc = null
    serverStartTried = false
  }
  startServer()
  const until = Date.now() + SERVER_WAIT_MS
  while (Date.now() < until) {
    await sleep(400)
    if (await serverHealth()) return true
  }
  serverUnavailable = true
  return false
}

async function askServer(text: string, ms: number): Promise<Verdict | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(SERVER_URL + "/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const j: any = await res.json()
    if (j?.status !== "ok") return null
    const a = j.answers ?? {}
    return {
      ok: true,
      task_type: a.task_type?.choice,
      complexity: typeof a.complexity?.score === "number" ? a.complexity.score : undefined,
      reasoning: typeof a.needs_strong_reasoning?.noul === "number" ? a.needs_strong_reasoning.noul : undefined,
      security: typeof a.security_sensitive?.noul === "number" ? a.security_sensitive.noul : undefined,
      tools: typeof a.needs_tools?.noul === "number" ? a.needs_tools.noul : undefined,
      risk: a.risk?.choice,
    }
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

interface Launch {
  file: string
  args: string[]
}

let launch: Launch | null = null

/**
 * Resolve the CLI into something execFile can spawn WITHOUT a shell.
 *
 * Windows note: a `.cmd`/`.bat` shim cannot be spawned directly (libuv returns
 * EINVAL), and spawning it through cmd.exe would put the prompt back into a
 * parsed command line. pip/venv shims are just `<python> -m <module> %*`, so we
 * follow the shim to its interpreter and skip the shell entirely.
 * Anything unresolvable fails open (see cliDecide).
 */
function resolveLaunch(): Launch {
  if (launch) return launch
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(LAYA_CMD)) {
    const shim = readShim(LAYA_CMD)
    if (shim) return (launch = shim)
  }
  return (launch = { file: LAYA_CMD, args: [] })
}

function readShim(path: string): Launch | null {
  try {
    const src = readFileSync(path, "utf8").slice(0, 4096)
    // "C:\...\python.exe" -m laya_router %*    |  "C:\...\python.exe" "C:\...\cli.py" %*
    const m = /["']?([^"'\r\n]*?python[0-9.]*w?\.exe)"?[ \t]+(?:-m[ \t]+([\w.]+)|"([^"\r\n]+\.py)")/i.exec(src)
    if (!m) return null
    const file = m[1]
    const args = m[2] ? ["-m", m[2]] : [m[3]]
    return file ? { file, args } : null
  } catch {
    return null
  }
}

/** Normalise prompt text before it leaves the process: no control chars, capped at 300. */
function sanitize(text: string): string {
  return String(text ?? "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 300)
}

function cliDecide(text: string, timeoutMs: number): Promise<Verdict> {
  return new Promise((resolve) => {
    // execFile with an argv array: the prompt never reaches a shell, so no
    // quoting/escaping can be escaped out of.
    const { file, args } = resolveLaunch()
    const onDone = (err: any, stdout: unknown) => {
      if (err && (err.code === "ENOENT" || err.code === "EACCES" || err.code === "EINVAL")) {
        return resolve({ ok: false })
      }
      try {
        const out = String(stdout ?? "")
        const i = out.lastIndexOf('{"status"')
        if (i < 0) return resolve({ ok: false })
        const j = JSON.parse(out.slice(i))
        if (j.status !== "ok") return resolve({ ok: false })
        const a = j.answers ?? {}
        resolve({
          ok: true,
          task_type: a.task_type?.choice,
          complexity: typeof a.complexity?.score === "number" ? a.complexity.score : undefined,
          reasoning: typeof a.needs_strong_reasoning?.noul === "number" ? a.needs_strong_reasoning.noul : undefined,
          security: typeof a.security_sensitive?.noul === "number" ? a.security_sensitive.noul : undefined,
          tools: typeof a.needs_tools?.noul === "number" ? a.needs_tools.noul : undefined,
          risk: a.risk?.choice,
        })
      } catch {
        resolve({ ok: false })
      }
    }
    try {
      execFile(file, [...args, "decide", text, "--json"], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, onDone)
    } catch {
      // Unspawnable CLI (missing path, non-executable shim) — fail open.
      resolve({ ok: false })
    }
  })
}

/** Classify a task with the local Laya model. Never throws; fails soft. */
export async function decide(task: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Verdict> {
  const key = cacheKey(task)

  // 1) trivial prompts never pay inference cost — Laya scores them cheap anyway
  if (TRIVIAL_RE.test(key)) {
    return { ok: true, task_type: "simple", complexity: 0.5, reasoning: 0, security: 0, risk: "low", engine: "trivial" }
  }

  // 2) exact-text cache (TTL 30 min)
  const hit = verdictCache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.v
  if (verdictCache.size > CACHE_MAX) verdictCache.clear()

  const text = sanitize(task)

  // 3) hot server (fast path)
  if (!process.env.LAYA_NO_SERVER && (await ensureServer())) {
    const v = await askServer(text, timeoutMs)
    if (v) {
      verdictCache.set(key, { v, at: Date.now() })
      return v
    }
  }

  // 4) CLI fallback (cold, ~12-14s)
  const v = await cliDecide(text, timeoutMs)
  if (v.ok) {
    verdictCache.set(key, { v, at: Date.now() })
    return v
  }

  // 5) No Laya anywhere -> deterministic heuristic. Plugs in with zero setup and
  //    still escalates hard/risky work, so installs without laya-router do not
  //    silently pin every task to the cheapest model.
  const h = heuristic(key)
  verdictCache.set(key, { v: h, at: Date.now() })
  return h
}

const HEURISTIC_TYPES: Array<[string, RegExp]> = [
  ["security", /\b(security|vulnerab|exploit|cve|xss|csrf|injection|auth[enz]|oauth|encrypt|secret|credential|permission|threat model)\b/],
  ["architecture", /\b(architect|design|system design|refactor|redesign|migrat|scal(e|ing|ability)|structure|monorepo|decompos|trade-?off)\b/],
  ["debugging", /\b(debug|bug|error|exception|stack ?trace|fails?|crash|regression|root cause|why (is|does|did))\b/],
  ["testing", /\b(test|spec|coverage|unit|integration|e2e|playwright|jest|pytest)\b/],
  ["devops", /\b(docker|kubernetes|k8s|ci\/cd|pipeline|deploy|terraform|nginx|systemd|cron|github actions)\b/],
  ["data", /\b(sql|database|schema|query|etl|migration|analytics|dataframe|pandas)\b/],
  ["documentation", /\b(docs|documentation|readme|changelog|guide|tutorial|write ?up)\b/],
  ["research", /\b(research|compare|evaluate|investigate|survey|benchmark|options for)\b/],
  ["frontend", /\b(ui|ux|css|tailwind|react|vue|svelte|component|layout|responsive|figma)\b/],
  ["ai", /\b(llm|prompt|embedding|rag|model|fine-?tun|inference|agent)\b/],
  ["coding", /\b(implement|add|create|build|write|edit|fix|update|rename|remove|port|convert)\b/],
]

/** Deterministic, dependency-free classifier used only when Laya is absent. */
export function heuristic(task: string): Verdict {
  const t = String(task ?? "").toLowerCase()
  let task_type = "other"
  for (const [name, re] of HEURISTIC_TYPES) {
    if (re.test(t)) {
      task_type = name
      break
    }
  }

  let complexity = 1.0
  if (t.length > 300) complexity += 0.3
  if (t.length > 900) complexity += 0.3
  if (/\b(refactor\w*|migrat\w*|redesign\w*|rewrite|across|entire|all files|multi-?file|whole|architect\w*|full[- ]?(app|site|website|stack|feature)|from scratch|end-to-end)\b/.test(t)) complexity += 0.5
  if (/\b(implement|build|create|add)\b/.test(t) && /\b(and|then|also|plus|\+)\b/.test(t)) complexity += 0.3
  if ((t.match(/\n/g) ?? []).length > 3) complexity += 0.2

  let reasoning = 0.15
  if (/\b(why|explain|design|trade-?off|root cause|prove|reason|analy|optimi[sz]e|decide|compare)\b/.test(t)) reasoning = 0.55
  if (/\b(architect|security|prove|formal|algorithm|concurren)\b/.test(t)) reasoning = 0.7

  let security = 0.05
  if (/\b(security|auth|oauth|secret|credential|encrypt|permission|payment|token|inject)\b/.test(t)) security = 0.6

  let risk: string = "low"
  if (security >= 0.5 || /\b(delete|drop (table|database)|rm -rf|force ?push|production|prod|migrat\w*|irreversible)\b/.test(t)) risk = "high"
  else if (/\b(refactor\w*|rewrite|deploy|release)\b/.test(t)) risk = "medium"

  return {
    ok: true,
    task_type,
    complexity: Math.min(3, Number(complexity.toFixed(4))),
    reasoning: Number(reasoning.toFixed(4)),
    security: Number(security.toFixed(4)),
    tools: 0.2,
    risk,
    engine: "heuristic",
  }
}
