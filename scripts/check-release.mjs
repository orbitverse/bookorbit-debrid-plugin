import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { createHash, createPublicKey, verify } from "node:crypto";

const config = JSON.parse(await readFile("release.json", "utf8"));
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const response = await fetch(
  `https://api.github.com/repos/${config.repository}/releases/tags/v${version}`,
  {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15000),
  },
);
let release = true;
const latestResponse = await fetch(
  `https://api.github.com/repos/${config.repository}/releases/latest`,
  {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15000),
  },
);
if (latestResponse.status !== 404) {
  assert(
    latestResponse.ok,
    `Latest release lookup failed: HTTP ${latestResponse.status}`,
  );
  const latest = await latestResponse.json();
  assert.match(latest.tag_name, /^v\d+\.\d+\.\d+$/);
  const currentParts = version.split(".").map(Number);
  const latestParts = latest.tag_name.slice(1).split(".").map(Number);
  const firstDifference = currentParts.findIndex(
    (part, index) => part !== latestParts[index],
  );
  assert(
    firstDifference === -1 ||
      currentParts[firstDifference] > latestParts[firstDifference],
    "Version must not be older than the latest release",
  );
}
if (response.status !== 404) {
  assert(response.ok, `GitHub release lookup failed: HTTP ${response.status}`);
  const existing = await response.json();
  assert(
    !existing.draft,
    "A release draft already exists; finish or remove it before retrying",
  );
  const asset = existing.assets.find((a) => a.name === `${config.type}.json`);
  assert(asset, "Published release has no signed manifest");
  const manifestResponse = await fetch(asset.browser_download_url, {
    signal: AbortSignal.timeout(15000),
  });
  assert(manifestResponse.ok, "Could not download the published manifest");
  const manifest = await manifestResponse.json();
  assert.equal(manifest.type, config.type);
  assert.equal(manifest.version, version);
  const source = await readFile("dist/index.mjs");
  assert.equal(
    manifest.sha256,
    createHash("sha256").update(source).digest("hex"),
    "Plugin changed since this version was published; bump package.json version",
  );
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: config.publicKey },
    format: "jwk",
  });
  assert(
    verify(null, source, key, Buffer.from(manifest.signature, "base64")),
    "Published signature is invalid",
  );
  release = false;
}
if (process.env.GITHUB_OUTPUT)
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `release=${release}\nversion=${version}\n`,
  );
console.log(
  release
    ? `Version ${version} is ready for release.`
    : `Version ${version} is already published and verified.`,
);
