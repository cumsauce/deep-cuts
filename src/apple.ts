import { AppleMusic, v3 } from "@ciderapp/pluginkit";
import { normalizeArtist, normalizeTitle } from "./engine/history.ts";
import type { CatalogSong } from "./engine/discover.ts";

const POLL_MS = 2000;
const DEFAULT_STOREFRONT = "us";

const request = (path: string, params?: any, opts?: any): Promise<any> =>
  v3<any>(path, params, opts);

let storefront: Promise<string> | null = null;
function getStorefront(): Promise<string> {
  return (storefront ??= request("/v1/me/storefront")
    .then((r) => r?.data?.data?.[0]?.id ?? DEFAULT_STOREFRONT)
    .catch(() => DEFAULT_STOREFRONT));
}

async function pagedLibrary(path: string, maxPages: number): Promise<any[]> {
  const out: any[] = [];
  for (let page = 0; page < maxPages; page++) {
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

export async function findSong(artist: string, title: string): Promise<CatalogSong | null> {
  const res = await request(`/v1/catalog/${await getStorefront()}/search`, {
    term: `${artist} ${title}`,
    types: "songs",
    limit: 10,
  });
  const wantArtist = normalizeArtist(artist);
  const wantTitle = normalizeTitle(title);
  // Exact artist matching leaves some songs unfound, but prevents same-name mix-ups.
  const hit = (res?.data?.results?.songs?.data ?? []).find(
    (s: any) =>
      normalizeArtist(s.attributes.artistName) === wantArtist &&
      normalizeTitle(s.attributes.name) === wantTitle,
  );
  if (!hit) return null;
  const a = hit.attributes;
  return {
    id: hit.id,
    title: a.name,
    artist: a.artistName,
    album: a.albumName,
    year: Number(String(a.releaseDate ?? "").slice(0, 4)) || 0,
    artworkUrl: (a.artwork?.url ?? "").replace("{w}", "120").replace("{h}", "120"),
    isrc: a.isrc,
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
