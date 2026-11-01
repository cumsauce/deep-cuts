import { AppleMusic, v3 } from "@ciderapp/pluginkit";
import { normalizeArtist, normalizeTitle } from "./engine/history.ts";
import type { CatalogSong } from "./engine/discover.ts";
import { lastFmCache } from "./store.ts";

const POLL_MS = 2000;
// Matches the storefront PluginKit's playItemById always uses.
const STOREFRONT = "us";
const LIBRARY_PAGE_GAP_MS = 1000;

const REQUEST_TIMEOUT_MS = 10_000;

/** Cider's helper can hang without rejecting, so every call gets a deadline. */
function request(path: string, params: any = {}, opts?: any): Promise<any> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`No response in ${REQUEST_TIMEOUT_MS / 1000}s from ${path.split("?")[0]}`)),
      REQUEST_TIMEOUT_MS,
    );
  });
  return Promise.race([v3<any>(path, params, opts), timeout]).finally(() => clearTimeout(timer));
}

async function pagedLibrary(path: string, maxPages: number): Promise<any[]> {
  const out: any[] = [];
  for (let page = 0; page < maxPages; page++) {
    if (page) await new Promise((r) => setTimeout(r, LIBRARY_PAGE_GAP_MS));
    const res = await request(path, { limit: 100, offset: page * 100 });
    const data = res?.data?.data ?? [];
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

export interface AppleHistory {
  songs: { artist: string; title: string; isrc?: string; plays: number }[];
  artists: string[];
}

export async function readLibraryAndRecent(): Promise<AppleHistory> {
  const [library, recent] = await Promise.all([
    pagedLibrary("/v1/me/library/songs", 200),
    request("/v1/me/recent/played/tracks", { limit: 30 })
      .then((r) => r?.data?.data ?? [])
      .catch(() => []),
  ]);
  const songs = [...library, ...recent]
    .filter((s: any) => s.attributes?.artistName && s.attributes?.name)
    .map((s: any) => ({
      artist: s.attributes.artistName as string,
      title: s.attributes.name as string,
      isrc: s.attributes.isrc as string | undefined,
      plays: (s.attributes.playCount as number | undefined) ?? 1,
    }));
  return { songs, artists: [...new Set(songs.map((s) => s.artist))] };
}

export const searchStats = { searches: 0, withResults: 0 };

const SEARCH_GAP_MS = 3500;
const BACKOFF_START_MS = 20_000;
const BACKOFF_MAX_MS = 120_000;
const SEARCH_CACHE_DAYS = 30;

let nextSearchAt = 0;
let backoffMs = BACKOFF_START_MS;

/** Set by the page to show when searching is paused for Apple's rate limit. */
export const searchNotice = { onChange: (_message: string) => {} };

/** Paces searches so Apple doesn't answer 429, and backs off when it does anyway. */
export async function findSong(artist: string, title: string): Promise<CatalogSong | null> {
  const cacheKey = `apple-search:${artist.toLowerCase()}|${title.toLowerCase()}`;
  const hit = await lastFmCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_DAYS * 86_400_000) {
    return hit.value as CatalogSong | null;
  }

  const wait = nextSearchAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nextSearchAt = Date.now() + SEARCH_GAP_MS;
  try {
    const song = await searchCatalog(artist, title);
    backoffMs = BACKOFF_START_MS;
    await lastFmCache.set(cacheKey, { at: Date.now(), value: song });
    return song;
  } catch (e) {
    nextSearchAt = Date.now() + backoffMs;
    searchNotice.onChange(`Apple Music is limiting requests. Waiting ${backoffMs / 1000}s`);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    throw e;
  }
}

async function searchCatalog(artist: string, title: string): Promise<CatalogSong | null> {
  // The public iTunes service has its own limit, separate from the one Cider's API helper hits.
  const query = new URLSearchParams({
    term: `${artist} ${title}`,
    entity: "song",
    limit: "10",
    country: STOREFRONT,
  });
  const res = await fetch(`https://itunes.apple.com/search?${query}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Apple search returned HTTP ${res.status}`);
  const results = ((await res.json()).results ?? []).filter((s: any) => s.isStreamable !== false);
  searchStats.searches++;
  if (results.length) searchStats.withResults++;
  const wantArtist = normalizeArtist(artist);
  const wantTitle = normalizeTitle(title);
  // Artist credits may add guests, but must include the artist to prevent same-name mix-ups.
  const hit = results.find((s: any) => {
    const gotArtist = normalizeArtist(s.artistName);
    const gotTitle = normalizeTitle(s.trackName);
    return (
      (gotArtist === wantArtist || gotArtist.startsWith(`${wantArtist} `)) &&
      (gotTitle === wantTitle || gotTitle.startsWith(`${wantTitle} `))
    );
  });
  if (!hit) return null;
  return {
    id: String(hit.trackId),
    title: hit.trackName,
    artist: hit.artistName,
    album: hit.collectionName,
    year: Number(String(hit.releaseDate ?? "").slice(0, 4)) || 0,
    artworkUrl: hit.artworkUrl100 ?? "",
  };
}

// Cider 4 has no queue API for plugins, so the picks are stepped through here.
let queue: string[] = [];
let queueIndex = -1;

function playCurrent() {
  return AppleMusic.playItemById({ type: "songs", id: queue[queueIndex] });
}

export async function playSongs(ids: string[], startAt = 0): Promise<void> {
  queue = ids;
  queueIndex = startAt;
  await playCurrent();
}

/** Marks the song as loved on Apple Music and adds it to the library. */
export async function favoriteSong(id: string): Promise<void> {
  await request(`/v1/me/ratings/songs/${id}`, undefined, {
    fetchOptions: {
      method: "PUT",
      body: JSON.stringify({ type: "rating", attributes: { value: 1 } }),
    },
  });
  await request("/v1/me/library", { "ids[songs]": id }, {
    fetchOptions: { method: "POST" },
  });
}

export interface NowPlaying {
  id: string;
  artist: string;
  title: string;
  isrc?: string;
}

function readNowPlaying(): NowPlaying | null {
  const item = AppleMusic.nowPlayingItem as any;
  const attrs = item?.attributes ?? item;
  const id = item?.id ?? attrs?.playParams?.id;
  if (!id || !attrs?.artistName || !attrs?.name) return null;
  return { id: String(id), artist: attrs.artistName, title: attrs.name, isrc: attrs.isrc };
}

function audioEnded(): boolean {
  return Boolean((globalThis as any).__PLUGINSYS__?.Stores?.appleMusicStore?.audioElement?.ended);
}

/**
 * Reports each track start, plus how long the previous track was listened to.
 * Polls because PluginKit documents no track-change event.
 */
export function watchPlayback(
  onTrack: (track: NowPlaying, previous: NowPlaying | null, listenedSeconds: number) => void,
): void {
  let previous: NowPlaying | null = null;
  let startedAt = Date.now();
  let wasEnded = false;
  setInterval(() => {
    const track = readNowPlaying();
    if (track && previous?.id !== track.id) {
      onTrack(track, previous, (Date.now() - startedAt) / 1000);
      previous = track;
      startedAt = Date.now();
    }
    const ended = audioEnded();
    if (ended && !wasEnded && track?.id === queue[queueIndex] && queueIndex + 1 < queue.length) {
      queueIndex++;
      playCurrent();
    }
    wasEnded = ended;
  }, POLL_MS);
}
