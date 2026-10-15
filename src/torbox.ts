import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import { File, Hash, Size, fail, type Selection } from "./model.js";
import { decode, json, request, Network } from "./http.js";

const base = "https://api.torbox.app/v1/api/torrents/";
// CDN list: https://support.torbox.app/en/articles/13181686-accessing-torbox-with-nextdns
const cdnDomains = ["cx", "io", "pw", "sh", "st", "to", "earth"].map(
  (suffix) => `.tb-cdn.${suffix}`,
);
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

const create = Effect.fnUntraced(function* (
  hash: string,
  key: string,
  cachedOnly: boolean,
) {
  const boundary = `bookorbit-${crypto.randomUUID()}`;
  const fields = {
    magnet: `magnet:?xt=urn:btih:${hash}`,
    add_only_if_cached: String(cachedOnly),
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
  if (created.hash !== hash)
    return yield* Effect.fail(
      fail("TorBox returned a different torrent. Search again."),
    );
  return created;
});

const AccountTorrent = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  hash: Hash,
  name: Schema.String,
  download_state: Schema.String,
  download_finished: Schema.Boolean,
  download_present: Schema.Boolean,
  files: Schema.optionalKey(Schema.NullOr(Schema.Array(ReadyFile))),
});
const account = Effect.fnUntraced(function* (key: string) {
  return yield* decode(
    Schema.Array(AccountTorrent).check(Schema.isMaxLength(1000)),
    yield* call("mylist?bypass_cache=true&limit=1000", key),
    "TorBox account",
  );
});
// TorBox documents qBittorrent states; neither completed nor cached proves file readiness.
// https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/services/TorrentsService.md
const terminal = (torrent: typeof AccountTorrent.Type) =>
  ["error", "missingFiles"].includes(torrent.download_state) ||
  torrent.files?.some((f) => f.infected) === true;
const ready = (torrent: typeof AccountTorrent.Type) =>
  !terminal(torrent) &&
  torrent.download_finished &&
  torrent.download_present &&
  !!torrent.files?.length;

export const available = Effect.fnUntraced(function* (
  hashes: readonly string[],
  key: string,
) {
  const hits = yield* cached(hashes, key);
  const missing = new Set(
    hashes.filter((hash) => !hits.some((hit) => hit.hash === hash)),
  );
  if (!missing.size) return hits;
  const torrents = yield* account(key);
  for (const torrent of torrents) {
    if (!missing.has(torrent.hash) || !ready(torrent)) continue;
    hits.push({
      hash: torrent.hash,
      name: torrent.name || torrent.hash,
      files: torrent.files!,
    });
    missing.delete(torrent.hash);
  }
  return hits;
});

// Only one preparation runs per loaded module; other workers still reconcile through TorBox.
const preparation = Semaphore.makeUnsafe(1);
export const prepare = Effect.fnUntraced(function* (hash: string, key: string) {
  yield* decode(Hash, hash, "TorBox preparation");
  const result = yield* preparation.withPermitsIfAvailable(1)(
    Effect.gen(function* () {
      const torrents = yield* account(key);
      const matches = torrents.filter((torrent) => torrent.hash === hash);
      if (matches.some(ready)) return { status: "ready" as const };
      if (matches.some(terminal))
        return yield* Effect.fail(
          fail(
            "This TorBox torrent failed or has unsafe files. Check it in TorBox; it was not restarted.",
          ),
        );
      if (matches.length) return { status: "preparing" as const };
      if (torrents.length === 1000)
        return yield* Effect.fail(
          fail(
            "Your TorBox account has too many entries to safely check for an existing preparation. Check it in TorBox first.",
          ),
        );
      yield* create(hash, key, false).pipe(
        Effect.catch((error) =>
          error.kind === "unreachable" || error.kind === "timeout"
            ? Effect.fail(
                fail(
                  "The TorBox preparation outcome is uncertain. Check your TorBox account before trying again; a job may already exist.",
                ),
              )
            : Effect.fail(error),
        ),
      );
      return { status: "preparing" as const };
    }),
  );
  if (Option.isNone(result))
    return yield* Effect.fail(
      fail("Another TorBox preparation is in progress. Search again shortly."),
    );
  return result.value;
});

export const resolve = Effect.fnUntraced(function* (
  selection: Selection & { files: readonly File[]; reuseAccount?: boolean },
  key: string,
) {
  const same = (files: readonly File[]) =>
    selection.files.every((f) =>
      files.some((c) => c.name === f.name && c.size === f.size),
    );
  let torrent: typeof ReadyTorrent.Type | undefined;
  if (selection.reuseAccount) {
    const matches = (yield* account(key)).filter(
      (item) => item.hash === selection.hash,
    );
    const existing = matches.find(ready);
    if (existing)
      torrent = yield* decode(ReadyTorrent, existing, "TorBox files");
    else if (matches.length)
      return yield* Effect.fail(
        fail(
          "TorBox has not made this preparation available. Check it in TorBox and search again later.",
        ),
      );
  }
  if (!torrent) {
    const created = yield* create(selection.hash, key, true);
    const result = yield* decode(
      Schema.Union([ReadyTorrent, Schema.Array(ReadyTorrent)]),
      yield* call(`mylist?id=${created.torrent_id}&bypass_cache=true`, key),
      "TorBox files",
    );
    const torrents = "files" in result ? [result] : result;
    torrent = torrents.find((t) => t.id === created.torrent_id);
  }
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
  return yield* Effect.try({
    try: () => {
      const url = new URL(destination);
      // BookOrbit also checks the resolved address before downloading.
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
      // Native TorBox downloads carry the account token on its own CDN.
      if (decodeURIComponent(url.href).includes(key)) {
        if (
          !cdnDomains.some((domain) => hostname.endsWith(domain)) ||
          url.searchParams.getAll("token").length !== 1 ||
          url.searchParams.get("token") !== key
        )
          throw Error();
        const withoutToken = new URL(url);
        withoutToken.searchParams.delete("token");
        if (decodeURIComponent(withoutToken.href).includes(key)) throw Error();
      }
      return url.href;
    },
    catch: () => fail("TorBox did not return a safe direct download link."),
  });
});
