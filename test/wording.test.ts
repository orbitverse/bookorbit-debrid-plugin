import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/index.js";
import type {
  PluginHost,
  PluginIndexerConfig,
} from "../vendor/bookorbit-plugin-api.js";

const config = (provider: string, settings: Record<string, unknown>) =>
  ({
    id: 1,
    name: "Books",
    baseUrl: "http://indexer.example",
    credential: JSON.stringify({
      indexerKey: "SYNTHETIC_INDEXER",
      debrid: { provider, key: "SYNTHETIC_PROVIDER" },
    }),
    allowPrivateAddress: false,
    categories: { ebook: [7020], audiobook: [3030] },
    settings,
  }) as PluginIndexerConfig;
const host: PluginHost = {
  async fetch(input) {
    const url = new URL(input);
    if (url.pathname === "/api/v1/indexer")
      return Response.json([
        {
          id: 1,
          enable: true,
          supportsSearch: true,
          protocol: "torrent",
          privacy: "public",
          capabilities: { categories: [{ id: 7020 }] },
        },
      ]);
    if (url.pathname === "/1/api")
      return new Response("<rss><channel><title>Books</title></channel></rss>");
    if (url.hostname === "api.real-debrid.com")
      return Response.json({ id: 1, type: "premium", premium: 1000 });
    if (url.hostname === "debrid-link.com")
      return Response.json({
        success: true,
        value: { accountType: 1, premiumLeft: 1000 },
      });
    return Response.json({ success: true, data: {} });
  },
  logger: { log() {}, warn() {} },
  buildSearchText: (q) => q.title,
  async saveCredential() {
    throw Error("Unexpected credential write");
  },
  fail: (kind, message) => Object.assign(Error(message), { kind }),
};

test("Test connection names each provider once, without doubling a word", async () => {
  for (const [provider, name] of [
    ["torbox", "TorBox"],
    ["realdebrid", "Real-Debrid"],
    ["debridlink", "Debrid-Link"],
  ]) {
    const discovered = await plugin.test(config(provider, {}), host);
    assert("indexerName" in discovered, JSON.stringify(discovered));
    assert.equal(
      discovered.indexerName,
      `BookOrbit Debrid: Prowlarr indexer configuration and ${name} account access verified`,
    );
    const configured = await plugin.test(
      config(provider, { indexerPaths: "/1/api" }),
      host,
    );
    assert("indexerName" in configured, JSON.stringify(configured));
    assert.equal(
      configured.indexerName,
      `BookOrbit Debrid: indexer search and ${name} access verified`,
    );
  }
});

test("Test connection mentions a cached release only when it found one", async () => {
  const hash = "a".repeat(40);
  const result = await plugin.test(
    config("torbox", { indexerPaths: "/1/api" }),
    {
      ...host,
      async fetch(input, init) {
        const url = new URL(input);
        if (url.pathname === "/1/api")
          return new Response(
            `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Books</title><item><title>Pride and Prejudice</title><torznab:attr name="infohash" value="${hash}"/></item></channel></rss>`,
          );
        if (url.pathname.endsWith("/checkcached"))
          return Response.json({
            success: true,
            data: {
              [hash]: {
                hash,
                name: "Pride and Prejudice",
                files: [{ name: "Pride and Prejudice.epub", size: 100 }],
              },
            },
          });
        return host.fetch(input, init);
      },
    },
  );
  assert("indexerName" in result, JSON.stringify(result));
  assert.equal(
    result.indexerName,
    "BookOrbit Debrid: indexer search and TorBox access verified; a matching cached release was found",
  );
});

test("an invalid Show uncached downloads value is reported under the setting's label", async () => {
  const label = plugin.settingsFields.find(
    (field) => field.key === "prepareUncached",
  )!.label;
  assert.equal(label, "Show uncached downloads");
  const result = await plugin.test(
    config("torbox", { prepareUncached: "yes" }),
    host,
  );
  assert.equal(result.success, false);
  assert("error" in result);
  assert.equal(result.error, `${label} must be enabled or disabled.`);
});
