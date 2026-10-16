import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function signRelease(source, descriptor, privateKey, config) {
  assert(
    source.length > 0 && source.length <= 512 * 1024,
    "Invalid plugin size",
  );
  assert.match(descriptor.version, /^\d+\.\d+\.\d+$/);
  assert.equal(descriptor.type, config.type);
  const key = createPrivateKey(privateKey);
  const publicKey = createPublicKey(key);
  assert.equal(
    publicKey.export({ format: "jwk" }).x,
    config.publicKey,
    "Signing key does not match the pinned public key",
  );
  assert.equal(descriptor.update.ed25519PublicKey, config.publicKey);
  const signature = sign(null, source, key).toString("base64");
  assert(verify(null, source, publicKey, Buffer.from(signature, "base64")));
  return {
    schemaVersion: 1,
    type: descriptor.type,
    version: descriptor.version,
    sourceUrl: `https://github.com/${config.repository}/releases/download/v${descriptor.version}/index.mjs`,
    sha256: createHash("sha256").update(source).digest("hex"),
    signature,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const source = await readFile("dist/index.mjs");
  const descriptor = JSON.parse(await readFile("dist/plugin.json", "utf8"));
  const config = JSON.parse(await readFile("release.json", "utf8"));
  // Signing reads bytes and metadata only; it never imports the plugin or runs its code.
  const manifest = signRelease(
    source,
    descriptor,
    process.env.PLUGIN_SIGNING_KEY,
    config,
  );
  await writeFile(
    `dist/${config.type}.json`,
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await writeFile("dist/SHA256SUMS", `${manifest.sha256}  index.mjs\n`);
  console.log(`Signed ${config.type} ${manifest.version}.`);
}
