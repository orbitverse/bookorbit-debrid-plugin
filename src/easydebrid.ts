import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { File, Hash, Size, fail } from "./model.js";
import { decode, json, request } from "./http.js";

const base = "https://easydebrid.com/api/v1/";
const CachedFile = Schema.Struct({
  name: Schema.NonEmptyString,
  size: Size,
  folder: Schema.String,
});
const Lookup = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({
      cached: Schema.Boolean,
      files: Schema.optionalKey(Schema.Array(CachedFile)),
    }),
  ),
});
const Generated = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      filename: Schema.NonEmptyString,
      directory: Schema.Array(Schema.String),
      size: Size,
      url: Schema.NonEmptyString,
    }),
  ),
});
const filePath = (folder: string, name: string) =>
  [...folder.split("/").filter(Boolean), name].join("/");
const magnet = (hash: string) => `magnet:?xt=urn:btih:${hash}`;

const call = Effect.fnUntraced(function* (
  path: string,
  key: string,
  body?: unknown,
) {
  return yield* json(
    yield* request(
      base + path,
      "EasyDebrid",
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      path !== "link/generate",
    ),
  );
});

export const cached = Effect.fnUntraced(function* (
  hashes: readonly string[],
  key: string,
) {
  const checked = yield* decode(
    Schema.Array(Hash).check(Schema.isMaxLength(100)),
    hashes,
    "EasyDebrid hashes",
  );
  const result = yield* decode(
    Lookup,
    yield* call("link/lookupdetails", key, { urls: checked.map(magnet) }),
    "EasyDebrid cache",
  );
  if (result.result.length !== checked.length)
    return yield* Effect.fail(
      fail("EasyDebrid returned an incomplete cache response. Search again."),
    );
  const available: { hash: string; name: string; files: File[] }[] = [];
  for (let index = 0; index < checked.length; index++) {
    const item = result.result[index];
    if (!item.cached) continue;
    if (!item.files)
      return yield* Effect.fail(
        fail("EasyDebrid did not provide a cached file list. Search again."),
      );
    available.push({
      hash: checked[index],
      name: checked[index],
      files: item.files.map((f) => ({
        name: filePath(f.folder, f.name),
        size: f.size,
      })),
    });
  }
  return available;
});

export const resolve = Effect.fnUntraced(function* (
  selection: { hash: string; files: readonly File[]; format: string },
  key: string,
) {
  if (selection.format === "zip" || selection.files.length !== 1)
    return yield* Effect.fail(
      fail(
        "EasyDebrid supports single-file books only. Choose another release.",
      ),
    );
  const hash = yield* decode(Hash, selection.hash, "EasyDebrid release");
  const result = yield* decode(
    Generated,
    yield* call("link/generate", key, { url: magnet(hash) }),
    "EasyDebrid download",
  );
  const selected = selection.files[0];
  const matches = result.files.filter(
    (f) =>
      filePath(f.directory.join("/"), f.filename) === selected.name &&
      f.size === selected.size,
  );
  if (matches.length !== 1)
    return yield* Effect.fail(
      fail("This EasyDebrid file changed or is unavailable. Search again."),
    );
  return yield* Effect.try({
    try: () => {
      const url = new URL(matches[0].url);
      const hostname = url.hostname.replace(/\.$/, "");
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        hostname === new URL(base).hostname ||
        !hostname.includes(".") ||
        /^[\d.]+$/.test(hostname) ||
        hostname.includes(":") ||
        /\.(?:localhost|local|internal|lan)$/.test(hostname)
      )
        throw Error();
      let value = url.href;
      const secrets = [
        key,
        Buffer.from(key).toString("base64"),
        Buffer.from(key).toString("base64url"),
      ];
      for (let depth = 0; depth < 3; depth++) {
        if (secrets.some((secret) => secret && value.includes(secret)))
          throw Error();
        const decoded = decodeURIComponent(value);
        if (decoded === value) break;
        value = decoded;
      }
      if (
        decodeURIComponent(value) !== value ||
        secrets.some((secret) => secret && value.includes(secret))
      )
        throw Error();
      return url.href;
    },
    catch: () => fail("EasyDebrid did not return a safe direct download link."),
  });
});

export const verify = Effect.fnUntraced(function* (key: string) {
  yield* decode(
    Schema.Struct({
      id: Schema.Union([Schema.NonEmptyString, Schema.Int]),
      paid_until: Schema.Union([Schema.NonEmptyString, Schema.Int]),
    }),
    yield* call("user/details", key),
    "EasyDebrid account",
  );
});
