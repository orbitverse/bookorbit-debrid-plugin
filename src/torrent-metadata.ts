import * as Effect from "effect/Effect";
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

export const metadataHash = Effect.fnUntraced(function* (
  value: string,
  endpoint: string,
  key: string,
) {
  const host = yield* Network;
  let url = yield* Effect.try({
    try: () => downloadUrl(value, endpoint, key),
    catch: () => fail("Skipped an untrusted torrent metadata link."),
  });
  for (let hop = 0; hop <= 3; hop++) {
    const response = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await host.fetch(url.href, { redirect: "manual" });
        if (signal.aborted) {
          await response.body?.cancel();
          throw Error("cancelled");
        }
        return response;
      },
      catch: () => fail("Could not retrieve torrent metadata.", "unreachable"),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      yield* Effect.tryPromise({
        try: async () => {
          await response.body?.cancel();
        },
        catch: () => fail("Could not release torrent metadata."),
      });
      const location = response.headers.get("location");
      if (!location || hop === 3)
        return yield* Effect.fail(
          fail("Torrent metadata redirect limit reached."),
        );
      const magnet = magnetHash(location);
      if (magnet) return magnet;
      // LAN permission belongs to the indexer, not an arbitrary redirect host.
      url = yield* Effect.try({
        try: () => downloadUrl(new URL(location, url).href, endpoint, key),
        catch: () => fail("Skipped an untrusted torrent metadata redirect."),
      });
      continue;
    }
    const bytes = yield* Effect.tryPromise({
      try: async (signal) => {
        if (
          !response.ok ||
          /text\/html/i.test(response.headers.get("content-type") ?? "") ||
          Number(response.headers.get("content-length")) > 2 * 1024 ** 2 ||
          !response.body
        ) {
          await response.body?.cancel();
          throw Error("invalid metadata");
        }
        const reader = response.body.getReader(),
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
            if (size > 2 * 1024 ** 2) throw Error("oversized metadata");
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
      },
      catch: () => fail("Torrent metadata was invalid, blocked or too large."),
    });
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
