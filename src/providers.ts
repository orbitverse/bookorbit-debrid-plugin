import * as Effect from "effect/Effect";
import * as TorBox from "./torbox.js";
import * as EasyDebrid from "./easydebrid.js";
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
};

export const provider = (name: Provider) => providers[name];
