import * as Effect from "effect/Effect";
import * as TorBox from "./torbox.js";
import * as EasyDebrid from "./easydebrid.js";
import * as RealDebrid from "./realdebrid.js";
import * as DebridLink from "./debridlink.js";
import type { Provider } from "./model.js";

const providers = {
  torbox: {
    label: "TorBox",
    supportsZip: true,
    cached: TorBox.cached,
    available: TorBox.available,
    prepare: TorBox.prepare,
    resolve: TorBox.resolve,
    verify: (key: string) => TorBox.cached([], key).pipe(Effect.asVoid),
  },
  easydebrid: {
    label: "EasyDebrid",
    supportsZip: false,
    cached: EasyDebrid.cached,
    available: null,
    prepare: null,
    resolve: EasyDebrid.resolve,
    verify: EasyDebrid.verify,
  },
  realdebrid: {
    label: "Real-Debrid account",
    supportsZip: false,
    cached: RealDebrid.cached,
    available: null,
    prepare: RealDebrid.prepare,
    resolve: RealDebrid.resolve,
    verify: RealDebrid.verify,
  },
  debridlink: {
    label: "Debrid-Link account",
    supportsZip: false,
    cached: DebridLink.cached,
    available: null,
    prepare: DebridLink.prepare,
    resolve: DebridLink.resolve,
    verify: DebridLink.verify,
  },
};

export const provider = (name: Provider) => providers[name];
