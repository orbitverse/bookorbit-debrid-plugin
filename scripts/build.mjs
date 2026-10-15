import { build } from "esbuild";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  minify: true,
  legalComments: "eof",
  metafile: false,
});
const bytes = (await readFile("dist/index.mjs")).byteLength;
assert(
  bytes <= 512 * 1024,
  `Plugin is ${bytes} bytes; BookOrbit allows at most 524288`,
);

// Same isolated import, deadline, output cap and stripped environment as BookOrbit's inspector.
const inspect = `
const { pathToFileURL } = await import('node:url');
const { default: plugin } = await import(pathToFileURL(process.argv[1]).href);
process.stdout.write(JSON.stringify({apiVersion:plugin.apiVersion,type:plugin.type,version:plugin.version,update:plugin.update,hasSearch:typeof plugin.search==='function',hasTest:typeof plugin.test==='function',hasResolveFile:typeof plugin.resolveFile==='function'}));
`;
const { stdout } = await promisify(execFile)(
  process.execPath,
  ["--input-type=module", "-e", inspect, resolve("dist/index.mjs")],
  {
    timeout: 5000,
    maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH ?? "" },
  },
);
const plugin = JSON.parse(stdout);
assert.equal(plugin.apiVersion, 1);
assert.match(plugin.type, /^[a-z0-9][a-z0-9-]{0,29}$/);
assert(
  plugin.hasSearch && plugin.hasTest && plugin.hasResolveFile,
  "Bundle must expose BookOrbit's search, test and resolveFile methods",
);
const packageInfo = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(plugin.version, packageInfo.version);
assert.match(plugin.update.ed25519PublicKey, /^[A-Za-z0-9_-]{43}$/);
assert.equal(new URL(plugin.update.manifestUrl).protocol, "https:");
await writeFile("dist/plugin.json", JSON.stringify(plugin, null, 2) + "\n");
console.log(
  `BookOrbit upload checks passed: ${bytes}/524288 bytes, isolated import succeeded (${plugin.version}).`,
);
