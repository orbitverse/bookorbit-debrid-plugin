import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import * as Schema from "effect/Schema";

const cases = [];
for (const injected of ["assertion", "duplicate"]) {
  const directory = await mkdtemp(
    resolve(tmpdir(), "bookorbit-verification-integrity-"),
  );
  try {
    const child = spawnSync(process.execPath, ["verification/run.mjs"], {
      encoding: "utf8",
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        BOOKORBIT_VERIFICATION_DIR: directory,
        BOOKORBIT_VERIFY_INJECT_FAILURE: injected,
      },
    });
    const report = JSON.parse(
      await readFile(resolve(directory, "latest-metrics.json"), "utf8"),
    );
    assert.equal(child.status, 1);
    assert.equal(report.outcomes.failed, 1);
    assert.equal(report.outcomes.passed, 38);
    assert.equal(report.gates.safeHandoff, false);
    assert.equal(report.gates.credentialRedaction, false);
    if (injected === "duplicate") assert.equal(report.formatSelection.fp, 1);
    assert(!JSON.stringify(report).includes("SYNTHETIC/"));
    cases.push({
      id: injected,
      exitCode: child.status,
      failedSamples: report.outcomes.failed,
      falsePositives: report.formatSelection.fp,
      passed: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const root = resolve(process.env.BOOKORBIT_VERIFICATION_DIR ?? ".verification");
const runId = `integrity-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const output = resolve(root, "runs", runId);
const report = {
  schemaVersion: 1,
  runId,
  timestamp: new Date().toISOString(),
  codeSha: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  dirty: Boolean(
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  ),
  command: "pnpm verify:integrity",
  mode: "offline-deliberate-regression",
  childBudgetMs: 10000,
  sampleCount: cases.length,
  passed: cases.length,
  failed: 0,
  cases,
  artifact: resolve(output, "integrity.json"),
};
Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    runId: Schema.String,
    timestamp: Schema.String,
    codeSha: Schema.String,
    dirty: Schema.Boolean,
    command: Schema.String,
    mode: Schema.Literal("offline-deliberate-regression"),
    childBudgetMs: Schema.Int,
    sampleCount: Schema.Int,
    passed: Schema.Int,
    failed: Schema.Int,
    cases: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        exitCode: Schema.Int,
        failedSamples: Schema.Int,
        falsePositives: Schema.Int,
        passed: Schema.Boolean,
      }),
    ),
    artifact: Schema.String,
  }),
)(report);
await mkdir(output, { recursive: true });
await writeFile(report.artifact, JSON.stringify(report, null, 2) + "\n");
await writeFile(
  resolve(root, "latest-integrity-metrics.json.tmp"),
  JSON.stringify(report, null, 2) + "\n",
);
await rename(
  resolve(root, "latest-integrity-metrics.json.tmp"),
  resolve(root, "latest-integrity-metrics.json"),
);
console.log(JSON.stringify(report));
