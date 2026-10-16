import type { File, PluginReleaseQuery } from "./model.js";

const ebook = new Set(["epub", "pdf", "mobi", "azw3", "fb2", "djvu"]);
const audio = new Set(["m4b", "mp3", "m4a", "flac", "ogg", "opus"]);
const extension = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
export const isAudioFile = (name: string) => audio.has(extension(name));
const normalize = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export function matches(title: string, value: string): boolean {
  const words = normalize(title).split(" ").filter(Boolean);
  const found = new Set(normalize(value).split(" "));
  return words.length > 0 && words.every((word) => found.has(word));
}

export function selectFiles(
  files: readonly File[],
  q: Pick<PluginReleaseQuery, "title" | "mediaKind">,
): { files: File[]; format: string }[] {
  if (
    !files.length ||
    files.length > 100 ||
    files.some((f) => /(?:^|[\\/])\.\.(?:[\\/]|$)|[\x00-\x1f]/.test(f.name))
  )
    return [];
  if (q.mediaKind === "ebook")
    return files
      .filter((f) => ebook.has(extension(f.name)) && matches(q.title, f.name))
      .map((f) => ({ files: [f], format: extension(f.name) }));
  const tracks = files.filter((f) => isAudioFile(f.name));
  if (!tracks.length) return [];
  if (tracks.length === 1) {
    const name = tracks[0].name.split(/[\\/]/).pop()!;
    const remainder = normalize(name.replace(/\.[^.]+$/, ""))
      .replace(normalize(q.title), "")
      .trim();
    const chapter =
      /(?:^|\s)(?:(?:chapter|track|part|disc|cd)\s*)?\d{1,3}(?:\s|$)/i.test(
        remainder,
      );
    return matches(q.title, name) && !chapter
      ? [{ files: tracks, format: extension(tracks[0].name) }]
      : [];
  }
  // Bundle only an explicit, single numbered track sequence in one matching folder.
  // Independent M4B editions or multiple folders must never become one audiobook.
  const parent = (name: string) => {
    const index = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
    return index < 0 ? "" : name.slice(0, index);
  };
  const folder = parent(tracks[0].name);
  if (
    !matches(q.title, folder) ||
    tracks.some((f) => parent(f.name) !== folder || extension(f.name) === "m4b")
  )
    return [];
  const numbers = tracks.map((f) =>
    Number(
      f.name
        .split(/[\\/]/)
        .pop()
        ?.match(/(?:^|\b)(\d{1,3})(?:\b|_)/)?.[1],
    ),
  );
  const sorted = [...numbers].sort((a, b) => a - b);
  if (sorted.some((n, i) => !Number.isInteger(n) || n !== i + 1)) return [];
  const extrasSafe = files.every(
    (f) =>
      audio.has(extension(f.name)) ||
      ["jpg", "jpeg", "png", "nfo", "txt", "cue", "m3u", "m3u8"].includes(
        extension(f.name),
      ),
  );
  return extrasSafe
    ? [
        {
          files: [...tracks].sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true }),
          ),
          format: "zip",
        },
      ]
    : [];
}

export function safeFileName(title: string, format: string): string {
  return `${
    title
      .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 160) || "book"
  }.${format}`;
}
