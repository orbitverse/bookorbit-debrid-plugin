import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/index.js";
import { matches, selectFiles } from "../src/books.js";
import type {
  PluginHost,
  PluginIndexerConfig,
  PluginReleaseQuery,
} from "../vendor/bookorbit-plugin-api.js";

type Named = string | [name: string, size: number];
type Row = {
  name: string;
  title: string;
  files: Named[];
  // The files offered, one release each. Omitted: every file, as before the rule.
  offers?: string[];
  mediaKind?: "audiobook";
};
const inFolder = (folder: string, names: string[]) =>
  names.map((name) => `${folder}/${name}`);
const sized = (files: Named[]) =>
  files.map((f) =>
    typeof f === "string"
      ? { name: f, size: 1000 }
      : { name: f[0], size: f[1] },
  );
const chronicles = inFolder("Frank Herbert - Dune Chronicles (6 books) EPUB", [
  "Children of Dune.epub",
  "Dune Messiah.epub",
  "Dune.epub",
  "God Emperor of Dune.epub",
]);
const tolkien = inFolder(
  "J.R.R. Tolkien - The Hobbit and The Lord of the Rings (epub)",
  [
    "The Fellowship of the Ring.epub",
    "The Two Towers.epub",
    "The Hobbit.epub",
    "The Return of the King.epub",
  ],
);
const wind = inFolder("Patrick Rothfuss - The Name of the Wind", [
  "The Name of the Wind.epub",
  "Map of the Four Corners.pdf",
  "Patrick Rothfuss - Interview.pdf",
]);

const rows: Row[] = [
  // A file named exactly for the title is the only one offered.
  {
    name: "the title's file in a series folder named for it",
    title: "Dune",
    files: chronicles,
    offers: [chronicles[2]],
  },
  {
    name: "the title's file in a pack whose folder lists it",
    title: "The Hobbit",
    files: tolkien,
    offers: [tolkien[2]],
  },
  {
    name: "the short title beside a longer form of it",
    title: "The Hobbit",
    files: [
      "The Hobbit.epub",
      ["The Hobbit, or There and Back Again.epub", 9000],
    ],
    offers: ["The Hobbit.epub"],
  },
  {
    name: "apostrophe and ampersand spellings are the same name",
    title: "Ender's Game & Others",
    files: [
      "Enders Game and Others.epub",
      "Ender's Game & Others (retail).epub",
    ],
    offers: ["Enders Game and Others.epub"],
  },
  {
    name: "one format is narrowed, another is left alone",
    title: "Dune",
    files: ["Dune.epub", "Dune Messiah.epub", "Dune 1.azw3", "Dune 2.azw3"],
    offers: ["Dune.epub", "Dune 1.azw3", "Dune 2.azw3"],
  },
  // Files named exactly for the title are all kept, whatever their folder or size.
  {
    name: "one name in two format folders",
    title: "Dune",
    files: ["Dune/epub2/Dune.epub", ["Dune/epub3/Dune.epub", 2000]],
  },
  {
    name: "one name in language folders",
    title: "Dune",
    files: [
      "Dune/EN/Dune.epub",
      ["Dune/DE/Dune.epub", 2000],
      "Dune/FR/Dune.epub",
    ],
  },
  {
    name: "one name in volume folders",
    title: "Overlord",
    files: [1, 2, 3].map((n): Named => [
      `Overlord/Vol ${n}/Overlord.epub`,
      n * 1000,
    ]),
  },
  {
    name: "one name by two authors",
    title: "Legend",
    files: ["Marie Lu/Legend.epub", ["David Gemmell/Legend.epub", 2000]],
  },
  // A sample gives way to a full file.
  {
    name: "a preview beside the full book",
    title: "Circe",
    files: ["Madeline Miller - Circe.epub", ["Circe (preview).epub", 9000]],
    offers: ["Madeline Miller - Circe.epub"],
  },
  { name: "a lone sample", title: "Dune", files: ["Dune (sample).epub"] },
  {
    name: "a title that carries the word",
    title: "The Sample",
    files: inFolder("The Sample", ["The Sample (retail).epub", "extras.epub"]),
  },
  // No file is named exactly for the title: every file is offered, as before.
  {
    name: "a sequel beside an author-named file",
    title: "Dune",
    files: ["Dune Messiah.epub", "Frank Herbert - Dune.epub"],
  },
  {
    name: "a dated file beside another title",
    title: "Foundation",
    files: ["Isaac Asimov - Foundation (1951).epub", "Second Foundation.epub"],
  },
  {
    name: "bracketed edition notes",
    title: "Dune",
    files: [["Dune/Dune [retail].epub", 2000], "Dune/Dune [converted].epub"],
  },
  {
    name: "two versions",
    title: "Circe",
    files: ["Circe v1.epub", ["Circe v2.epub", 2000]],
  },
  {
    name: "volumes marked vNN",
    title: "Overlord",
    files: Array.from({ length: 14 }, (_, i): Named => [
      `Overlord v${String(i + 1).padStart(2, "0")}.epub`,
      1000 + i,
    ]),
  },
  {
    name: "a book in two bracketed parts",
    title: "The Stand",
    files: ["The Stand (1 of 2).epub", ["The Stand (2 of 2).epub", 2000]],
  },
  {
    name: "numbered volumes",
    title: "Dune",
    files: [1, 2, 3, 4, 5, 6].map((n): Named => [`Dune ${n}.epub`, n * 1000]),
  },
  {
    name: "numbers only, in a series folder",
    title: "Dune",
    files: inFolder("Frank Herbert - Dune Chronicles", [
      "01.epub",
      "02.epub",
      "03.epub",
    ]),
  },
  {
    name: "language variants",
    title: "Dune",
    files: ["Dune (EN).epub", "Dune (DE).epub", ["Dune (FR).epub", 2000]],
  },
  {
    name: "two books of one title",
    title: "Emma",
    files: [
      "Emma (Jane Austen).epub",
      ["Emma (Alexander McCall Smith).epub", 2000],
    ],
  },
  {
    name: "a companion with the title as a dash part",
    title: "Hyperion",
    files: [
      "Hyperion (Hyperion Cantos, Book 1).epub",
      "The Fall of Hyperion (Hyperion Cantos, Book 2).epub",
      "Hyperion - Dan Simmons - Interview.epub",
    ],
  },
  {
    name: "a longer title beside a study guide",
    title: "The Hobbit",
    files: [
      "The Hobbit, or There and Back Again.epub",
      "The Hobbit - Study Guide.epub",
    ],
  },
  {
    name: "title by author with extras",
    title: "Atomic Habits",
    files: [
      "Atomic Habits by James Clear.pdf",
      "Atomic Habits - Cheat Sheet.pdf",
      "Atomic Habits - Workbook.pdf",
    ],
  },
  {
    name: "extras of another format",
    title: "The Name of the Wind",
    files: wind,
  },
  {
    name: "a bundle without the requested book",
    title: "Dune",
    files: ["Dune Messiah.epub", "Children of Dune.epub"],
  },
  {
    name: "generic names in a titled folder",
    title: "Dune",
    files: inFolder("Dune - Frank Herbert", ["book.epub", "book_kobo.epub"]),
  },
  // Single-book torrents.
  { name: "one epub", title: "Dune", files: ["Dune.epub"] },
  {
    name: "one file per format",
    title: "Dune",
    files: ["Dune.epub", "Dune.mobi", "Dune.pdf"],
  },
  {
    name: "an ISBN-named file with extras",
    title: "Dune",
    files: inFolder("Frank Herbert - Dune (1965) [EPUB]", [
      "9780441013593.epub",
      "cover.jpg",
      "metadata.opf",
    ]),
    offers: ["Frank Herbert - Dune (1965) [EPUB]/9780441013593.epub"],
  },
  {
    name: "book.epub with an nfo",
    title: "The Name of the Wind",
    files: inFolder("Patrick Rothfuss - The Name of the Wind", [
      "book.epub",
      "info.nfo",
    ]),
    offers: ["Patrick Rothfuss - The Name of the Wind/book.epub"],
  },
  // Folder and file carry the query together.
  {
    name: "series folder and volume file",
    title: "The Lord of the Rings: The Fellowship of the Ring",
    files: inFolder("The Lord of the Rings", [
      "The Fellowship of the Ring.epub",
      "The Two Towers.epub",
      "The Return of the King.epub",
    ]),
    offers: ["The Lord of the Rings/The Fellowship of the Ring.epub"],
  },
  {
    name: "sequel named by its own word",
    title: "Dune Messiah",
    files: ["Dune/Messiah.epub", "Dune/Dune.epub"],
    offers: ["Dune/Messiah.epub"],
  },
  // Audiobooks are untouched.
  {
    name: "a single m4b",
    title: "Dune",
    files: ["Dune.m4b"],
    mediaKind: "audiobook",
  },
  {
    name: "two m4b editions",
    title: "Dune",
    files: ["Dune.m4b", "Dune (2007).m4b"],
    offers: [],
    mediaKind: "audiobook",
  },
];

const random = (seed: number) => () =>
  (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
function orders<T>(items: readonly T[], seed: number): T[][] {
  const next = random(seed);
  return [
    [...items],
    [...items].reverse(),
    ...Array.from({ length: 4 }, () => {
      const shuffled = [...items];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    }),
  ];
}
const offered = (
  files: ReturnType<typeof sized>,
  title: string,
  mediaKind: Row["mediaKind"],
) =>
  selectFiles(files, { title, mediaKind: mediaKind ?? "ebook" })
    .map((selected) => {
      assert.equal(selected.files.length, 1);
      return selected.files[0].name;
    })
    .sort();

rows.forEach((row, index) =>
  test(`file selection: ${row.name}`, () => {
    const files = sized(row.files);
    const expected = (row.offers ?? files.map((f) => f.name)).sort();
    for (const order of orders(files, index + 1))
      assert.deepEqual(offered(order, row.title, row.mediaKind), expected);
  }),
);

test("file selection: numbered audio tracks stay one archive", () => {
  const tracks = [1, 2, 3].map((n) => ({
    name: `Dune/0${n} - Dune.mp3`,
    size: n,
  }));
  for (const files of orders(tracks, 7))
    assert.deepEqual(
      selectFiles(files, { title: "Dune", mediaKind: "audiobook" }),
      [{ files: tracks, format: "zip" }],
    );
});

// The ebook selection as it was before this rule.
const reference = (files: ReturnType<typeof sized>, title: string) =>
  files
    .filter(
      (f) =>
        /\.(?:epub|pdf|mobi|azw3|fb2|djvu)$/i.test(f.name) &&
        matches(title, f.name),
    )
    .map((f) => f.name)
    .sort();
const pool = [
  "Dune.epub",
  "DUNE.EPUB",
  "Dune.kepub.epub",
  "Dune (retail).epub",
  "Dune v1.0.epub",
  "Dune_v2.epub",
  "Dune - Preview.epub",
  "Dune sample.epub",
  "Dune 2.epub",
  "Dune Part 1.epub",
  "Dune (Vol 2).epub",
  "Dune Messiah.epub",
  "Dune - Messiah.epub",
  "Dune - English.epub",
  "Dune & Philosophy.epub",
  "Frank Herbert - Dune.epub",
  "Herbert, Frank - Dune [1965].epub",
  "Frank_Herbert_-_Dune.epub",
  "Dune Saga/book.epub",
  "Dune Saga\\Dune.epub",
  "Dune Saga/Heretics.epub",
  "Dune Saga/Dune Omnibus (Books 1-3).epub",
  "Dune.pdf",
  "Dune Saga/Map.pdf",
  "Dune.mobi",
  "Dune (converted).mobi",
  "Emma.epub",
  "cover.jpg",
];
test("file selection: only ever narrows what was offered before, in any order", () => {
  const next = random(2026);
  const sets = [
    ...rows
      .filter((row) => !row.mediaKind)
      .map((row) => ({ title: row.title, files: sized(row.files) })),
    ...Array.from({ length: 80 }, () => ({
      title: "Dune",
      files: pool
        .filter(() => next() < 0.3)
        .map((name) => ({ name, size: 1000 + Math.floor(next() * 3) })),
    })),
  ];
  assert(sets.length >= 90);
  sets.forEach(({ title, files }, index) => {
    const before = reference(files, title);
    const [first, ...others] = orders(files, index + 99).map((order) =>
      offered(order, title, undefined),
    );
    for (const other of others) assert.deepEqual(other, first);
    assert(first.every((name) => before.includes(name)));
    assert.equal(first.length > 0, before.length > 0);
  });
});

const hash = "c".repeat(40);
const providerKey = "SYNTHETIC_PROVIDER_KEY";
const cfg: PluginIndexerConfig = {
  id: 1,
  name: "Debrid",
  baseUrl: "http://prowlarr.example:9696",
  allowPrivateAddress: false,
  categories: { ebook: [7020], audiobook: [3030] },
  settings: { indexerPaths: "/1/api" },
  credential: JSON.stringify({
    indexerKey: "SYNTHETIC_INDEXER_KEY",
    debrid: { provider: "torbox", key: providerKey },
  }),
};
const query: PluginReleaseQuery = {
  title: "Dune",
  author: "Frank Herbert",
  isbn13: null,
  isbn13s: [],
  mediaKind: "ebook",
  language: null,
  limit: 20,
};
const json = (data: unknown) =>
  Response.json({ success: true, error: null, data });
const bundles: [string, string, string[], string][] = [
  [
    "a series folder",
    "Frank Herbert - Dune Chronicles (6 books) EPUB",
    chronicles,
    chronicles[2],
  ],
];
for (const [name, torrentTitle, names, wanted] of bundles)
  test(`a multi-book torrent delivers the requested book: ${name}`, async () => {
    const files = names.map((file, i) => ({ name: file, size: 9000 - i }));
    const requested: string[] = [];
    const host: PluginHost = {
      async fetch(input, init) {
        const url = new URL(input);
        assert.equal(init?.redirect, "manual");
        if (url.hostname === "prowlarr.example")
          return new Response(
            `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Book indexer</title><item><title>${torrentTitle}</title><torznab:attr name="infohash" value="${hash}"/></item></channel></rss>`,
          );
        assert.equal(url.origin, "https://api.torbox.app");
        if (url.pathname.endsWith("checkcached"))
          return json(
            JSON.parse(init!.body!).hashes.length
              ? { [hash]: { hash, name: torrentTitle, files } }
              : {},
          );
        if (url.pathname.endsWith("createtorrent"))
          return json({ hash, torrent_id: 7 });
        if (url.pathname.endsWith("mylist"))
          return json([
            {
              id: 7,
              hash,
              download_finished: true,
              download_present: true,
              // The account lists the files in another order than the cache does.
              files: files.map((f, id) => ({ ...f, id: id + 10 })).reverse(),
            },
          ]);
        if (url.pathname.endsWith("requestdl")) {
          requested.push(url.searchParams.get("file_id")!);
          return json("https://cdn.example/signed-file?ticket=synthetic");
        }
        throw Error("Unexpected endpoint");
      },
      logger: { log() {}, warn() {} },
      buildSearchText: (q) => q.title,
      async saveCredential() {
        throw Error("Unexpected credential write");
      },
      fail: (kind, message) => Object.assign(new Error(message), { kind }),
    };
    const releases = await plugin.search(
      query,
      cfg,
      host,
      new AbortController().signal,
    );
    assert.equal(releases.length, 1);
    assert.equal(releases[0].format, "epub");
    const result = await plugin.resolveFile!(
      releases[0],
      cfg,
      host,
      new AbortController().signal,
    );
    assert.equal(result.fileName, "Dune.epub");
    assert.deepEqual(requested, [String(names.indexOf(wanted) + 10)]);
    assert.equal(result.sizeBytes, 9000 - names.indexOf(wanted));
  });
