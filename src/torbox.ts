import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { File, Hash, Size, fail, type Selection } from "./model.js";
import { decode, json, request, Network } from "./http.js";

const base = "https://api.torbox.app/v1/api/torrents/";
const CacheItem = Schema.Struct({
  hash: Hash,
  name: Schema.NonEmptyString,
  files: Schema.Array(File),
});
const Envelope = Schema.Struct({
  success: Schema.Boolean,
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  data: Schema.Unknown,
});
const ReadyFile = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  name: Schema.NonEmptyString,
  size: Size,
  infected: Schema.optionalKey(Schema.Boolean),
});
const ReadyTorrent = Schema.Struct({
  id: Schema.Int,
  hash: Hash,
  download_finished: Schema.Boolean,
  download_present: Schema.Boolean,
  files: Schema.Array(ReadyFile),
});

const call = Effect.fnUntraced(function* (
  path: string,
  key: string,
  init: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
  retry = true,
) {
  const response = yield* request(
    base + path,
    "TorBox",
    {
      ...init,
      headers: { Authorization: `Bearer ${key}`, ...init.headers },
    },
    retry,
  );
  const envelope = yield* decode(Envelope, yield* json(response), "TorBox");
  if (!envelope.success) {
    const code = envelope.error ?? "";
    return yield* Effect.fail(
      fail(
        /AUTH|TOKEN|API_KEY/i.test(code)
          ? "TorBox rejected the API key."
          : /CACHED|CACHE_MISS/i.test(code)
            ? "This release is no longer cached. Search again; no download was queued."
            : "TorBox could not complete this request. Check your account allowance and retry.",
        /AUTH|TOKEN|API_KEY/i.test(code)
          ? "unauthorized"
          : /LIMIT|RATE/i.test(code)
            ? "throttled"
            : "error",
      ),
    );
  }
  return envelope.data;
});

export const cached = Effect.fnUntraced(function* (
  hashes: readonly string[],
  key: string,
) {
  const body = yield* call("checkcached?format=object&list_files=true", key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hashes }),
  });
  const records = yield* decode(
    Schema.Record(Schema.String, Schema.Unknown),
    body,
    "TorBox cache",
  );
  const host = yield* Network;
  const available: (typeof CacheItem.Type)[] = [];
  // Unrequested or malformed records must not suppress healthy cache hits.
  for (const hash of hashes) {
    if (!(hash in records)) continue;
    const result = yield* decode(CacheItem, records[hash], "TorBox cache").pipe(
      Effect.result,
    );
    if (Result.isSuccess(result) && result.success.hash === hash)
      available.push(result.success);
    else host.logger.warn("TorBox skipped an invalid cache record.");
  }
  return available;
});

export const resolve = Effect.fnUntraced(function* (
  selection: Selection & { files: readonly File[] },
  key: string,
) {
  const same = (files: readonly File[]) =>
    selection.files.every((f) =>
      files.some((c) => c.name === f.name && c.size === f.size),
    );
  const boundary = `bookorbit-${crypto.randomUUID()}`;
  const fields = {
    magnet: `magnet:?xt=urn:btih:${selection.hash}`,
    add_only_if_cached: "true",
    seed: "3",
    allow_zip: "true",
  };
  const body =
    Object.entries(fields)
      .map(
        ([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      )
      .join("") + `--${boundary}--\r\n`;
  // Never retry an account mutation after an ambiguous network failure.
  const created = yield* decode(
    Schema.Struct({
      hash: Hash,
      torrent_id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
    yield* call(
      "createtorrent",
      key,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      },
      false,
    ),
    "TorBox add",
  );
  if (created.hash !== selection.hash)
    return yield* Effect.fail(
      fail("TorBox returned a different torrent. Search again."),
    );
  const result = yield* decode(
    Schema.Union([ReadyTorrent, Schema.Array(ReadyTorrent)]),
    yield* call(`mylist?id=${created.torrent_id}&bypass_cache=true`, key),
    "TorBox files",
  );
  const torrents = "files" in result ? [result] : result;
  const torrent = torrents.find((t) => t.id === created.torrent_id);
  if (
    !torrent ||
    torrent.hash !== selection.hash ||
    !torrent.download_finished ||
    !torrent.download_present ||
    !same(torrent.files) ||
    torrent.files.some((f) => f.infected)
  )
    return yield* Effect.fail(
      fail(
        "TorBox has not made the complete cached release available. Search again or retry shortly.",
      ),
    );
  const params = new URLSearchParams({
    token: key,
    torrent_id: String(torrent.id),
  });
  if (selection.format === "zip") {
    const allowedExtras = /\.(jpg|jpeg|png|nfo|txt|cue|m3u|m3u8)$/i;
    if (
      torrent.files.some(
        (f) =>
          !selection.files.some(
            (s) => s.name === f.name && s.size === f.size,
          ) && !allowedExtras.test(f.name),
      )
    )
      return yield* Effect.fail(
        fail(
          "This torrent contains additional books or media and cannot be delivered as one audiobook.",
        ),
      );
    params.set("zip_link", "true");
  } else {
    const file = torrent.files.find(
      (f) =>
        f.name === selection.files[0].name &&
        f.size === selection.files[0].size,
    )!;
    params.set("file_id", String(file.id));
  }
  const destination = yield* decode(
    Schema.NonEmptyString,
    yield* call(`requestdl?${params}`, key, {}, false),
    "TorBox download",
  );
  if (
    destination.includes(key) ||
    destination.includes(encodeURIComponent(key))
  )
    return yield* Effect.fail(
      fail(
        "TorBox did not return a safe direct download link: it contains your API key. The download was blocked to keep credentials private.",
      ),
    );
  return yield* Effect.try({
    try: () => {
      const url = new URL(destination);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.origin === new URL(base).origin
      )
        throw Error();
      return url.href;
    },
    catch: () => fail("TorBox did not return a safe direct download link."),
  });
});
