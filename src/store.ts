import { DEFAULT_LEVERS } from "./engine/score.ts";
import type { Levers, TagWeights } from "./engine/score.ts";
import type { TasteState } from "./engine/discover.ts";
import type { Cache } from "./engine/lastfm.ts";

const DB = "deep-cuts";
const STORES = ["state", "lastfm"] as const;

let opening: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => STORES.forEach((s) => req.result.createObjectStore(s));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function get<T>(store: string, key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(store: string, key: string, value: unknown): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const lastFmCache: Cache = {
  get: (key) => get("lastfm", key),
  set: (key, value) => put("lastfm", key, value),
};

export interface Saved {
  apiKey: string;
  levers: Levers;
  taste: TasteState;
  /** Artist tags remembered so later reactions can teach the tag weights. */
  artistTags: Record<string, string[]>;
}

interface SavedRaw extends Omit<Saved, "taste"> {
  taste: Omit<TasteState, "heardSongs" | "heardIsrcs"> & {
    heardSongs: string[];
    heardIsrcs: string[];
    tagWeights: TagWeights;
  };
}

export async function load(): Promise<Saved> {
  const raw = await get<SavedRaw>("state", "main");
  return {
    apiKey: raw?.apiKey ?? "",
    levers: { ...DEFAULT_LEVERS, ...raw?.levers },
    artistTags: raw?.artistTags ?? {},
    taste: {
      artistPlays: raw?.taste.artistPlays ?? {},
      artistNames: raw?.taste.artistNames ?? {},
      artistFavorites: raw?.taste.artistFavorites ?? {},
      blockedArtists: raw?.taste.blockedArtists ?? [],
      tagWeights: raw?.taste.tagWeights ?? {},
      heardSongs: new Set(raw?.taste.heardSongs ?? []),
      heardIsrcs: new Set(raw?.taste.heardIsrcs ?? []),
    },
  };
}

export async function save(s: Saved): Promise<void> {
  // JSON round trip strips Vue proxies, which IndexedDB can't clone.
  const raw: SavedRaw = JSON.parse(
    JSON.stringify({
      ...s,
      taste: {
        ...s.taste,
        heardSongs: [...s.taste.heardSongs],
        heardIsrcs: [...s.taste.heardIsrcs],
      },
    }),
  );
  await put("state", "main", raw);
}
