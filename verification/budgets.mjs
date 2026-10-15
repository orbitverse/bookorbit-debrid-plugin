import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import * as Schema from "effect/Schema";
import plugin from "../dist/index.mjs";

globalThis.fetch = () => {
  throw Error("Native networking forbidden");
};
const hash = "a".repeat(40);
const cfg = {
  id: 1,
  name: "Budget fixture",
  baseUrl: "http://indexer.invalid",
  allowPrivateAddress: false,
  categories: { ebook: [7020], audiobook: [3030] },
  settings: { indexerPaths: "/1/api" },
  credential: JSON.stringify({
    indexerKey: "SYNTHETIC_INDEXER",
    debrid: { provider: "torbox", key: "SYNTHETIC_PROVIDER" },
  }),
};
const q = {
  title: "Pride and Prejudice",
  author: null,
  isbn13: null,
  isbn13s: [],
  mediaKind: "ebook",
  language: null,
  limit: 20,
};
const feed = () =>
  new Response(
    `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Fixture</title><item><title>Pride and Prejudice</title><torznab:attr name="infohash" value="${hash}"/></item></channel></rss>`,
  );
const corpus = [
  { id: "request-expiry", budgetMs: 12000, kind: "timeout", releases: 0 },
  { id: "partial-feed-expiry", budgetMs: 12000, kind: "success", releases: 1 },
  { id: "operation-expiry", budgetMs: 18000, kind: "timeout", releases: 0 },
  { id: "external-cancellation", budgetMs: 10, kind: "cancelled", releases: 0 },
];
const rows = [];
const suiteStart = performance.now();
// These are real timers, not shortened production deadlines. Independent suite is opt-in.
for (const sample of corpus) {
  const start = performance.now(),
    calls = [],
    warnings = [];
  const host = {
    async fetch(input, init) {
      const stage =
        new URL(input).hostname === "indexer.invalid" ? "indexer" : "cache";
      const call = {
        stage,
        startMs: performance.now() - start,
        completedMs: null,
      };
      calls.push(call);
      if (init?.redirect !== "manual")
        throw Error("Fixture request policy failed");
      if (stage === "indexer") {
        if (sample.id === "operation-expiry")
          await new Promise((r) => setTimeout(r, 11000));
        else if (
          sample.id !== "partial-feed-expiry" ||
          new URL(input).pathname === "/2/api"
        )
          return await new Promise(() => {});
        call.completedMs = performance.now() - start;
        return feed();
      }
      if (sample.id === "operation-expiry") return await new Promise(() => {});
      call.completedMs = performance.now() - start;
      return Response.json({
        success: true,
        error: null,
        data: {
          [hash]: {
            hash,
            name: q.title,
            files: [{ name: `${q.title}.epub`, size: 1000 }],
          },
        },
      });
    },
    logger: {
      log() {},
      warn(message) {
        warnings.push(message);
      },
    },
    buildSearchText: (query) => query.title,
    async saveCredential() {
      throw Error("Unexpected mutation");
    },
    fail: (kind, message) => Object.assign(new Error(message), { kind }),
  };
  const controller = new AbortController();
  let actualKind = "success",
    count = 0;
  let watchdog;
  let watchdogExpired = false;
  try {
    const pending = plugin.search(
      q,
      {
        ...cfg,
        settings: {
          indexerPaths:
            sample.id === "partial-feed-expiry" ? "/1/api,/2/api" : "/1/api",
        },
      },
      host,
      controller.signal,
    );
    if (sample.id === "external-cancellation")
      setTimeout(() => controller.abort(), 10);
    count = (
      await Promise.race([
        pending,
        new Promise((_, reject) => {
          watchdog = setTimeout(() => {
            watchdogExpired = true;
            controller.abort();
            reject(Error("Offline verification watchdog expired"));
          }, sample.budgetMs + 1500);
        }),
      ])
    ).length;
  } catch (error) {
    actualKind = watchdogExpired
      ? "watchdog"
      : controller.signal.aborted && /cancelled/.test(error.message)
        ? "cancelled"
        : error.kind === "timeout" && /timed out/.test(error.message)
          ? "timeout"
          : "unexpected-error";
  } finally {
    clearTimeout(watchdog);
    controller.abort();
  }
  const elapsedMs = performance.now() - start;
  const lowerBound =
    sample.id === "external-cancellation" ? 0 : sample.budgetMs - 100;
  const passed =
    actualKind === sample.kind &&
    count === sample.releases &&
    elapsedMs >= lowerBound &&
    elapsedMs <= sample.budgetMs + 1500 &&
    (sample.id !== "partial-feed-expiry" ||
      warnings.some((message) => /timed out/.test(message)));
  rows.push({
    id: sample.id,
    expectedKind: sample.kind,
    actualKind,
    budgetMs: sample.budgetMs,
    elapsedMs,
    overshootMs: Math.max(0, elapsedMs - sample.budgetMs),
    releases: count,
    warnings: warnings.length,
    stages: calls,
    passed,
  });
}
const runId = `budgets-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const root = resolve(process.env.BOOKORBIT_VERIFICATION_DIR ?? ".verification");
const output = resolve(root, "runs", runId);
const report = {
  schemaVersion: 1,
  runId,
  timestamp: new Date().toISOString(),
  mode: "offline-wall-clock",
  command: "pnpm verify:budgets",
  codeSha: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  dirty: Boolean(
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  ),
  bundleSha256: createHash("sha256")
    .update(await readFile(new URL("../dist/index.mjs", import.meta.url)))
    .digest("hex"),
  sampleCount: rows.length,
  elapsedMs: performance.now() - suiteStart,
  suiteBudgetMs: 60000,
  toleranceMs: 1500,
  passed: rows.filter((r) => r.passed).length,
  failed: rows.filter((r) => !r.passed).length,
  liveRequests: 0,
  rows,
  limitations:
    "Stalled fixtures prove Effect deadlines and return behavior, not abort of a real underlying socket or production-network latency",
};
const Row = Schema.Struct({
  id: Schema.String,
  expectedKind: Schema.String,
  actualKind: Schema.String,
  budgetMs: Schema.Number,
  elapsedMs: Schema.Number,
  overshootMs: Schema.Number,
  releases: Schema.Int,
  warnings: Schema.Int,
  stages: Schema.Array(
    Schema.Struct({
      stage: Schema.String,
      startMs: Schema.Number,
      completedMs: Schema.NullOr(Schema.Number),
    }),
  ),
  passed: Schema.Boolean,
});
const Report = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runId: Schema.String,
  timestamp: Schema.String,
  mode: Schema.Literal("offline-wall-clock"),
  command: Schema.String,
  codeSha: Schema.String,
  dirty: Schema.Boolean,
  bundleSha256: Schema.String,
  sampleCount: Schema.Int,
  elapsedMs: Schema.Number,
  suiteBudgetMs: Schema.Number,
  toleranceMs: Schema.Number,
  passed: Schema.Int,
  failed: Schema.Int,
  liveRequests: Schema.Int,
  rows: Schema.Array(Row),
  limitations: Schema.String,
});
Schema.decodeUnknownSync(Report)(report);
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, "budgets.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await writeFile(
  resolve(root, "latest-budget-metrics.json.tmp"),
  JSON.stringify(report, null, 2) + "\n",
);
await rename(
  resolve(root, "latest-budget-metrics.json.tmp"),
  resolve(root, "latest-budget-metrics.json"),
);
console.log(
  JSON.stringify({
    runId,
    passed: report.passed,
    failed: report.failed,
    elapsedMs: report.elapsedMs,
    report: resolve(output, "budgets.json"),
  }),
);
if (report.failed || report.elapsedMs > report.suiteBudgetMs)
  process.exitCode = 1;
