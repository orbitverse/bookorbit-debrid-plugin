import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import {
  Hash,
  Size,
  fail,
  type File,
  type PluginReleaseQuery,
} from "./model.js";
import { decode, json, request } from "./http.js";
import { selectFiles } from "./books.js";

const base = "https://debrid-link.com/api/v2/";
const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,200}$/));
const Envelope = Schema.Struct({
  success: Schema.Boolean,
  value: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String),
  pagination: Schema.optionalKey(Schema.Unknown),
});
const Listed = Schema.Struct({ id: Id, hashString: Hash });
const Torrent = Schema.Struct({
  id: Id,
  hashString: Hash,
  name: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Int),
  downloadPercent: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ),
  isZip: Schema.optionalKey(Schema.Boolean),
  srvMaint: Schema.optionalKey(Schema.Boolean),
  files: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Id,
        name: Schema.NonEmptyString,
        size: Size,
        downloadUrl: Schema.optionalKey(Schema.String),
        downloadPercent: Schema.Number.check(
          Schema.isBetween({ minimum: 0, maximum: 100 }),
        ),
      }),
    ),
  ),
});
const call = Effect.fnUntraced(function* (
  route: string,
  key: string,
  body?: unknown,
) {
  const response = yield* request(
    base + route,
    "Debrid-Link",
    {
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    },
    body === undefined,
  );
  const result = yield* decode(Envelope, yield* json(response), "Debrid-Link");
  if (!result.success) {
    const authentication = [
        "badToken",
        "access_denied",
        "expired_token",
      ].includes(result.error ?? ""),
      limited = ["floodDetected", "maxLink", "maxTorrent"].includes(
        result.error ?? "",
      );
    return yield* Effect.fail(
      fail(
        authentication
          ? "Debrid-Link rejected account access. Check your token and permissions."
          : limited
            ? "Debrid-Link account allowance reached. Check your account and retry later."
            : "Debrid-Link could not complete this request. Check your account and retry later.",
        authentication ? "unauthorized" : limited ? "throttled" : "error",
      ),
    );
  }
  return result;
});
const inventory = Effect.fnUntraced(function* (
  hashes: readonly string[],
  key: string,
) {
  const requested = yield* decode(
    Schema.Array(Hash).check(Schema.isMaxLength(100)),
    hashes,
    "Debrid-Link hashes",
  );
  const result = yield* call(
    "seedbox/list?structureType=list&page=0&perPage=100",
    key,
  );
  const listed = yield* decode(
    Schema.Array(Listed).check(Schema.isMaxLength(100)),
    result.value,
    "Debrid-Link account",
  );
  const pagination = yield* decode(
    Schema.Struct({
      page: Schema.Int,
      pages: Schema.Int,
      next: Schema.Int,
      previous: Schema.Int,
    }),
    result.pagination,
    "Debrid-Link pagination",
  );
  if (
    pagination.page !== 0 ||
    ![0, 1].includes(pagination.pages) ||
    pagination.next !== -1 ||
    pagination.previous !== -1
  )
    return yield* Effect.fail(
      fail(
        "This preview can check at most 100 Debrid-Link account torrents; the account listing is incomplete.",
      ),
    );
  const matches = [
    ...new Map(
      listed
        .filter((item) => requested.includes(item.hashString))
        .map((item) => [item.id, item]),
    ).values(),
  ];
  if (matches.length > 8)
    return yield* Effect.fail(
      fail(
        "This search matched more than eight Debrid-Link account torrents. Choose another search or use your Debrid-Link account.",
      ),
    );
  return yield* Effect.forEach(
    matches,
    (item) =>
      Effect.gen(function* () {
        const detail = yield* call(
          `seedbox/list?ids=${item.id}&structureType=list`,
          key,
        );
        const torrents = yield* decode(
          Schema.Array(Torrent),
          detail.value,
          "Debrid-Link files",
        );
        if (
          torrents.length !== 1 ||
          torrents[0].id !== item.id ||
          torrents[0].hashString !== item.hashString
        )
          return yield* Effect.fail(
            fail("Debrid-Link returned a different torrent. Search again."),
          );
        return torrents[0];
      }),
    { concurrency: 4 },
  );
});
const name = (path: string) => path.replace(/^\/+/, "");
const ready = (torrent: typeof Torrent.Type) =>
  (torrent.status === 8 || torrent.status === 100) &&
  torrent.downloadPercent === 100 &&
  !torrent.srvMaint &&
  !!torrent.files?.length &&
  torrent.files.every(
    (file) =>
      file.downloadPercent === 100 && file.size > 0 && !!file.downloadUrl,
  );
const safeUrl = Effect.fnUntraced(function* (value: string, key: string) {
  return yield* Effect.try({
    try: () => {
      const url = new URL(value),
        hostname = url.hostname.replace(/\.$/, "");
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        (hostname === "debrid-link.com" && url.pathname.startsWith("/api/")) ||
        hostname === "api.debrid-link.com" ||
        !hostname.includes(".") ||
        /^[\d.]+$/.test(hostname) ||
        hostname.includes(":") ||
        /\.(?:localhost|local|internal|lan)$/.test(hostname)
      )
        throw Error();
      const secrets = [
        key,
        Buffer.from(key).toString("base64"),
        Buffer.from(key).toString("base64url"),
      ];
      let decoded = url.href;
      for (let depth = 0; depth < 3; depth++) {
        if (secrets.some((secret) => secret && decoded.includes(secret)))
          throw Error();
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
      if (
        decodeURIComponent(decoded) !== decoded ||
        secrets.some((secret) => secret && decoded.includes(secret))
      )
        throw Error();
      return url.href;
    },
    catch: () =>
      fail("Debrid-Link did not return a safe direct download link."),
  });
});
const files = (torrent: typeof Torrent.Type): File[] =>
  (torrent.files ?? []).map((file) => ({
    name: name(file.name),
    size: file.size,
  }));
const readyForHash = Effect.fnUntraced(function* (
  torrents: readonly (typeof Torrent.Type)[],
  hash: string,
  key: string,
) {
  const matches = torrents.filter(
    (torrent) => torrent.hashString === hash && ready(torrent),
  );
  const fingerprint = (torrent: typeof Torrent.Type) =>
    JSON.stringify(files(torrent).sort((a, b) => a.name.localeCompare(b.name)));
  if (new Set(matches.map(fingerprint)).size > 1)
    return yield* Effect.fail(
      fail(
        "Debrid-Link has conflicting ready files for this torrent. Check the entries in your account.",
      ),
    );
  const chosen = matches[0];
  if (chosen)
    for (const file of chosen.files ?? [])
      yield* safeUrl(file.downloadUrl!, key);
  return chosen;
});

export const cached = Effect.fnUntraced(function* (
  hashes: readonly string[],
  key: string,
) {
  if (!hashes.length) return [];
  const torrents = yield* inventory(hashes, key),
    available: { hash: string; name: string; files: File[] }[] = [];
  for (const hash of new Set(hashes)) {
    const torrent = yield* readyForHash(torrents, hash, key);
    if (torrent)
      available.push({
        hash,
        name: torrent.name || hash,
        files: files(torrent),
      });
  }
  return available;
});
export const verify = Effect.fnUntraced(function* (key: string) {
  yield* decode(
    Schema.Struct({ accountType: Schema.Int, premiumLeft: Size }),
    (yield* call("account/infos", key)).value,
    "Debrid-Link account",
  );
});
export const resolve = Effect.fnUntraced(function* (
  selection: { hash: string; files: readonly File[]; format: string },
  key: string,
) {
  if (selection.format === "zip" || selection.files.length !== 1)
    return yield* Effect.fail(
      fail(
        "Debrid-Link supports single-file books here. Choose a complete ebook or single-file audiobook.",
      ),
    );
  const torrent = yield* readyForHash(
    yield* inventory([selection.hash], key),
    selection.hash,
    key,
  );
  const expected = selection.files[0];
  const matches =
    torrent?.files?.filter(
      (file) =>
        name(file.name) === expected.name && file.size === expected.size,
    ) ?? [];
  if (matches.length !== 1)
    return yield* Effect.fail(
      fail("This Debrid-Link file changed or is not ready. Search again."),
    );
  return yield* safeUrl(matches[0].downloadUrl!, key);
});
const preparation = Semaphore.makeUnsafe(1);
export const prepare = Effect.fnUntraced(function* (
  hash: string,
  key: string,
  context: Pick<PluginReleaseQuery, "title" | "mediaKind">,
) {
  const result = yield* preparation.withPermitsIfAvailable(1)(
    Effect.gen(function* () {
      const existing = yield* inventory([hash], key),
        torrent = yield* readyForHash(existing, hash, key);
      if (torrent) {
        if (
          selectFiles(files(torrent), context).some(
            (choice) => choice.format !== "zip" && choice.files.length === 1,
          )
        )
          return { status: "ready" as const };
        return yield* Effect.fail(
          fail(
            "Debrid-Link has no supported complete single-file book here. Choose another release or check your account.",
          ),
        );
      }
      if (existing.length) return { status: "preparing" as const };
      const added = yield* call("seedbox/add", key, {
        url: `magnet:?xt=urn:btih:${hash}`,
        wait: false,
        structureType: "list",
      }).pipe(
        Effect.catch((error) =>
          error.kind === "unreachable" || error.kind === "timeout"
            ? Effect.fail(
                fail(
                  "The Debrid-Link preparation outcome is uncertain. Check your account before trying again; a job may exist.",
                ),
              )
            : Effect.fail(error),
        ),
      );
      const identity = yield* decode(
        Schema.Struct({
          id: Schema.optionalKey(Id),
          hashString: Schema.optionalKey(Hash),
        }),
        added.value,
        "Debrid-Link preparation",
      );
      if (identity.hashString !== undefined && identity.hashString !== hash)
        return yield* Effect.fail(
          fail(
            "Debrid-Link returned a different torrent. Check your account before trying again.",
          ),
        );
      return { status: "preparing" as const };
    }),
  );
  if (Option.isNone(result))
    return yield* Effect.fail(
      fail(
        "Another Debrid-Link preparation is in progress. Search again shortly.",
      ),
    );
  return result.value;
});
