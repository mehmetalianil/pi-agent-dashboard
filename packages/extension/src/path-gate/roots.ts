/**
 * Root set for the agent path gate (D2): workspace (cwd + bound checkout roots),
 * built-in read-only roots (pi agent dir, skills, pi docs, loaded context files)
 * and built-in read+write roots (tmpdir, `/tmp`, session dir). All real-pathed once.
 *
 * The checkout probe starts at `session_start` and is bounded; a decision that
 * needs it waits up to `PROBE_BOUND_MS`, else falls back to cwd only (fail closed).
 * See change: ask-agent-file-access-in-chat.
 */
import * as fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { checkoutRootsAsync, isBoundCheckoutAsync } from "@blackbelt-technology/pi-dashboard-shared/platform/git.js";
import { samePath } from "@blackbelt-technology/pi-dashboard-shared/platform/paths.js";
import type { GateRoots } from "./decide.js";

/** Same per-probe budget `file-read-containment` uses. */
const PROBE_TIMEOUT_MS = 2_000;
/** How long a decision waits for the checkout probe before using cwd only. */
const PROBE_BOUND_MS = 3_000;

export interface PiResources {
  agentDir: string;
  docsDir?: string;
  skillDirs: string[];
  contextFiles: string[];
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Bound checkout roots of `cwd`; `[]` on any failure (never throws). */
async function probeCheckoutRoots(cwd: string): Promise<string[]> {
  try {
    const roots = await checkoutRootsAsync({ cwd, timeout: PROBE_TIMEOUT_MS });
    if (!roots) return [];
    const cands: string[] = [];
    for (const c of [roots.thisCheckout, roots.mainCheckout]) {
      if (c && !cands.some((s) => samePath(s, c))) cands.push(c);
    }
    const bound: string[] = [];
    for (const c of cands) {
      if (await isBoundCheckoutAsync(c, roots.commonDir, { timeout: PROBE_TIMEOUT_MS })) bound.push(realpathOr(c));
    }
    return bound;
  } catch {
    return [];
  }
}

/** Race a promise against a bound; resolves `fallback` on timeout. */
export function withBound<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    t.unref?.();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(fallback); },
    );
  });
}

export interface RootsProviderOptions {
  getCwd: () => string;
  getSessionDir: () => string | undefined;
  getPiResources: () => PiResources;
  probe?: (cwd: string) => Promise<string[]>;
  probeBoundMs?: number;
}

export class RootsProvider {
  private probePromise: Promise<string[]> | null = null;
  private probeCwd: string | null = null;
  private settled: string[] | null = null;
  private probeGen = 0;
  private cachedKey = "";
  private cachedStatic: Omit<GateRoots, "grants" | "workspace"> | null = null;
  private readonly opts: RootsProviderOptions;

  constructor(opts: RootsProviderOptions) {
    this.opts = opts;
  }

  /** Start (or restart for a new cwd) the bounded checkout probe. */
  startProbe(cwdArg?: string): void {
    const cwd = cwdArg ?? this.opts.getCwd();
    if (this.probeCwd === cwd && this.probePromise !== null) return;
    // Generation: a superseded probe (cwd changed while it ran) may still resolve
    // later — it must never publish its checkout root for the NEW cwd.
    const gen = ++this.probeGen;
    this.probeCwd = cwd;
    this.settled = null;
    const probe = this.opts.probe ?? probeCheckoutRoots;
    this.probePromise = withBound(probe(cwd), this.opts.probeBoundMs ?? PROBE_BOUND_MS, [] as string[]).then((r) => {
      if (gen === this.probeGen) this.settled = r;
      return r;
    });
  }

  /** Workspace + built-ins. Awaits the probe only when it has not settled yet. */
  async roots(grants: readonly string[], needsCheckout: boolean, cwdArg?: string): Promise<GateRoots> {
    const cwd = cwdArg ?? this.opts.getCwd();
    this.startProbe(cwd);
    // The probe in flight belongs to `cwd` (startProbe above). Use only a result that
    // was published for THIS cwd's generation; anything else means "not known yet".
    const mine = this.probePromise as Promise<string[]>;
    const gen = this.probeGen;
    let checkout: string[] = this.settled ?? [];
    if (this.settled === null && needsCheckout) {
      const r = await mine;
      checkout = gen === this.probeGen && this.probeCwd === cwd ? r : [];
    }
    const workspace = [realpathOr(cwd), ...checkout];
    return { workspace, grants, ...this.staticRoots(cwd) };
  }

  /** True when probe has settled (in-root latency budget applies from then). */
  get probeSettled(): boolean {
    return this.settled !== null;
  }

  private staticRoots(cwd: string): Omit<GateRoots, "grants" | "workspace"> {
    const res = this.opts.getPiResources();
    const sessionDir = this.opts.getSessionDir();
    const key = JSON.stringify([res, sessionDir, cwd]);
    if (this.cachedStatic && key === this.cachedKey) return this.cachedStatic;
    const roSet = new Set<string>();
    const addRo = (p: string | undefined): void => {
      if (!p) return;
      roSet.add(realpathOr(p));
    };
    addRo(res.agentDir);
    addRo(res.docsDir);
    for (const s of res.skillDirs) addRo(s);
    for (const c of res.contextFiles) addRo(c);

    // Resolve symlinked entries inside `res.agentDir` (e.g. ~/.pi/agent/{extensions,scripts,agents,skills,...})
    if (res.agentDir) {
      try {
        for (const ent of fs.readdirSync(res.agentDir, { withFileTypes: true })) {
          if (ent.name === "sessions" || ent.name === "projects") continue;
          if (ent.isSymbolicLink() || ent.isDirectory()) {
            addRo(nodePath.join(res.agentDir, ent.name));
          }
        }
      } catch {
        /* ignore missing or unreadable agentDir */
      }
    }

    // Walk ancestor directories from `cwd` upward: add upstream `.pi/<tool-dir>` (excluding `projects` and `sessions`),
    // `<ancestor>/AGENTS.md`, and `<ancestor>/docs/kb` as read-only roots so downstream project folders can read
    // upstream harness scripts, extensions, skills, and KB docs without exposing sibling projects or granting write access.
    if (cwd) {
      let cur = realpathOr(cwd);
      for (let depth = 0; depth < 8; depth++) {
        const dotPi = nodePath.join(cur, ".pi");
        try {
          if (fs.statSync(dotPi).isDirectory()) {
            for (const ent of fs.readdirSync(dotPi, { withFileTypes: true })) {
              if (ent.name === "projects" || ent.name === "sessions") continue;
              addRo(nodePath.join(dotPi, ent.name));
            }
          }
        } catch {
          /* ignore */
        }
        const agentsMd = nodePath.join(cur, "AGENTS.md");
        try {
          if (fs.existsSync(agentsMd)) addRo(agentsMd);
        } catch {
          /* ignore */
        }
        const docsKb = nodePath.join(cur, "docs", "kb");
        try {
          if (fs.statSync(docsKb).isDirectory()) addRo(docsKb);
        } catch {
          /* ignore */
        }
        const parent = nodePath.dirname(cur);
        if (!parent || parent === cur) break;
        cur = parent;
      }
    }

    const ro = Array.from(roSet);
    const rw = [os.tmpdir(), ...(nodePath.sep === "/" ? ["/tmp"] : []), ...(sessionDir ? [sessionDir] : [])].map(realpathOr);
    this.cachedKey = key;
    this.cachedStatic = { readOnly: ro, readWrite: rw };
    return this.cachedStatic;
  }
}
