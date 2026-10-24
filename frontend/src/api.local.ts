/**
 * Seamly's data layer. Same interface the UI was built against (it used to call a FastAPI server), but
 * everything now runs in this browser: videos are analysed by the in-browser engine (src/engine) and
 * analyses/players are kept in IndexedDB. Nothing is uploaded anywhere.
 */
import type { AnalysisMeta, AnalysisResult, EventKey, Insights, Player, PlayerProgress } from "./types";
import * as db from "./engine/store";
import { AnalysisError, backend, optionsFrom, type Options } from "./engine/common";
import type { Overrides, StageA } from "./engine/pipeline";

// the pipeline (and ONNX Runtime with it) is only downloaded when an analysis or an edit runs. After a new
// release the old chunk no longer exists on the server, so a page opened before it can't load it: say so.
const engine = () => import("./engine/pipeline").catch((e) => {
  const stale = /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(String(e?.message ?? e));
  throw stale ? new AnalysisError("Seamly was updated while this page was open. Reload the page, then press Retry.") : e;
});
import { insights as buildInsights } from "./engine/insights";
import { frameObj } from "./engine/body";
import { playerProgress, summarise } from "./engine/progress";
import { BACKUP_VERSION, FILE_NAME, decodeBackup, encodeBackup, type BackupAnalysis } from "./lib/backup";

type Meta = AnalysisMeta & {
  overrides?: Overrides;
  summary?: ReturnType<typeof summarise>;
  previous?: { options: Options; overrides: Overrides } | null;
  input_type?: string;
  started?: number;
  finished?: number;
  gen?: string;     // storage generation of the frames + mesh ("" for imported samples); replaced atomically on re-analysis
  auto_events?: Partial<Record<EventKey, number>>;   // the frames detected automatically (before any marker edits)
  owner?: string;   // tab running/queueing the analysis
};
type StoredPlayer = Omit<Player, "analyses" | "latest_score" | "last_analysis">;

/** How sure the bowling arm is (1 when the user set it), kept with the metadata so lists can mark a guess. */
const autoEvents = (r: AnalysisResult) =>
  Object.fromEntries(Object.entries(r.events).filter(([, e]) => e).map(([k, e]) => [k, e!.frame])) as Partial<Record<EventKey, number>>;
const armConf = (r: AnalysisResult) => (r.bowling_arm.source === "user" ? 1 : Math.round(r.bowling_arm.confidence * 100) / 100);

const now = () => Date.now() / 1000;

// Each tab holds a Web Lock for as long as it is open, so another tab can tell an analysis it is running apart from
// one that was interrupted by a reload.
const TAB = db.newId();
const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
if (locks) void locks.request(`seamly-tab-${TAB}`, () => new Promise<void>(() => undefined)).catch(() => undefined);

async function liveTabs(): Promise<Set<string>> {
  try {
    const q = await locks?.query();
    return new Set((q?.held ?? []).map((l) => l.name ?? ""));
  } catch {
    return new Set();
  }
}

// storage keys: frames and mesh live under the analysis' generation
const fkey = (id: string, gen: string | undefined, f: number) => `${id}/${gen ?? ""}f/${f}`;
const mkey = (id: string, gen: string | undefined, name: string) => `${id}/${gen ?? ""}${name}`;

// ---------------- metadata cache ----------------
const metas = new Map<string, Meta>();
let loaded: Promise<void> | null = null;

function loadAll(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      void db.persist();
      for (const m of await db.all<Meta>("meta")) metas.set(m.id, m);
      // an analysis can't survive a page reload (it runs in the page): put interrupted ones back in a usable state,
      // unless the tab that runs it is still open
      const live = await liveTabs();
      for (const m of metas.values()) {
        if (m.status !== "running" && m.status !== "queued") continue;
        if (m.owner && m.owner !== TAB && live.has(`seamly-tab-${m.owner}`)) continue;
        if (m.previous) {
          await writeMeta(m.id, { status: "done", progress: 1, stage: "done", stage_label: "Complete", options: m.previous.options,
            overrides: m.previous.overrides, previous: null, notice: "The re-analysis was interrupted (the page was closed or reloaded), so the previous result is kept." });
        } else {
          await writeMeta(m.id, { status: "failed", error: "The analysis was interrupted because the page was closed or reloaded. Press Retry to run it again - keep this tab open until it finishes.", previous: null });
        }
      }
    })();
    loaded.catch(() => { loaded = null; });
  }
  return loaded;
}

/** Update an analysis' metadata (a no-op once it has been deleted). */
async function writeMeta(id: string, fields: Partial<Meta>, persist = true): Promise<Meta | undefined> {
  const cur = metas.get(id);
  if (!cur) return undefined;
  const m = { ...cur, ...fields, updated: now() } as Meta;
  metas.set(id, m);
  if (persist) await db.put("meta", id, m);
  return m;
}

/** Re-read an analysis another tab is working on (this tab's copy doesn't see its progress). */
async function refresh(id: string): Promise<void> {
  const m = metas.get(id);
  if (m && (m.status === "running" || m.status === "queued") && m.owner !== TAB) {
    const fresh = await db.get<Meta>("meta", id);
    if (fresh) metas.set(id, fresh); else metas.delete(id);
  }
}

const PUBLIC = ["id", "name", "created", "updated", "status", "progress", "stage", "stage_label", "error", "score", "grade", "view", "arm",
  "thumb_frame", "options", "timing_s", "elapsed", "size_mb", "notice", "suggest", "player_id", "input_type", "arm_conf"] as const;

function pub(m: Meta): AnalysisMeta {
  const out = {} as Record<string, unknown>;
  for (const k of PUBLIC) out[k] = (m as unknown as Record<string, unknown>)[k] ?? null;
  if (m.status === "queued") out.queue_position = queue.indexOf(m.id) + (running ? 1 : 0);
  return out as unknown as AnalysisMeta;
}

function requireMeta(id: string): Meta {
  const m = metas.get(id);
  if (!m) throw new Error("This analysis isn't in this browser. Seamly keeps analyses on the device that made them (nothing is uploaded), so a link only opens there — to share one, use its PDF report.");
  return m;
}

function requireEditable(id: string): Meta {
  const m = requireMeta(id);
  if (m.status !== "done") {
    throw new Error(m.status === "queued" || m.status === "running" ? "This analysis isn't finished yet." : "This analysis has no result to edit. Retry it first.");
  }
  return m;
}

// ---------------- object URLs for frames, mesh, video, exports ----------------
const urls = new Map<string, string>();
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

function setUrl(key: string, blob: Blob) {
  const old = urls.get(key);
  if (old) URL.revokeObjectURL(old);
  urls.set(key, URL.createObjectURL(blob));
}

function dropUrls(id: string) {
  for (const [k, u] of urls) if (k.startsWith(`${id}/`)) { URL.revokeObjectURL(u); urls.delete(k); }
}

async function loadThumb(m: Meta) {
  if (m.status !== "done" || m.thumb_frame === null || m.thumb_frame === undefined) return;
  const key = `${m.id}/f/${m.thumb_frame}`;
  if (urls.has(key)) return;
  const b = await db.get<Blob>("blob", fkey(m.id, m.gen, m.thumb_frame));
  if (b) setUrl(key, b);
}

/** Make every file of a finished analysis addressable by a synchronous URL. */
async function loadFiles(id: string, result: AnalysisResult) {
  const gen = metas.get(id)?.gen;
  const need: Promise<void>[] = [];
  for (let f = result.frames.start; f < result.frames.end; f++) {
    const key = `${id}/f/${f}`;
    if (urls.has(key)) continue;
    need.push(db.get<Blob>("blob", fkey(id, gen, f)).then((b) => { if (b) setUrl(key, b); }));
  }
  for (const name of ["mesh_rest.bin", "pose.bin", "input"]) {
    const key = `${id}/${name}`;
    if (urls.has(key)) continue;
    need.push(db.get<Blob>("blob", name === "input" ? `${id}/input` : mkey(id, gen, name)).then((b) => { if (b) setUrl(key, b); }));
  }
  await Promise.all(need);
  setUrl(`${id}/export.json`, new Blob([JSON.stringify(result)], { type: "application/json" }));
  setUrl(`${id}/export.csv`, new Blob([seriesCsv(result)], { type: "text/csv" }));
  urls.delete(`${id}/obj`);
}

function seriesCsv(r: AnalysisResult): string {
  const series = (r as unknown as { series: Record<string, (number | null)[]> }).series;
  const keys = Object.keys(series);
  const rows = [["frame", "time_s", ...keys].join(",")];
  r.frames.times.forEach((t, i) => rows.push([r.frames.start + i, t, ...keys.map((k) => series[k][i] ?? "")].join(",")));
  return rows.join("\r\n") + "\r\n";
}

const objCache = new Map<string, string>();
function objFor(id: string, frame: number): string {
  const key = `${id}/${frame}`;
  if (objCache.has(key)) return objCache.get(key)!;
  const bufs = meshBufs.get(id), r = results.get(id);
  if (!bufs || !r) return BLANK;
  const txt = frameObj(bufs.rest, bufs.pose, r.mesh, frame - r.frames.start).replace("BowlNet", "Seamly");
  const u = URL.createObjectURL(new Blob([txt], { type: "text/plain" }));
  objCache.set(key, u);
  return u;
}

const results = new Map<string, AnalysisResult>();
const meshBufs = new Map<string, { rest: ArrayBuffer; pose: ArrayBuffer }>();

async function loadResult(id: string): Promise<AnalysisResult | undefined> {
  if (results.has(id)) return results.get(id);
  const r = await db.get<AnalysisResult>("result", id);
  if (r) {
    results.set(id, r);
    const gen = metas.get(id)?.gen;
    const [rest, pose] = await Promise.all([db.get<Blob>("blob", mkey(id, gen, "mesh_rest.bin")), db.get<Blob>("blob", mkey(id, gen, "pose.bin"))]);
    if (rest && pose) meshBufs.set(id, { rest: await rest.arrayBuffer(), pose: await pose.arrayBuffer() });
  }
  return r;
}

// ---------------- job queue (one analysis at a time, in this tab) ----------------
const queue: string[] = [];
let running: string | null = null;

function submit(id: string) {
  if (!queue.includes(id)) queue.push(id);
  void pump();
}

async function pump() {
  if (running || !queue.length) return;
  running = queue.shift()!;
  try {
    await runJob(running);
  } catch (e) {
    console.error("analysis job crashed", e);
  } finally {
    running = null;
    void pump();
  }
}

function describeRerun(m: Meta, prev: { options: Options }): string {
  const nw = Number(m.options?.slowmo_factor ?? 1), old = Number(prev.options?.slowmo_factor ?? 1);
  if (nw !== old) return nw === 1 ? " in real time" : ` at ${nw}x slow motion`;
  return (m.options as unknown as Options | null)?.candidate !== null && (m.options as unknown as Options | null)?.candidate !== undefined ? " of the other delivery" : "";
}

async function runJob(id: string) {
  const meta = metas.get(id);
  if (!meta) return;
  const prev = meta.previous ?? null;
  const t0 = performance.now();
  let lastWrite = 0;
  // the new frames and mesh go under a fresh generation; the previous result stays intact until the commit below
  const gen = `g${Date.now().toString(36)}/`;
  const oldGen = meta.gen ?? "";
  try {
    await writeMeta(id, { status: "running", progress: 0, stage: "probe", stage_label: "Loading models & reading video", started: now(), notice: null, owner: TAB });
    const file = await db.get<Blob>("blob", `${id}/input`);
    if (!file) throw new AnalysisError("The original video is no longer stored in this browser. Analyse it again from the start.");
    const P = await engine();
    const overrides = (meta.overrides ?? {}) as Overrides;
    const run = async () => {
      // display frames are written in batches while the clip is read (240 fps windows are hundreds of frames)
      let batch: [string, unknown][] = [];
      const writes: Promise<void>[] = [];
      const onFrame = (f: number, b: Blob) => {
        batch.push([fkey(id, gen, f), b]);
        if (batch.length >= 24) { writes.push(db.putMany("blob", batch)); batch = []; }
      };
      const out = await P.analyseVideo(file, (meta.options ?? {}) as Partial<Options>, (p) => {
        const t = performance.now();
        const persist = t - lastWrite > 1500;
        if (persist) lastWrite = t;
        void writeMeta(id, { status: "running", progress: p.progress, stage: p.stage, stage_label: p.detail || p.label, elapsed: p.elapsed }, persist);
      }, undefined, onFrame);
      if (batch.length) writes.push(db.putMany("blob", batch));
      await Promise.all(writes);
      return out;
    };
    let A;
    try {
      A = await run();
    } catch (e) {
      // a GPU backend can fail at run time (device lost, driver limits): retry once on WebAssembly
      if (e instanceof AnalysisError || backend() !== "webgpu") throw e;
      console.warn("WebGPU analysis failed; retrying on WebAssembly", e);
      P.useWasmOnly();
      A = await run();
    }
    const { result, mesh } = await P.stageB(A.stageA, await withAgeStature(meta, overrides));
    result.timing_s = Math.round((performance.now() - t0) / 100) / 10;
    await db.putMany("blob", [[mkey(id, gen, "mesh_rest.bin"), new Blob([mesh.rest])], [mkey(id, gen, "pose.bin"), new Blob([mesh.pose])]]);
    const c = result.coaching;
    const cur = metas.get(id);
    if (!cur) throw new AnalysisError("This analysis was deleted.");
    const done = { ...cur, status: "done", progress: 1, stage: "done", stage_label: "Complete", finished: now(), score: c.score, grade: c.grade,
      view: result.view.view, arm: result.bowling_arm.arm, arm_conf: armConf(result), auto_events: overrides.events ? undefined : autoEvents(result),
      thumb_frame: result.events.br.frame, timing_s: result.timing_s,
      summary: summarise(result), error: null, previous: null, suggest: null, elapsed: result.timing_s, gen, overrides, updated: now() } as Meta;
    // one transaction: stage A, result and the metadata pointing at the new generation commit together
    await db.write(["stagea", "result", "meta"], (st) => { st.stagea.put(A.stageA, id); st.result.put(result, id); st.meta.put(done, id); });
    metas.set(id, done);
    dropUrls(id);
    for (const k of [...objCache.keys()]) if (k.startsWith(`${id}/`)) objCache.delete(k);
    results.set(id, result);
    meshBufs.set(id, mesh);
    if (oldGen !== gen) {
      void db.delPrefix("blob", `${id}/${oldGen}f/`).catch(() => undefined);
      void db.del("blob", mkey(id, oldGen, "mesh_rest.bin")).catch(() => undefined);
      void db.del("blob", mkey(id, oldGen, "pose.bin")).catch(() => undefined);
    }
  } catch (e) {
    console.error("analysis failed", e);
    void db.delPrefix("blob", `${id}/${gen}`).catch(() => undefined);
    const err = e as Error | undefined;
    const known = e instanceof AnalysisError;
    const msg = known ? (e as AnalysisError).message
      : `Unexpected error while analysing this video (${err?.name || "Error"}${err?.message ? `: ${err.message}` : ""}). Please try another clip or retry.`;
    if (prev) {
      await writeMeta(id, { status: "done", progress: 1, stage: "done", stage_label: "Complete", finished: now(), error: null, options: prev.options as unknown as AnalysisMeta["options"],
        overrides: prev.overrides, previous: null, notice: `The re-analysis${describeRerun(meta, prev)} didn't work, so the previous result is kept. ${msg}` });
    } else {
      await writeMeta(id, { status: "failed", error: msg, finished: now(), previous: null,
        suggest: known && Object.keys((e as AnalysisError).suggest).length ? (e as AnalysisError).suggest : null });
    }
  }
}

// typical stature (m) for each age group, assumed when no height is entered (adults keep the engine's 1.80 m)
const AGE_STATURE: Record<string, number> = { u11: 1.38, u13: 1.49, u15: 1.61, u17: 1.7, u19: 1.75 };

/** Stage-B overrides plus the stature to assume for the analysis' player when no height was entered. */
async function withAgeStature(meta: Meta, overrides: Overrides): Promise<Overrides> {
  const p = meta.player_id ? await db.get<StoredPlayer>("player", meta.player_id).catch(() => undefined) : undefined;
  const h = p ? AGE_STATURE[p.age_group] : undefined;
  return h ? { ...overrides, default_height_m: h } : overrides;
}

// ---------------- stage B edits ----------------
async function applyEdit(id: string, overrides: Overrides, latest?: EventKey[]) {
  const meta = requireEditable(id);
  const A = await db.get<StageA>("stagea", id);
  if (!A) throw new Error("This analysis can't be edited any more (its working data is missing). Re-analyse it.");
  const { stageB } = await engine();
  const { result, mesh } = await stageB(A, await withAgeStature(meta, latest?.length ? { ...overrides, latest_events: latest } : overrides));
  result.timing_s = meta.timing_s;
  const c = result.coaching;
  const cur = metas.get(id);
  if (!cur) throw new Error("This analysis was deleted.");
  const m = { ...cur, overrides, score: c.score, grade: c.grade, notice: null, summary: summarise(result), arm: result.bowling_arm.arm, arm_conf: armConf(result),
    view: result.view.view, thumb_frame: result.events.br.frame, updated: now() } as Meta;
  // result, mesh and metadata commit together, so they can never disagree
  await db.write(["result", "blob", "meta"], (st) => {
    st.result.put(result, id);
    st.blob.put(new Blob([mesh.rest]), mkey(id, cur.gen, "mesh_rest.bin"));
    st.blob.put(new Blob([mesh.pose]), mkey(id, cur.gen, "pose.bin"));
    st.meta.put(m, id);
  });
  metas.set(id, m);
  results.set(id, result);
  meshBufs.set(id, mesh);
  for (const k of [...objCache.keys()]) if (k.startsWith(`${id}/`)) objCache.delete(k);
  setUrl(`${id}/mesh_rest.bin`, new Blob([mesh.rest]));
  setUrl(`${id}/pose.bin`, new Blob([mesh.pose]));
  setUrl(`${id}/export.json`, new Blob([JSON.stringify(result)], { type: "application/json" }));
  setUrl(`${id}/export.csv`, new Blob([seriesCsv(result)], { type: "text/csv" }));
  return { meta: pub(m), result: result as AnalysisResult };
}

// edits run one at a time per analysis (quick successive marker drags must not drop each other)
const editChain = new Map<string, Promise<unknown>>();
function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const p = (editChain.get(id) ?? Promise.resolve()).then(fn, fn);
  editChain.set(id, p.catch(() => undefined));
  return p;
}

// ---------------- players ----------------
const AGE_GROUPS = ["u11", "u13", "u15", "u17", "u19", "adult"];
const STYLES = ["fast", "medium", "spin"];
const ARMS = ["auto", "right", "left"];

function cleanPlayer(f: Partial<Player>): Partial<StoredPlayer> {
  const out: Partial<StoredPlayer> = {};
  if (typeof f.name === "string" && f.name.trim()) out.name = f.name.trim().slice(0, 60);
  if (f.age_group && AGE_GROUPS.includes(f.age_group)) out.age_group = f.age_group;
  if (f.style && STYLES.includes(f.style)) out.style = f.style;
  if (f.arm && ARMS.includes(f.arm)) out.arm = f.arm;
  if ("height_cm" in f) {
    const h = f.height_cm;
    out.height_cm = typeof h === "number" && h >= 120 && h <= 230 ? h : null;
  }
  return out;
}

function playerOut(p: StoredPlayer): Player {
  const mine = [...metas.values()].filter((m) => m.player_id === p.id && m.status === "done").sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
  const last = mine[mine.length - 1];
  return { ...p, analyses: mine.length, latest_score: last ? last.score ?? null : null, last_analysis: last ? last.created : null } as Player;
}

async function requirePlayer(pid: string): Promise<StoredPlayer> {
  const p = await db.get<StoredPlayer>("player", pid);
  if (!p) throw new Error("This player isn't in this browser. Player profiles are kept on the device where they were created.");
  return p;
}

function newMeta(id: string, name: string, size: number, opts: Partial<Options>, playerId: string | null, type: string): Meta {
  const t = now();
  return { id, name: name.slice(0, 80), created: t, updated: t, status: "queued", progress: 0, stage: null, stage_label: null, error: null,
    score: null, grade: null, view: null, arm: null, thumb_frame: null, options: optionsFrom(opts) as unknown as AnalysisMeta["options"],
    timing_s: null, elapsed: null, size_mb: Math.round((size / 1e6) * 100) / 100, notice: null, suggest: null, player_id: playerId,
    input_type: type, owner: TAB } as Meta;
}

const ALLOWED = [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"];

/** Container signature check (instant), so a renamed photo or document is refused before anything is stored. */
async function looksLikeVideo(file: Blob): Promise<boolean> {
  try {
    const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const ascii = (o: number, n: number) => String.fromCharCode(...b.slice(o, o + n));
    if (ascii(4, 4) === "ftyp" || ["moov", "mdat", "wide", "free", "skip"].includes(ascii(4, 4))) return true;   // MP4 / MOV / 3GP
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true;                         // WebM / MKV (EBML)
    if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "AVI ") return true;                                          // AVI
    return false;
  } catch {
    return true;   // can't read the header: let the decoder decide
  }
}

export const SAMPLES = {
  club: { url: `${import.meta.env.BASE_URL}samples/club-side-on.mp4`, dir: `${import.meta.env.BASE_URL}samples/club/`, id: "c1ab5a3d1e01",
    name: "Sample: club bowler, side-on (real match)" },
  synthetic: { url: `${import.meta.env.BASE_URL}samples/synthetic-side-on.mp4`, dir: `${import.meta.env.BASE_URL}samples/synthetic/`, id: "5e7a5a3d1e02",
    name: "Sample: computer-generated bowler, every angle known exactly (60 fps)" },
};
export type SampleName = keyof typeof SAMPLES;
// bump when the bundled sample analyses are regenerated, so a browser that imported an older copy gets the new one
const SAMPLE_VERSION = 8;

/** Import a precomputed sample analysis (opens instantly: no models to download). */
async function importSample(which: SampleName): Promise<string> {
  const s = SAMPLES[which];
  const have = metas.get(s.id) as (Meta & { sample_version?: number }) | undefined;
  if (have && have.status === "done" && have.sample_version === SAMPLE_VERSION) return s.id;
  const get = async (path: string) => {
    const r = await fetch(s.dir + path);
    if (!r.ok) throw new Error("Couldn't load the sample analysis. Check your connection and try again.");
    return r;
  };
  const bundle = await (await get("bundle.json")).json() as { meta: Partial<Meta>; result: AnalysisResult; stagea: StageA };
  const r = bundle.result;
  const frames: number[] = [];
  for (let f = r.frames.start; f < r.frames.end; f++) frames.push(f);
  const blobs = await Promise.all(frames.map((f) => get(`f/${f}.jpg`).then((x) => x.blob())));
  const [rest, pose] = await Promise.all([get("mesh_rest.bin").then((x) => x.blob()), get("pose.bin").then((x) => x.blob())]);
  const video = await fetch(s.url).then((x) => (x.ok ? x.blob() : null)).catch(() => null);
  const entries: [string, unknown][] = frames.map((f, i) => [`${s.id}/f/${f}`, blobs[i]]);
  entries.push([`${s.id}/mesh_rest.bin`, rest], [`${s.id}/pose.bin`, pose]);
  if (video) entries.push([`${s.id}/input`, video]);
  if (have) await db.delPrefix("blob", `${s.id}/`);   // an older copy of this sample (other frame numbers)
  await db.putMany("blob", entries);
  await db.put("stagea", s.id, bundle.stagea);
  await db.put("result", s.id, r);
  const t = now();
  const m = { ...newMeta(s.id, s.name, video?.size ?? 0, (bundle.meta.options ?? {}) as Partial<Options>, null, "video/mp4"),
    ...bundle.meta, id: s.id, name: s.name, created: t, updated: t, status: "done", progress: 1, stage: "done", stage_label: "Complete",
    error: null, notice: null, player_id: have?.player_id ?? null, gen: "", sample_version: SAMPLE_VERSION, arm_conf: armConf(r),
    auto_events: bundle.meta.overrides?.events ? undefined : autoEvents(r) } as Meta;
  metas.set(s.id, m);
  await db.put("meta", s.id, m);
  results.delete(s.id); meshBufs.delete(s.id); dropUrls(s.id);
  for (const k of [...objCache.keys()]) if (k.startsWith(`${s.id}/`)) objCache.delete(k);
  return s.id;
}

// ---------------- backup / restore ----------------
const SAMPLE_IDS = new Set<string>(Object.values(SAMPLES).map((s) => s.id));
const ID = /^[0-9a-z_-]{4,40}$/i;

/** One file with every finished analysis (the bundled samples excepted: any browser can open those) and every player. */
async function backup(includeVideos: boolean): Promise<{ blob: Blob; analyses: number; players: number }> {
  await loadAll();
  const players = await db.all<StoredPlayer>("player");
  const analyses: BackupAnalysis[] = [];
  const files: Blob[][] = [];
  const done = [...metas.values()].filter((m) => m.status === "done" && !SAMPLE_IDS.has(m.id)).sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
  for (const m of done) {
    const [result, stagea] = await Promise.all([db.get<AnalysisResult>("result", m.id), db.get<StageA>("stagea", m.id)]);
    if (!result || !stagea) continue;
    const named: [string, Blob][] = (await db.entriesWithPrefix<Blob>("blob", `${m.id}/${m.gen ?? ""}f/`))
      .map(([k, b]) => [`f/${k.slice(k.lastIndexOf("/") + 1)}`, b]);
    for (const name of ["mesh_rest.bin", "pose.bin"]) {
      const b = await db.get<Blob>("blob", mkey(m.id, m.gen, name));
      if (b) named.push([name, b]);
    }
    if (includeVideos) {
      const v = await db.get<Blob>("blob", `${m.id}/input`);
      if (v) named.push(["input", v]);
    }
    // what only means something in this browser stays out: the running tab, the storage generation, a pending re-run
    const { owner: _owner, gen: _gen, previous: _previous, ...meta } = m;
    analyses.push({ meta, result, stagea, files: named.map(([name, b]) => ({ name, size: b.size, type: b.type })) });
    files.push(named.map(([, b]) => b));
  }
  const blob = encodeBackup({ app: "seamly", version: BACKUP_VERSION, created: now(), players: players as unknown as Record<string, unknown>[], analyses }, files);
  return { blob, analyses: analyses.length, players: players.length };
}

/** Add the analyses and players of a backup file. Ones already in this browser are kept as they are. */
async function restore(file: Blob): Promise<{ analyses: number; players: number; skipped: number; videos: number }> {
  await loadAll();
  const { header, files } = await decodeBackup(file);
  const free = await db.freeSpace();
  if (free !== null && free < file.size + 50e6) throw new Error("Your browser is short of storage space for this backup. Delete some analyses first, or make the backup without videos.");
  const have = new Set((await db.all<StoredPlayer>("player")).map((p) => p.id));
  let players = 0, analyses = 0, skipped = 0, videos = 0;
  for (const raw of header.players) {
    const p = raw as unknown as StoredPlayer;
    if (typeof p?.id !== "string" || !ID.test(p.id) || have.has(p.id)) continue;
    const clean = cleanPlayer(p as unknown as Partial<Player>);
    if (!clean.name) continue;
    await db.put("player", p.id, { age_group: "adult", style: "fast", arm: "auto", height_cm: null, ...clean, id: p.id, created: Number(p.created) || now() });
    have.add(p.id);
    players++;
  }
  for (let i = 0; i < header.analyses.length; i++) {
    const a = header.analyses[i];
    const m = a?.meta as unknown as Meta | undefined;
    const r = a?.result as AnalysisResult | undefined;
    const valid = m && typeof m.id === "string" && ID.test(m.id) && r && typeof r.frames?.start === "number" && typeof r.frames?.end === "number" && r.events && a.stagea;
    if (!valid) { skipped++; continue; }
    if (metas.has(m.id)) {
      // already here: only fill in the original video if this copy lacks it (a backup made without videos)
      const j = a.files.findIndex((f) => f?.name === "input");
      if (j >= 0 && !(await db.get<Blob>("blob", `${m.id}/input`))) {
        await db.put("blob", `${m.id}/input`, files[i][j]);
        dropUrls(m.id);
        videos++;
      }
      skipped++;
      continue;
    }
    const entries = a.files.map((f, j) => [f?.name, files[i][j]] as const).filter(([name]) => typeof name === "string" && FILE_NAME.test(name));
    const meta = { ...m, status: "done", progress: 1, stage: "done", stage_label: "Complete", error: null, gen: "", owner: undefined, previous: null,
      player_id: m.player_id && have.has(m.player_id) ? m.player_id : null, size_mb: m.size_mb ?? null, arm_conf: m.arm_conf ?? armConf(r) } as Meta;
    await db.write(["blob", "stagea", "result", "meta"], (st) => {
      for (const [name, b] of entries) st.blob.put(b, `${m.id}/${name}`);
      st.stagea.put(a.stagea, m.id);
      st.result.put(r, m.id);
      st.meta.put(meta, m.id);
    });
    metas.set(m.id, meta);
    analyses++;
  }
  return { analyses, players, skipped, videos };
}

export const api = {
  health: async () => ({ ok: true, device: backend() ?? "browser", missing_models: [] as string[] }),
  list: async (): Promise<AnalysisMeta[]> => {
    await loadAll();
    const ms = [...metas.values()].sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    await Promise.all(ms.map(loadThumb));
    return ms.map(pub);
  },
  get: async (id: string): Promise<{ meta: AnalysisMeta; result?: AnalysisResult }> => {
    await loadAll();
    await refresh(id);
    const m = requireMeta(id);
    if (m.status === "done") {
      const r = await loadResult(id);
      if (r) {
        await loadFiles(id, r);
        return { meta: pub(m), result: r };
      }
    }
    return { meta: pub(m) };
  },
  status: async (id: string) => { await loadAll(); await refresh(id); return pub(requireMeta(id)); },
  remove: (id: string) => serial(id, async () => {
    await loadAll();
    await refresh(id);
    const m = requireMeta(id);
    if (m.status === "running") throw new Error("Can't delete while the analysis is running");
    const qi = queue.indexOf(id);
    if (qi >= 0) queue.splice(qi, 1);
    metas.delete(id); results.delete(id); meshBufs.delete(id); dropUrls(id);
    await db.write(["meta", "result", "stagea", "blob"], (st) => {
      st.meta.delete(id); st.result.delete(id); st.stagea.delete(id);
      st.blob.delete(IDBKeyRange.bound(`${id}/`, `${id}/\uffff`));
    });
    return { deleted: id };
  }),
  recompute: (id: string, body: { events?: Partial<Record<EventKey, number | null>>; bowling_arm?: string; height_m?: number; view?: string; slowmo_factor?: number; gender?: number }) =>
    serial(id, async () => {
      await loadAll();
      const meta = requireEditable(id);
      const over: Overrides = {};
      if (body.events) over.events = body.events;
      if (body.bowling_arm) over.bowling_arm = body.bowling_arm as Overrides["bowling_arm"];
      if (body.height_m !== undefined && body.height_m !== null) {
        if (!(body.height_m >= 1.2 && body.height_m <= 2.3)) throw new Error("Height must be between 120 and 230 cm.");
        over.height_m = body.height_m;
      }
      if (body.view) over.view = body.view as Overrides["view"];
      if (body.gender !== undefined) over.gender = body.gender;
      if (body.slowmo_factor !== undefined && Math.abs(body.slowmo_factor - Number(meta.options?.slowmo_factor ?? 1)) > 1e-6) {
        throw new Error("Changing the clip speed needs a re-analysis (it changes the analysis window). Use rerun with slowmo_factor.");
      }
      const prev = meta.overrides ?? {};
      const merged: Overrides = { ...prev, ...over };
      if (over.events) {
        const ev = { ...(prev.events ?? {}), ...over.events };
        // a marker put back on the frame found automatically is no longer an edit
        const auto = meta.auto_events ?? {};
        merged.events = Object.fromEntries(Object.entries(ev).filter(([k, v]) => ["bfc", "ffc", "uah", "br", "ft"].includes(k) && v !== null && v !== undefined
          && auto[k as EventKey] !== v));
      }
      return applyEdit(id, merged, Object.keys(over.events ?? {}) as EventKey[]);
    }),
  reset: (id: string, eventsOnly = false) => serial(id, async () => {
    await loadAll();
    const meta = requireEditable(id);
    const keep: Overrides = eventsOnly ? Object.fromEntries(Object.entries(meta.overrides ?? {}).filter(([k]) => k !== "events")) : {};
    return applyEdit(id, keep);
  }),
  rerun: (id: string, body: { candidate?: number; bowling_arm?: string; height_m?: number; slowmo_factor?: number }) => serial(id, async () => {
    await loadAll();
    await refresh(id);
    const meta = requireMeta(id);
    if (meta.status === "queued" || meta.status === "running") throw new Error("Analysis is already running");
    if (!(await db.get<Blob>("blob", `${id}/input`))) {
      throw new Error("This analysis was restored from a backup made without its video, so it can't be re-analysed here. Marker and settings corrections still work.");
    }
    // corrections made in Settings (height, bowling arm) carry over; event markers belong to the old window
    const prev = meta.overrides ?? {};
    const oldOpts = (meta.options ?? {}) as unknown as Options;
    const carried: Partial<Options> = {};
    if (prev.bowling_arm) carried.bowling_arm = prev.bowling_arm;
    if (prev.height_m) carried.height_m = prev.height_m;
    const req = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null));
    const opts: Partial<Options> = { ...oldOpts, ...carried, ...req };
    if ("slowmo_factor" in req && req.slowmo_factor !== oldOpts.slowmo_factor && !("candidate" in req)) opts.candidate = null;
    const keep: Overrides = prev.gender !== undefined ? { gender: prev.gender } : {};
    const previous = meta.status === "done" ? { options: oldOpts, overrides: prev } : null;
    await writeMeta(id, { options: optionsFrom(opts) as unknown as AnalysisMeta["options"], overrides: keep, error: null, previous, status: "queued", progress: 0, stage: null, suggest: null, owner: TAB });
    submit(id);
    return { id };
  }),
  /** See a sample analysis right away (precomputed). */
  demo: async (which: SampleName = "club") => {
    await loadAll();
    return { id: await importSample(which) };
  },
  /** Run the in-browser analysis on a bundled sample clip (downloads the models the first time). */
  analyseSample: async (which: SampleName = "club") => {
    await loadAll();
    const s = SAMPLES[which];
    const res = await fetch(s.url);
    if (!res.ok) throw new Error("Couldn't load the sample clip.");
    const blob = await res.blob();
    const id = db.newId();
    await db.put("blob", `${id}/input`, blob);
    const m = newMeta(id, s.name.replace("Sample:", "Sample clip:"), blob.size, { bowling_arm: "auto", height_m: which === "synthetic" ? 1.8 : null, slowmo_factor: 1 }, null, "video/mp4");
    metas.set(id, m);
    await db.put("meta", id, m);
    submit(id);
    return { id };
  },
  patch: async (id: string, body: { name?: string; player_id?: string | null }) => {
    await loadAll();
    requireMeta(id);
    const f: Partial<Meta> = {};
    if (body.name !== undefined && body.name.trim()) f.name = body.name.trim().slice(0, 80);
    if ("player_id" in body) {
      if (body.player_id) await requirePlayer(body.player_id).catch(() => { throw new Error("Unknown player."); });
      f.player_id = body.player_id ?? null;
    }
    return pub((Object.keys(f).length ? await writeMeta(id, f) : undefined) ?? requireMeta(id));
  },
  insights: async (id: string): Promise<Insights> => {
    await loadAll();
    const m = requireMeta(id);
    const r = m.status === "done" ? await loadResult(id) : undefined;
    if (!r) throw new Error("This analysis isn't finished yet.");
    const player = m.player_id ? await db.get<StoredPlayer>("player", m.player_id) : null;
    return buildInsights(r, player ?? null) as unknown as Insights;
  },
  players: async (): Promise<Player[]> => {
    await loadAll();
    const ps = (await db.all<StoredPlayer>("player")).sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
    return ps.map(playerOut);
  },
  createPlayer: async (body: Partial<Player>): Promise<Player> => {
    await loadAll();
    const f = cleanPlayer(body);
    if (!f.name) throw new Error("A player needs a name.");
    const p = { id: db.newId(), created: now(), age_group: "adult", style: "fast", arm: "auto", height_cm: null, ...f } as StoredPlayer;
    await db.put("player", p.id, p);
    return playerOut(p);
  },
  updatePlayer: async (pid: string, body: Partial<Player>): Promise<Player> => {
    await loadAll();
    const p = { ...(await requirePlayer(pid)), ...cleanPlayer(body) };
    await db.put("player", pid, p);
    return playerOut(p);
  },
  removePlayer: async (pid: string) => {
    await loadAll();
    await requirePlayer(pid);
    for (const m of metas.values()) if (m.player_id === pid) await writeMeta(m.id, { player_id: null });
    await db.del("player", pid);
    return { deleted: pid };
  },
  progress: async (pid: string): Promise<PlayerProgress> => {
    await loadAll();
    const p = await requirePlayer(pid);
    const mine = [...metas.values()].filter((m) => m.player_id === pid);
    return { player: playerOut(p), ...playerProgress(p, mine.map((m) => ({ meta: m, summary: m.summary }))) } as unknown as PlayerProgress;
  },
  upload: async (file: File, opts: { bowling_arm: string; height_cm?: number; slowmo_factor: number; player_id?: string | null }, onProgress?: (f: number) => void) => {
    await loadAll();
    const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
    if (!ALLOWED.includes(ext) && !file.type.startsWith("video/")) throw new Error(`Unsupported file type '${ext || "?"}'. Choose an MP4, MOV, WEBM or MKV video.`);
    if (opts.height_cm !== undefined && opts.height_cm !== null && !(opts.height_cm >= 120 && opts.height_cm <= 230)) throw new Error("Height must be between 120 and 230 cm.");
    if (!(opts.slowmo_factor >= 1 && opts.slowmo_factor <= 20)) throw new Error("Clip speed must be between 1x and 20x slow motion.");
    if (file.size === 0) throw new Error("The chosen file is empty.");
    if (!(await looksLikeVideo(file))) {
      throw new Error("This file doesn't look like a video. Choose the clip itself (MP4, MOV, WEBM, MKV or AVI) — not a photo, document or shortcut to it.");
    }
    if (file.size > 600e6) throw new Error("This file is larger than 600 MB. Trim the clip around the delivery first.");
    // the clip, its display frames and the 3D data are kept in this browser
    const free = await db.freeSpace();
    if (free !== null && free < file.size + 150e6) {
      throw new Error("Your browser is short of storage space for this clip. Delete some old analyses, or trim the clip around the delivery.");
    }
    let playerId: string | null = null;
    if (opts.player_id) { await requirePlayer(opts.player_id).catch(() => { throw new Error("Unknown player."); }); playerId = opts.player_id; }
    const id = db.newId();
    await db.put("blob", `${id}/input`, file);
    onProgress?.(1);
    const m = newMeta(id, file.name.replace(/\.[^.]+$/, "") || "Delivery", file.size,
      { bowling_arm: (["auto", "left", "right"].includes(opts.bowling_arm) ? opts.bowling_arm : "auto") as Options["bowling_arm"],
        height_m: opts.height_cm ? Math.round(opts.height_cm) / 100 : null, slowmo_factor: opts.slowmo_factor }, playerId, file.type);
    metas.set(id, m);
    await db.put("meta", id, m);
    submit(id);
    return { id };
  },
  frameUrl: (id: string, frame: number) => urls.get(`${id}/f/${frame}`) ?? BLANK,
  meshUrl: (id: string, name: "mesh_rest.bin" | "pose.bin") => urls.get(`${id}/${name}`) ?? BLANK,
  exportUrl: (id: string, kind: "json" | "csv") => urls.get(`${id}/export.${kind}`) ?? BLANK,
  objUrl: (id: string, frame: number) => objFor(id, frame),
  videoUrl: (id: string) => urls.get(`${id}/input`) ?? BLANK,
  /** Whether the original video is kept (a backup restored without videos has none: it can't be re-analysed). */
  hasVideo: (id: string) => urls.has(`${id}/input`),
  backup,
  restore,
};

// keep the tab from silently stopping an analysis
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (running || queue.length) { e.preventDefault(); e.returnValue = ""; }
  });
}
