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

const base = "https://api.real-debrid.com/rest/1.0/";
const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,200}$/));
const Listed = Schema.Struct({ id: Id, hash: Hash, status: Schema.String });
const Torrent = Schema.Struct({
  id: Id,
  hash: Hash,
  filename: Schema.String,
  status: Schema.String,
  progress: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  files: Schema.Array(
    Schema.Struct({
      id: Schema.Int.check(Schema.isGreaterThan(0)),
      path: Schema.NonEmptyString,
      bytes: Size,
      selected: Schema.Literals([0, 1]),
    }),
  ),
  links: Schema.Array(Schema.NonEmptyString),
});
const path = (value: string) => value.replace(/^\/+/, "");
const terminal = (status: string) =>
  ["magnet_error", "error", "virus", "dead"].includes(status);
const send = (route: string, key: string, fields?: Record<string, string>) =>
  request(
    base + route,
    "Real-Debrid",
    {
      headers: {
        Authorization: `Bearer ${key}`,
        ...(fields
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      ...(fields
        ? { method: "POST", body: new URLSearchParams(fields).toString() }
        : {}),
    },
    !fields,
  );
const info = Effect.fnUntraced(function* (
  id: string,
  hash: string,
  key: string,
) {
  const torrent = yield* decode(
    Torrent,
    yield* json(yield* send(`torrents/info/${id}`, key)),
    "Real-Debrid files",
  );
  if (torrent.id !== id || torrent.hash !== hash)
    return yield* Effect.fail(
      fail("Real-Debrid returned a different torrent. Search again."),
    );
  return torrent;
});
const inventory = Effect.fnUntraced(function* (
  hashes: readonly string[],
  key: string,
) {
  const requested = yield* decode(
    Schema.Array(Hash).check(Schema.isMaxLength(100)),
    hashes,
    "Real-Debrid hashes",
  );
  const response = yield* send("torrents?limit=100&page=1", key);
  const listed = yield* decode(
    Schema.Array(Listed).check(Schema.isMaxLength(100)),
    yield* json(response),
    "Real-Debrid account",
  );
  const total = response.headers.get("x-total-count");
  if (
    (total !== null &&
      (!/^\d+$/.test(total) ||
        Number(total) > 100 ||
        Number(total) < listed.length)) ||
    (total === null && listed.length === 100)
  )
    return yield* Effect.fail(
      fail(
        "This preview can check at most 100 Real-Debrid account torrents; your account listing is incomplete.",
      ),
    );
  const matches = [
    ...new Map(
      listed
        .filter((item) => requested.includes(item.hash))
        .map((item) => [item.id, item]),
    ).values(),
  ];
  if (matches.length > 8)
    return yield* Effect.fail(
      fail(
        "This search matched more than eight Real-Debrid account torrents. Choose another search or prepare through the Real-Debrid website.",
      ),
    );
  return yield* Effect.forEach(
    matches,
    (item) => info(item.id, item.hash, key),
    { concurrency: 4 },
  );
});

const singleton = (torrent: typeof Torrent.Type) => {
  const selected = torrent.files.filter((file) => file.selected === 1);
  return torrent.status === "downloaded" &&
    torrent.progress === 100 &&
    selected.length === 1 &&
    torrent.links.length === 1 &&
    selected[0].bytes > 0
    ? {
        file: { name: path(selected[0].path), size: selected[0].bytes },
        link: torrent.links[0],
      }
    : undefined;
};
const readyForHash = Effect.fnUntraced(function* (
  torrents: readonly (typeof Torrent.Type)[],
  hash: string,
) {
  const ready = torrents
    .filter((item) => item.hash === hash)
    .flatMap((item) => {
      const value = singleton(item);
      return value ? [{ torrent: item, ...value }] : [];
    });
  if (new Set(ready.map((item) => JSON.stringify(item.file))).size > 1)
    return yield* Effect.fail(
      fail(
        "Real-Debrid has conflicting selected files for this torrent. Choose one complete file in your account.",
      ),
    );
  return ready[0];
});

export const cached = Effect.fnUntraced(function* (
  hashes: readonly string[],
  key: string,
) {
  if (!hashes.length) return [];
  const torrents = yield* inventory(hashes, key);
  const ready: { hash: string; name: string; files: File[] }[] = [];
  for (const hash of new Set(hashes)) {
    const selected = yield* readyForHash(torrents, hash);
    if (selected)
      ready.push({
        hash,
        name: selected.torrent.filename || hash,
        files: [selected.file],
      });
  }
  return ready;
});

export const verify = Effect.fnUntraced(function* (key: string) {
  yield* decode(
    Schema.Struct({
      id: Schema.Int,
      type: Schema.Literals(["premium", "free"]),
      premium: Size,
    }),
    yield* json(yield* send("user", key)),
    "Real-Debrid account",
  );
});

const safeUrl = Effect.fnUntraced(function* (destination: string, key: string) {
  return yield* Effect.try({
    try: () => {
      const url = new URL(destination),
        hostname = url.hostname.replace(/\.$/, "");
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        hostname === "api.real-debrid.com" ||
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
      let value = url.href;
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
    catch: () =>
      fail("Real-Debrid did not return a safe direct download link."),
  });
});

export const resolve = Effect.fnUntraced(function* (
  selection: { hash: string; files: readonly File[]; format: string },
  key: string,
) {
  if (selection.format === "zip" || selection.files.length !== 1)
    return yield* Effect.fail(
      fail(
        "Real-Debrid supports one complete selected file here. Choose a single-file book.",
      ),
    );
  const ready = yield* readyForHash(
    yield* inventory([selection.hash], key),
    selection.hash,
  );
  const expected = selection.files[0];
  if (
    !ready ||
    ready.file.name !== expected.name ||
    ready.file.size !== expected.size
  )
    return yield* Effect.fail(
      fail("This Real-Debrid file changed or is not ready. Search again."),
    );
  const link = yield* safeUrl(ready.link, key);
  const result = yield* decode(
    Schema.Struct({
      filename: Schema.NonEmptyString,
      filesize: Size,
      download: Schema.NonEmptyString,
    }),
    yield* json(yield* send("unrestrict/link", key, { link })),
    "Real-Debrid download",
  );
  if (
    result.filename !== expected.name.split(/[\\/]/).pop() ||
    result.filesize !== expected.size
  )
    return yield* Effect.fail(
      fail(
        "The Real-Debrid download does not match the selected file. Search again.",
      ),
    );
  return yield* safeUrl(result.download, key);
});

const preparation = Semaphore.makeUnsafe(1);
export const prepare = Effect.fnUntraced(function* (
  hash: string,
  key: string,
  context: Pick<PluginReleaseQuery, "title" | "mediaKind">,
) {
  const result = yield* preparation.withPermitsIfAvailable(1)(
    Effect.gen(function* () {
      const existing = yield* inventory([hash], key);
      const ready = yield* readyForHash(existing, hash);
      const healthy =
        ready?.torrent ?? existing.find((item) => !terminal(item.status));
      if (!healthy && existing.length)
        return yield* Effect.fail(
          fail(
            "This Real-Debrid torrent failed. Check your account; it was not restarted.",
          ),
        );
      let torrent = healthy;
      if (!torrent) {
        const added = yield* Effect.gen(function* () {
          return yield* decode(
            Schema.Struct({ id: Id, uri: Schema.NonEmptyString }),
            yield* json(
              yield* send("torrents/addMagnet", key, {
                magnet: `magnet:?xt=urn:btih:${hash}`,
              }),
            ),
            "Real-Debrid preparation",
          );
        }).pipe(
          Effect.catch((error) =>
            error.kind === "unreachable" || error.kind === "timeout"
              ? Effect.fail(
                  fail(
                    "The Real-Debrid preparation outcome is uncertain. Check your account before trying again; a job may exist.",
                  ),
                )
              : Effect.fail(error),
          ),
        );
        torrent = yield* info(added.id, hash, key);
      }
      if (terminal(torrent.status))
        return yield* Effect.fail(
          fail(
            "This Real-Debrid torrent failed. Check your account; it was not restarted.",
          ),
        );
      if (torrent.status === "downloaded") {
        const selected = singleton(torrent);
        if (
          selected &&
          selectFiles([selected.file], context).some(
            (choice) => choice.format !== "zip" && choice.files.length === 1,
          )
        )
          return { status: "ready" as const };
        return yield* Effect.fail(
          fail(
            "Real-Debrid has no unambiguous single-file download. Select one complete book in your account.",
          ),
        );
      }
      if (
        torrent.status === "waiting_files_selection" &&
        !torrent.files.some((file) => file.selected === 1)
      ) {
        const choices = selectFiles(
          torrent.files
            .filter((file) => file.bytes > 0)
            .map((file) => ({
              name: path(file.path),
              size: file.bytes,
            })),
          context,
        ).filter(
          (choice) => choice.format !== "zip" && choice.files.length === 1,
        );
        if (choices.length !== 1)
          return yield* Effect.fail(
            fail(
              "Select one complete ebook or single-file audiobook in your Real-Debrid account, then search again.",
            ),
          );
        const selected = torrent.files.filter(
          (file) =>
            path(file.path) === choices[0].files[0].name &&
            file.bytes === choices[0].files[0].size,
        );
        if (selected.length !== 1)
          return yield* Effect.fail(
            fail(
              "Real-Debrid file selection is ambiguous. Select the file in your account.",
            ),
          );
        yield* send(`torrents/selectFiles/${torrent.id}`, key, {
          files: String(selected[0].id),
        }).pipe(
          Effect.catch((error) =>
            error.kind === "unreachable" || error.kind === "timeout"
              ? Effect.fail(
                  fail(
                    "The Real-Debrid file-selection outcome is uncertain. Check your account before retrying.",
                  ),
                )
              : Effect.fail(error),
          ),
        );
      }
      return { status: "preparing" as const };
    }),
  );
  if (Option.isNone(result))
    return yield* Effect.fail(
      fail(
        "Another Real-Debrid preparation is in progress. Search again shortly.",
      ),
    );
  return result.value;
});
