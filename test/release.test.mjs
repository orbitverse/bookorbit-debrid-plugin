import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("built plugin pins the release key and public update manifest", () => {
  const config = JSON.parse(
    readFileSync(new URL("../release.json", import.meta.url)),
  );
  const descriptor = JSON.parse(
    readFileSync(new URL("../dist/plugin.json", import.meta.url)),
  );
  assert.equal(descriptor.update.ed25519PublicKey, config.publicKey);
  assert.equal(
    descriptor.update.manifestUrl,
    `https://github.com/${config.repository}/releases/latest/download/${config.type}.json`,
  );
});
test("signing job uses the same immutable tooling as local builds", () => {
  const packageInfo = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url)),
  );
  const dependency =
    packageInfo.devDependencies["@orbitverse/bookorbit-plugin-tools"];
  assert.match(
    dependency,
    /^git\+https:\/\/github\.com\/orbitverse\/bookorbit-plugin-tools\.git#[a-f0-9]{40}$/,
  );
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert(workflow.includes(`ref: ${dependency.split("#")[1]}`));
  assert(workflow.includes("repository: orbitverse/bookorbit-plugin-tools"));
  assert(workflow.includes("node .plugin-tools/cli.mjs sign-release"));
});
