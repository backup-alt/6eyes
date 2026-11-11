// 6eyes / Graphify — lightweight codebase graph mapper.
// Walks the project, extracts import edges (JS/TS/Python, regex heuristics),
// counts definitions, and caches incrementally by file mtime in .6eyes/graph.json.
// Honest scope: navigation aid, not a compiler-grade AST.

import fs from "node:fs"
import path from "node:path"

const SKIP = new Set([
  "node_modules", ".git", "dist", "build", ".next", "target", "__pycache__",
  ".venv", "venv", ".6eyes", ".opencode", ".playwright-mcp", ".pnpm-store", ".impeccable",
])
const EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".java", ".go", ".rs", ".cs"])
const MAX_FILES = 4000
const TIME_BUDGET_MS = 15_000

export function mapPath(dir: string): string {
  return path.join(dir, ".6eyes", "graph.json")
}

function walk(dir: string, out: string[], deadline: number): void {
  if (out.length >= MAX_FILES || Date.now() > deadline) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) walk(abs, out, deadline)
    else if (e.isFile() && EXTS.has(path.extname(e.name).toLowerCase())) out.push(abs)
  }
}

function importsOf(text: string, rel: string, all: Set<string>): string[] {
  const res: string[] = []
  if (rel.endsWith(".py")) {
    const fileDir = path.posix.dirname(rel)
    // Candidate resolution: normalize, skip empties/self, keep only files that exist in the walk.
    const add = (candidates: string[]): void => {
      for (const raw of candidates) {
        const c = path.posix.normalize(raw)
        if (!c || c === "." || c === rel) continue
        if (all.has(c)) res.push(c)
      }
    }
    for (const m of text.matchAll(/^\s*from\s+([\w.]*)\s+import\s+([^\n]+)/gm)) {
      const spec = m[1]
      // Imported names let `from . import constants` resolve constants.py instead of the package itself.
      const names = m[2]
        .replace(/[()\\]/g, " ")
        .split(",")
        .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
        .filter((n) => /^\w+$/.test(n))
      const dots = /^\.*/.exec(spec)?.[0].length ?? 0
      if (dots === 0 && spec !== "") {
        // Absolute: `pkg.mod` -> pkg/mod.py | pkg/mod/__init__.py
        const p = spec.replace(/\./g, "/")
        add([p + ".py", p + "/__init__.py"])
        continue
      }
      // Relative: one leading dot is the current package dir, each extra dot climbs a level.
      let base = fileDir
      for (let i = 1; i < dots; i++) base = path.posix.dirname(base)
      const remainder = spec.slice(dots).replace(/\./g, "/")
      if (remainder) {
        const target = path.posix.join(base, remainder)
        add([target + ".py", target + "/__init__.py"])
      } else if (names.length > 0) {
        // `from . import constants, utils` -> resolve each name inside the package dir.
        for (const name of names) add([path.posix.join(base, name) + ".py", path.posix.join(base, name) + "/__init__.py"])
      } else {
        // Bare `from . import` (no names): fall back to the package initializer.
        add([base + "/__init__.py"])
      }
    }
    for (const m of text.matchAll(/^\s*import\s+([\w.]+)/gm)) {
      const p = m[1].replace(/\./g, "/")
      add([p + ".py", p + "/__init__.py"])
    }
  } else {
    const specs: string[] = []
    for (const m of text.matchAll(/(?:import|export)[\s\S]{0,120}?from\s+['"]([^'"]+)['"]/g)) specs.push(m[1])
    for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1])
    for (const s of specs) {
      if (!s.startsWith(".")) continue
      const t = path.posix.normalize(path.posix.join(path.posix.dirname(rel), s))
      for (const c of [t, t + ".ts", t + ".tsx", t + ".js", t + ".mjs", t + "/index.ts", t + "/index.js"]) {
        if (all.has(c)) {
          res.push(c)
          break
        }
      }
    }
  }
  return [...new Set(res)]
}

/** Build (or incrementally refresh) the project graph. Never throws. */
export async function buildMap(dir: string, prev: any): Promise<any> {
  const deadline = Date.now() + TIME_BUDGET_MS
  const files: string[] = []
  walk(dir, files, deadline)
  const rels = files.map((f) => path.relative(dir, f).replace(/\\/g, "/"))
  const all = new Set(rels)
  // v2 changed import resolution (relative Python imports), so never reuse v1 edge caches
  const prevNodes = new Map<any, any>(
    prev?.v === 2 ? (prev?.nodes ?? []).map((n: any) => [n.f, n]) : [],
  )
  const nodes: any[] = []
  const edges: [string, string][] = []
  for (let i = 0; i < files.length; i++) {
    const rel = rels[i]
    let mtime = 0
    try {
      mtime = fs.statSync(files[i]).mtimeMs
    } catch {}
    const cached = prevNodes.get(rel)
    if (cached && cached.m === mtime) {
      nodes.push(cached)
      for (const t of cached.e ?? []) edges.push([rel, t])
      continue
    }
    let defs = 0
    let e: string[] = []
    try {
      const text = fs.readFileSync(files[i], "utf8")
      defs = (text.match(/\b(?:function|class|def|interface|struct|enum)\s+\w+/g) ?? []).length
      e = importsOf(text, rel, all)
    } catch {}
    const node = { f: rel, d: defs, m: mtime, e }
    nodes.push(node)
    for (const t of e) edges.push([rel, t])
  }
  return {
    v: 2,
    builtAt: new Date().toISOString(),
    truncated: files.length >= MAX_FILES || Date.now() > deadline,
    nodes,
    edges,
  }
}

/** Compact digest for prompt injection and the HTML report. */
export function digestOf(map: any, prevNodeList?: any): any {
  if (!map) return null
  const indeg = new Map<string, number>()
  for (const [, to] of map.edges ?? []) indeg.set(to, (indeg.get(to) ?? 0) + 1)
  const hubs = [...indeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([f]) => f)
  let changed: string[] = []
  if (prevNodeList) {
    const prev = new Set(prevNodeList)
    changed = (map.nodes ?? []).map((n: any) => n.f).filter((f: string) => !prev.has(f)).slice(0, 20)
  }
  return {
    files: (map.nodes ?? []).length,
    edges: (map.edges ?? []).length,
    hubs,
    changed,
    builtAt: map.builtAt,
    truncated: !!map.truncated,
  }
}
