import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import * as Schema from "effect/Schema";
import plugin from "../dist/index.mjs";

// No live mode: this adapter cannot contact an account or read credentials.
globalThis.fetch = () => {
  throw Error("Native networking is forbidden in fixture verification");
};
const Corpus = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    media: Schema.Literals(["ebook", "audiobook"]),
    files: Schema.Array(Schema.String),
    expected: Schema.Array(Schema.String),
    work: Schema.optionalKey(Schema.String),
    metricGroup: Schema.optionalKey(
      Schema.Literals([
        "bookIdentity",
        "metadataPassthrough",
        "mediaCompleteness",
        "unknownMetadata",
      ]),
    ),
    hash: Schema.optionalKey(Schema.String),
    query: Schema.optionalKey(
      Schema.Struct({
        title: Schema.String,
        author: Schema.NullOr(Schema.String),
        language: Schema.NullOr(Schema.String),
      }),
    ),
    feed: Schema.optionalKey(
      Schema.Struct({
        title: Schema.String,
        author: Schema.NullOr(Schema.String),
        language: Schema.NullOr(Schema.String),
      }),
    ),
    expectedFiles: Schema.optionalKey(
      Schema.Array(Schema.Array(Schema.String)),
    ),
    behavior: Schema.optionalKey(Schema.String),
    resolve: Schema.optionalKey(Schema.Literal("blocked")),
    search: Schema.optionalKey(Schema.Literal("blocked")),
  }),
);
const corpusBytes = await readFile(new URL("./corpus.json", import.meta.url));
const corpus = Schema.decodeUnknownSync(Corpus)(JSON.parse(corpusBytes));
const Identity = Schema.Struct({
  hash: Schema.String,
  fingerprint: Schema.String,
});
const key = "SYNTHETIC/provider+key";
const indexerKey = "SYNTHETIC/indexer+key";
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1] : null,
    p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
  };
};
const rows = [];
const stages = {};
let cacheRequested = 0,
  cacheHits = 0;
for (let repetition = 0; repetition < 3; repetition++)
  for (const sample of corpus) {
    const caseStart = performance.now();
    try {
      if (
        process.env.BOOKORBIT_VERIFY_INJECT_FAILURE === "assertion" &&
        repetition === 0 &&
        sample === corpus[0]
      )
        assert.fail("Injected synthetic assertion failure");
      const calls = [],
        logs = [],
        errors = [];
      const files = sample.files.map((name, id) => ({
        name,
        size: (id + 1) * 1000,
        id,
      }));
      const hash = sample.hash ?? "a".repeat(40);
      const title = sample.query?.title ?? "Pride and Prejudice";
      const feed = sample.feed ?? { title, author: null, language: null };
      let lookups = 0;
      let fixtureFailures = 0;
      const host = {
        async fetch(input, init) {
          try {
            const url = new URL(input);
            assert.equal(init.redirect, "manual");
            const stage =
              url.hostname === "indexer.invalid"
                ? "indexer"
                : url.pathname.split("/").at(-1);
            calls.push(stage);
            const start = performance.now();
            try {
              if (stage === "indexer") {
                assert.equal(url.searchParams.get("apikey"), indexerKey);
                assert.equal(
                  url.searchParams.get("q"),
                  [title, sample.query?.author].filter(Boolean).join(" "),
                );
                assert.equal(
                  url.searchParams.get("cat"),
                  sample.media === "audiobook" ? "3030" : "7020",
                );
                assert(!JSON.stringify(init).includes(key));
                if (sample.behavior === "cancel")
                  return await new Promise(() => {});
                if (url.pathname === "/2/api")
                  return new Response("unavailable", { status: 503 });
                return new Response(
                  `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Fixture indexer</title><item><title>${feed.title}</title><torznab:attr name="infohash" value="${hash}"/>${feed.author === null ? "" : `<torznab:attr name="author" value="${feed.author}"/>`}${feed.language === null ? "" : `<torznab:attr name="language" value="${feed.language}"/>`}</item></channel></rss>`,
                );
              }
              assert.equal(url.origin, "https://api.torbox.app");
              assert.equal(init.headers.Authorization, `Bearer ${key}`);
              let data;
              if (stage === "checkcached") {
                assert.deepEqual(JSON.parse(init.body), { hashes: [hash] });
                lookups++;
                data =
                  sample.behavior === "miss" ||
                  (sample.behavior === "evicted" && lookups > 1)
                    ? {}
                    : { [hash]: { hash, name: title, files } };
                if (lookups === 1) {
                  cacheRequested++;
                  if (hash in data) cacheHits++;
                }
              } else if (stage === "createtorrent") {
                assert.match(
                  init.body,
                  /name="add_only_if_cached"\r\n\r\ntrue/,
                );
                assert.match(init.body, /name="seed"\r\n\r\n3/);
                data = { hash, torrent_id: 7 };
              } else if (stage === "mylist")
                data = [
                  {
                    id: 7,
                    hash,
                    download_finished: true,
                    download_present: true,
                    files,
                  },
                ];
              else if (stage === "requestdl") {
                assert.equal(url.searchParams.get("token"), key);
                if (sample.expected.includes("zip")) {
                  assert.equal(url.searchParams.get("zip_link"), "true");
                  assert.equal(url.searchParams.has("file_id"), false);
                }
                data =
                  sample.behavior === "unsafe"
                    ? `https://cdn.invalid/file?token=${key}`
                    : sample.behavior === "encoded"
                      ? `https://cdn.invalid/file?token=${encodeURIComponent(key)}`
                      : sample.behavior === "native"
                        ? `https://cdn1.tb-cdn.io/book.epub?token=${encodeURIComponent(key)}`
                        : "https://cdn.invalid/file?ticket=download-only";
              } else throw Error("Unapproved endpoint");
              return Response.json({ success: true, error: null, data });
            } finally {
              (stages[stage] ??= []).push(performance.now() - start);
            }
          } catch {
            fixtureFailures++;
            throw Error("Fixture contract failure");
          }
        },
        logger: { log: (s) => logs.push(s), warn: (s) => logs.push(s) },
        buildSearchText: (q) => [q.title, q.author].filter(Boolean).join(" "),
        saveCredential: async () => {
          fixtureFailures++;
          throw Error("Unexpected credential write");
        },
        fail: (kind, message) => Object.assign(new Error(message), { kind }),
      };
      const cfg = {
        id: 1,
        name: "Fixture",
        baseUrl: "http://indexer.invalid",
        allowPrivateAddress: false,
        categories: { ebook: [7020], audiobook: [3030] },
        settings: {
          indexerPaths:
            sample.behavior === "partial" ? "/1/api,/2/api" : "/1/api",
        },
        credential: JSON.stringify({
          indexerKey,
          debrid: { provider: "torbox", key },
        }),
      };
      const q = {
        title,
        author: sample.query?.author ?? null,
        isbn13: null,
        isbn13s: [],
        mediaKind: sample.media,
        language: sample.query?.language ?? null,
        limit: 20,
      };
      const controller = new AbortController();
      const start = performance.now();
      let releases = [],
        searchBlocked = false;
      try {
        const pending = plugin.search(q, cfg, host, controller.signal);
        if (sample.behavior === "cancel")
          setTimeout(() => controller.abort(), 10);
        releases = await pending;
      } catch (e) {
        errors.push(e.message);
        searchBlocked = true;
      }
      const searchMs = performance.now() - start;
      assert.equal(
        searchBlocked,
        sample.search === "blocked",
        `${sample.id}: search outcome`,
      );
      assert(!calls.includes("createtorrent"), "Search must be read-only");
      if (sample.metricGroup === "metadataPassthrough")
        for (const release of releases) {
          assert.equal(release.author, feed.author);
          assert.equal(release.language, feed.language);
          assert.equal(release.bookTitle, undefined);
        }
      const actual = releases.map((r) => r.format).sort();
      const expected = [...sample.expected].sort();
      const actualIdentities = releases
        .map((release) => {
          const value = Schema.decodeUnknownSync(Identity)(
            JSON.parse(release.guid),
          );
          return `${value.hash}:${value.fingerprint}`;
        })
        .sort();
      const expectedIdentities = (sample.expectedFiles ?? [])
        .map((group) => {
          const canonical = group
            .map((name) => {
              const file = files.find((f) => f.name === name);
              assert(file, "Ground-truth filename absent from corpus");
              return [name, file.size];
            })
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
          return `${hash}:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
        })
        .sort();
      if (
        process.env.BOOKORBIT_VERIFY_INJECT_FAILURE === "identity" &&
        repetition === 0 &&
        sample.id === "match-pride-exact"
      )
        actualIdentities[0] = `${hash}:${"0".repeat(64)}`;
      if (
        process.env.BOOKORBIT_VERIFY_INJECT_FAILURE === "duplicate" &&
        repetition === 0 &&
        sample === corpus[0]
      )
        actual.push(actual[0]);
      let delivered = 0,
        blocked = 0;
      const resolveStart = performance.now();
      for (const release of releases) {
        let result;
        try {
          result = await plugin.resolveFile(
            release,
            cfg,
            host,
            controller.signal,
          );
        } catch (e) {
          errors.push(e.message);
          blocked++;
        }
        if (result) {
          assert.equal(new URL(result.url).protocol, "https:");
          assert.equal(result.format, release.format);
          if (sample.behavior === "native") {
            const privateUrl = new URL(result.url);
            assert.equal(privateUrl.hostname, "cdn1.tb-cdn.io");
            assert.deepEqual(privateUrl.searchParams.getAll("token"), [key]);
            const { url, ...publicFields } = result;
            assert(!JSON.stringify(publicFields).includes(key));
            assert(
              !JSON.stringify(publicFields).includes(encodeURIComponent(key)),
            );
          } else {
            assert(!JSON.stringify(result).includes(key));
            assert(!JSON.stringify(result).includes(encodeURIComponent(key)));
          }
          delivered++;
        }
        assert.equal(
          Boolean(result),
          sample.resolve !== "blocked",
          `${sample.id}: handoff outcome`,
        );
      }
      if (["miss", "evicted"].includes(sample.behavior))
        assert(!calls.includes("createtorrent"), "Cache misses cannot queue");
      assert.equal(fixtureFailures, 0, "Fixture transport contract failed");
      const publicOutput = JSON.stringify({ releases, logs, errors });
      for (const secret of [
        key,
        indexerKey,
        encodeURIComponent(key),
        encodeURIComponent(indexerKey),
      ])
        assert(
          !publicOutput.includes(secret),
          "Credential leaked from adapter",
        );
      const remaining = [...expected];
      let tp = 0;
      for (const format of actual) {
        const index = remaining.indexOf(format);
        if (index >= 0) {
          tp++;
          remaining.splice(index, 1);
        }
      }
      const identitiesRemaining = [...expectedIdentities];
      let identityTp = 0;
      for (const identity of actualIdentities) {
        const index = identitiesRemaining.indexOf(identity);
        if (index >= 0) {
          identityTp++;
          identitiesRemaining.splice(index, 1);
        }
      }
      const identityPassed =
        !sample.metricGroup ||
        JSON.stringify(actualIdentities) === JSON.stringify(expectedIdentities);
      rows.push({
        id: sample.id,
        repetition,
        media: sample.media,
        expected,
        actual,
        tp,
        fp: actual.length - tp,
        fn: remaining.length,
        selectionEvaluated: true,
        identityEvaluated: Boolean(sample.metricGroup),
        metricGroup: sample.metricGroup ?? "safety",
        work: sample.work ?? null,
        expectedIdentities,
        actualIdentities,
        identityTp,
        identityFp: actualIdentities.length - identityTp,
        identityFn: identitiesRemaining.length,
        searchMs,
        resolveMs: releases.length ? performance.now() - resolveStart : null,
        totalMs: performance.now() - start,
        delivered,
        blocked,
        warnings: logs.length,
        cancelled: searchBlocked,
        passed:
          JSON.stringify(actual) === JSON.stringify(expected) && identityPassed,
      });
    } catch {
      rows.push({
        id: sample.id,
        repetition,
        media: sample.media,
        expected: sample.expected,
        actual: [],
        tp: 0,
        fp: 0,
        fn: 0,
        selectionEvaluated: false,
        identityEvaluated: false,
        metricGroup: sample.metricGroup ?? "safety",
        work: sample.work ?? null,
        expectedIdentities: [],
        actualIdentities: [],
        identityTp: 0,
        identityFp: 0,
        identityFn: 0,
        searchMs: null,
        resolveMs: null,
        totalMs: performance.now() - caseStart,
        delivered: 0,
        blocked: 0,
        warnings: 0,
        cancelled: false,
        passed: false,
        failure: "fixture-contract-assertion",
      });
    }
  }
const codeSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const dirty = Boolean(
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
);
const runId = `fixture-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const artifactRoot = resolve(
  process.env.BOOKORBIT_VERIFICATION_DIR ?? ".verification",
);
const output = resolve(artifactRoot, "runs", runId);
const safetyRows = rows.filter((row) => row.metricGroup === "safety");
const totals = safetyRows.reduce(
  (a, r) => ({ tp: a.tp + r.tp, fp: a.fp + r.fp, fn: a.fn + r.fn }),
  { tp: 0, fp: 0, fn: 0 },
);
const classifyRows = (selected) => {
  const counts = selected.reduce(
    (a, row) => ({
      tp: a.tp + row.identityTp,
      fp: a.fp + row.identityFp,
      fn: a.fn + row.identityFn,
      tnQueries:
        a.tnQueries +
        (row.selectionEvaluated &&
        row.actualIdentities.length === 0 &&
        row.expectedIdentities.length === 0
          ? 1
          : 0),
    }),
    { tp: 0, fp: 0, fn: 0, tnQueries: 0 },
  );
  return {
    sampleCount: selected.length,
    evaluatedSamples: selected.filter((row) => row.selectionEvaluated).length,
    ...counts,
    precision:
      counts.tp + counts.fp ? counts.tp / (counts.tp + counts.fp) : null,
    recall: counts.tp + counts.fn ? counts.tp / (counts.tp + counts.fn) : null,
  };
};
const matchingRows = rows.filter((row) => row.metricGroup === "bookIdentity");
const report = {
  schemaVersion: 2,
  runId,
  timestamp: new Date().toISOString(),
  codeSha,
  dirty,
  command: "pnpm verify",
  mode: "fixture",
  corpusSha256: createHash("sha256").update(corpusBytes).digest("hex"),
  bundleSha256: createHash("sha256")
    .update(await readFile(new URL("../dist/index.mjs", import.meta.url)))
    .digest("hex"),
  sampleCount: rows.length,
  uniqueSamples: corpus.length,
  repetitions: 3,
  budgets: {
    requestMs: 12000,
    operationMs: 18000,
    liveRequests: 0,
    liveMutations: 0,
  },
  formatSelection: {
    ...totals,
    precision:
      totals.tp + totals.fp ? totals.tp / (totals.tp + totals.fp) : null,
    recall: totals.tp + totals.fn ? totals.tp / (totals.tp + totals.fn) : null,
    groundTruth:
      "Format-label selection for one synthetic title; repeated cases are not independent titles",
    evaluatedSamples: safetyRows.filter((r) => r.selectionEvaluated).length,
  },
  labeledMatching: {
    identity: classifyRows(matchingRows),
    bookIdentity: classifyRows(
      rows.filter((row) => row.metricGroup === "bookIdentity"),
    ),
    metadataPassthrough: {
      sampleCount: rows.filter(
        (row) => row.metricGroup === "metadataPassthrough",
      ).length,
      returnedCandidates: rows
        .filter((row) => row.metricGroup === "metadataPassthrough")
        .reduce((n, row) => n + row.actualIdentities.length, 0),
      passed: rows.filter(
        (row) => row.metricGroup === "metadataPassthrough" && row.passed,
      ).length,
      precision: null,
      recall: null,
    },
    mediaCompleteness: classifyRows(
      rows.filter((row) => row.metricGroup === "mediaCompleteness"),
    ),
    unknownMetadata: {
      sampleCount: rows.filter((row) => row.metricGroup === "unknownMetadata")
        .length,
      returnedCandidates: rows
        .filter((row) => row.metricGroup === "unknownMetadata")
        .reduce((n, row) => n + row.actualIdentities.length, 0),
      passed: rows.filter(
        (row) => row.metricGroup === "unknownMetadata" && row.passed,
      ).length,
      precision: null,
      recall: null,
    },
    uniqueWorks: new Set(
      corpus.filter((row) => row.work).map((row) => row.work),
    ).size,
    labeledCases: corpus.filter((row) => row.metricGroup).length,
    groundTruth:
      "Manual synthetic hash+selected-file fingerprint labels; TP/FP/FN count candidate identities and tnQueries counts empty negative queries; metadata passthrough, media completeness and missing metadata are separate strata; not real catalogue or exact-edition accuracy",
  },
  matchingAccuracy: {
    precision: null,
    recall: null,
    sampleCount: 0,
    reason:
      "Small synthetic labeled matching coverage is reported separately; real catalogue and exact-edition accuracy remain unknown",
  },
  latency: {
    total: summary(rows.map((r) => r.totalMs)),
    search: summary(
      rows.flatMap((r) => (r.searchMs === null ? [] : [r.searchMs])),
    ),
    resolve: summary(
      rows.flatMap((r) => (r.resolveMs === null ? [] : [r.resolveMs])),
    ),
    stages: Object.fromEntries(
      Object.entries(stages).map(([k, v]) => [k, summary(v)]),
    ),
    scope:
      "In-process fixture latency; stage timings cover host.fetch only, not public network or response parsing",
  },
  outcomes: {
    safetySamples: safetyRows.length,
    labeledSamples: rows.length - safetyRows.length,
    passed: rows.filter((r) => r.passed).length,
    failed: rows.filter((r) => !r.passed).length,
    partialFailureRecovered: rows.filter(
      (r) => r.id === "partial-indexer" && r.passed && r.warnings > 0,
    ).length,
    cancelled: rows.filter((r) => r.cancelled).length,
    timeouts: null,
    cacheRequested,
    cacheHits,
    cachedCoverage: cacheRequested ? cacheHits / cacheRequested : null,
    cachedCoverageDefinition:
      "Synthetic first-search cache hits divided by requested hashes; not live provider coverage",
  },
  gates: {
    credentialRedaction: rows.every((r) => r.passed),
    cachedOnly: rows.every((r) => r.passed),
    formatPreservation: rows.every((r) => r.passed),
    completeTrackFixture: rows.every((r) => r.passed),
    safeHandoff: rows.every((r) => r.passed),
    wallClockTimeoutVerified: false,
  },
  gateScope:
    "Conservative whole-suite acceptance flags; any failed assertion or label case leaves acceptance unproven",
  handoffPolicy:
    "User-approved native TorBox token URL is private to the trusted caller; resolved URLs never enter these reports, GUIDs, logs or errors. Untrusted key-bearing links remain rejected.",
  live: {
    latency: null,
    precision: null,
    recall: null,
    cachedCoverage: null,
    downloads: 0,
    bookOrbitImports: 0,
    blocker:
      "Native private handoff is user-approved; fixtures do not establish actual BookOrbit delivery or import",
  },
  artifacts: {
    report: `${output}/metrics.json`,
    samples: `${output}/samples.json`,
  },
};
const Summary = Schema.Struct({
  count: Schema.Int,
  p50Ms: Schema.NullOr(Schema.Number),
  p95Ms: Schema.NullOr(Schema.Number),
});
const Classification = Schema.Struct({
  sampleCount: Schema.Int,
  evaluatedSamples: Schema.Int,
  tp: Schema.Int,
  fp: Schema.Int,
  fn: Schema.Int,
  tnQueries: Schema.Int,
  precision: Schema.NullOr(Schema.Number),
  recall: Schema.NullOr(Schema.Number),
});
const Report = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  runId: Schema.String,
  timestamp: Schema.String,
  codeSha: Schema.String,
  dirty: Schema.Boolean,
  command: Schema.String,
  mode: Schema.Literal("fixture"),
  corpusSha256: Schema.String,
  bundleSha256: Schema.String,
  sampleCount: Schema.Int,
  uniqueSamples: Schema.Int,
  repetitions: Schema.Int,
  budgets: Schema.Record(Schema.String, Schema.Int),
  formatSelection: Schema.Struct({
    tp: Schema.Int,
    fp: Schema.Int,
    fn: Schema.Int,
    precision: Schema.NullOr(Schema.Number),
    recall: Schema.NullOr(Schema.Number),
    groundTruth: Schema.String,
    evaluatedSamples: Schema.Int,
  }),
  labeledMatching: Schema.Struct({
    identity: Classification,
    bookIdentity: Classification,
    metadataPassthrough: Schema.Struct({
      sampleCount: Schema.Int,
      returnedCandidates: Schema.Int,
      passed: Schema.Int,
      precision: Schema.Null,
      recall: Schema.Null,
    }),
    mediaCompleteness: Classification,
    unknownMetadata: Schema.Struct({
      sampleCount: Schema.Int,
      returnedCandidates: Schema.Int,
      passed: Schema.Int,
      precision: Schema.Null,
      recall: Schema.Null,
    }),
    uniqueWorks: Schema.Int,
    labeledCases: Schema.Int,
    groundTruth: Schema.String,
  }),
  matchingAccuracy: Schema.Struct({
    precision: Schema.Null,
    recall: Schema.Null,
    sampleCount: Schema.Int,
    reason: Schema.String,
  }),
  latency: Schema.Struct({
    total: Summary,
    search: Summary,
    resolve: Summary,
    stages: Schema.Record(Schema.String, Summary),
    scope: Schema.String,
  }),
  outcomes: Schema.Struct({
    safetySamples: Schema.Int,
    labeledSamples: Schema.Int,
    passed: Schema.Int,
    failed: Schema.Int,
    partialFailureRecovered: Schema.Int,
    cancelled: Schema.Int,
    timeouts: Schema.NullOr(Schema.Int),
    cacheRequested: Schema.Int,
    cacheHits: Schema.Int,
    cachedCoverage: Schema.NullOr(Schema.Number),
    cachedCoverageDefinition: Schema.String,
  }),
  gates: Schema.Record(Schema.String, Schema.Boolean),
  gateScope: Schema.String,
  handoffPolicy: Schema.String,
  live: Schema.Struct({
    latency: Schema.Null,
    precision: Schema.Null,
    recall: Schema.Null,
    cachedCoverage: Schema.Null,
    downloads: Schema.Int,
    bookOrbitImports: Schema.Int,
    blocker: Schema.String,
  }),
  artifacts: Schema.Record(Schema.String, Schema.String),
});
Schema.decodeUnknownSync(Report, { onExcessProperty: "error" })(report);
await mkdir(output, { recursive: true });
await writeFile(report.artifacts.samples, JSON.stringify(rows, null, 2) + "\n");
await writeFile(
  report.artifacts.report,
  JSON.stringify(report, null, 2) + "\n",
);
const latest = resolve(artifactRoot, "latest-metrics.json");
await writeFile(`${latest}.tmp`, JSON.stringify(report, null, 2) + "\n");
await rename(`${latest}.tmp`, latest);
console.log(
  JSON.stringify({
    runId,
    samples: rows.length,
    passed: report.outcomes.passed,
    failed: report.outcomes.failed,
    report: report.artifacts.report,
  }),
);
if (report.outcomes.failed) process.exitCode = 1;
