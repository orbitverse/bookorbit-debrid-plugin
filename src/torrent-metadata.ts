import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fail } from "./model.js";
import { Network } from "./http.js";

export function magnetHash(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "magnet:") return;
    const hashes = url.searchParams.getAll("xt").flatMap((xt) => {
      const value = /^urn:btih:([a-f0-9]{40}|[a-z2-7]{32})$/i.exec(xt)?.[1];
      if (!value) return [];
      if (value.length === 40) return [value.toLowerCase()];
      let bits = 0,
        pending = 0;
      const bytes: number[] = [];
      for (const character of value.toUpperCase()) {
        pending =
          (pending << 5) |
          "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character);
        bits += 5;
        if (bits >= 8) {
          bits -= 8;
          bytes.push((pending >> bits) & 255);
        }
      }
      return [bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")];
    });
    return new Set(hashes).size === 1 ? hashes[0] : undefined;
  } catch {
    return;
  }
}

// Hash the original info slice: re-encoding bencode can change torrent identity.
function infoBytes(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  let position = 0,
    nodes = 0;
  type Value = {
    start: number;
    end: number;
    kind: string;
    length?: number;
    integer?: number;
    fields?: Map<string, Value>;
  };
  const invalid = () => {
    throw fail("Torrent metadata was not recognized.");
  };
  const string = () => {
    const start = position;
    while (bytes[position] >= 48 && bytes[position] <= 57) position++;
    const digits = new TextDecoder().decode(bytes.subarray(start, position));
    if (!/^(0|[1-9][0-9]{0,6})$/.test(digits) || bytes[position++] !== 58)
      return invalid();
    const length = Number(digits),
      content = position;
    position += length;
    if (position > bytes.length) return invalid();
    return { content, length };
  };
  const parse = (depth: number): Value => {
    if (depth > 32 || ++nodes > 100000 || position >= bytes.length)
      return invalid();
    const start = position,
      marker = bytes[position];
    if (marker >= 48 && marker <= 57) {
      const value = string();
      return { start, end: position, kind: "string", length: value.length };
    }
    position++;
    if (marker === 105) {
      const first = position;
      while (position < bytes.length && bytes[position] !== 101) position++;
      const number = new TextDecoder().decode(bytes.subarray(first, position));
      if (
        bytes[position++] !== 101 ||
        !/^(0|-?[1-9][0-9]{0,15})$/.test(number) ||
        !Number.isSafeInteger(Number(number))
      )
        return invalid();
      return { start, end: position, kind: "integer", integer: Number(number) };
    }
    if (marker !== 100 && marker !== 108) return invalid();
    const fields = marker === 100 ? new Map<string, Value>() : undefined;
    while (bytes[position] !== 101) {
      if (position >= bytes.length) return invalid();
      if (fields) {
        const key = string();
        if (key.length > 256) return invalid();
        const name = Array.from(
          bytes.subarray(key.content, key.content + key.length),
          (byte) => String.fromCharCode(byte),
        ).join("");
        if (fields.has(name)) return invalid();
        fields.set(name, parse(depth + 1));
      } else parse(depth + 1);
    }
    position++;
    return {
      start,
      end: position,
      kind: fields ? "dictionary" : "list",
      fields,
    };
  };
  const root = parse(0),
    info = root.fields?.get("info"),
    fields = info?.fields,
    hasLength = (fields?.get("length")?.integer ?? -1) >= 0,
    hasFiles = fields?.get("files")?.kind === "list";
  if (
    root.kind !== "dictionary" ||
    position !== bytes.length ||
    !info ||
    !fields ||
    fields.get("name")?.kind !== "string" ||
    fields.get("pieces")?.kind !== "string" ||
    !fields.get("pieces")!.length ||
    fields.get("pieces")!.length! % 20 !== 0 ||
    (fields.get("piece length")?.integer ?? 0) <= 0 ||
    hasLength === hasFiles ||
    (fields.has("private") && fields.get("private")?.integer !== 0)
  )
    return invalid();
  return bytes.subarray(info.start, info.end);
}

function downloadUrl(value: string, endpoint: string, key: string): URL {
  const base = new URL(endpoint),
    url = new URL(value, base);
  const jackett =
    /^(.*)\/api\/v2\.0\/indexers\/([^/]+)\/results\/torznab\/api\/?$/.exec(
      base.pathname,
    );
  const expected = jackett
    ? `${jackett[1]}/dl/${jackett[2]}`
    : base.pathname.replace(/\/api\/?$/, "/download");
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol) ||
    url.pathname.replace(/\/$/, "") !== expected.replace(/\/$/, "")
  )
    throw fail("Torrent metadata link is not a trusted indexer download.");
  const parameter = jackett ? "jackett_apikey" : "apikey";
  url.searchParams.set(parameter, key);
  return url;
}

/**
 * The torrent link gave no answer about the torrent. Only a complete response that was then
 * judged is an answer: not found or another 4xx, an HTML page, too large, not a supported public
 * v1 torrent, an untrusted link or too many redirects.
 */
class Unanswered extends Schema.TaggedError<Unanswered>()("Unanswered", {
  kind: Schema.Literals(["throttled", "unreachable", "error"]),
}) {}

// Everything that waits on the torrent link's connection goes through here, so a connection that
// fails at any point before the response is complete, headers or body, is unreachable.
const transport = <A>(wait: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: wait,
    catch: () => new Unanswered({ kind: "unreachable" }),
  });

const metadataHash = Effect.fnUntraced(function* (
  value: string,
  endpoint: string,
  key: string,
) {
  const host = yield* Network;
  const rejected = fail("Torrent metadata was invalid, blocked or too large.");
  let url = yield* Effect.try({
    try: () => downloadUrl(value, endpoint, key),
    catch: () => fail("Skipped an untrusted torrent metadata link."),
  });
  for (let hop = 0; hop <= 3; hop++) {
    const response = yield* transport(async (signal) => {
      const response = await host.fetch(url.href, { redirect: "manual" });
      if (signal.aborted) {
        await response.body?.cancel();
        throw Error("cancelled");
      }
      return response;
    });
    // The headers alone decided the answer: the body is dropped unread.
    const release = Effect.promise(async () => {
      try {
        await response.body?.cancel();
      } catch {
        // Whether cancel() rejects or throws, the answer the headers gave stands.
      }
    });
    if (response.status === 429 || response.status >= 500) {
      yield* release;
      return yield* new Unanswered({
        kind: response.status === 429 ? "throttled" : "error",
      });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      yield* release;
      const location = response.headers.get("location");
      const magnet = location && magnetHash(location);
      if (magnet) return magnet;
      if (!location || hop === 3)
        return yield* Effect.fail(
          fail("Torrent metadata redirect limit reached."),
        );
      // LAN permission belongs to the indexer, not an arbitrary redirect host.
      url = yield* Effect.try({
        try: () => downloadUrl(new URL(location, url).href, endpoint, key),
        catch: () => fail("Skipped an untrusted torrent metadata redirect."),
      });
      continue;
    }
    const body = response.body;
    if (
      !response.ok ||
      /text\/html/i.test(response.headers.get("content-type") ?? "") ||
      Number(response.headers.get("content-length")) > 2 * 1024 ** 2 ||
      !body
    ) {
      yield* release;
      return yield* Effect.fail(rejected);
    }
    // The whole body, or nothing once it has passed the size limit.
    const bytes = yield* transport(async (signal) => {
      const reader = body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          const chunk = await reader.read();
          if (signal.aborted) throw Error("cancelled");
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 2 * 1024 ** 2) return;
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return bytes;
      } finally {
        signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });
    if (!bytes) return yield* Effect.fail(rejected);
    const info = yield* Effect.try({
      try: () => infoBytes(bytes),
      catch: () => fail("Torrent metadata was not a supported v1 torrent."),
    });
    const digest = yield* Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-1", info),
      catch: () => fail("Could not identify torrent metadata."),
    });
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  return yield* Effect.fail(fail("Torrent metadata could not be identified."));
});

// Each search owns this set; validate every feed's link before sharing work.
export function metadataLookup(key: string) {
  const lookups = new Map<string, ReturnType<typeof metadataHash>>();
  return Effect.fnUntraced(function* (value: string, endpoint: string) {
    const url = yield* Effect.try({
      try: () => downloadUrl(value, endpoint, key).href,
      catch: () => fail("Skipped an untrusted torrent metadata link."),
    });
    let lookup = lookups.get(url);
    if (!lookup) {
      lookup = yield* Effect.cached(metadataHash(url, endpoint, key));
      lookups.set(url, lookup);
    }
    return yield* lookup;
  });
}
