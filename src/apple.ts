import { normalizeArtist, normalizeTitle } from "./engine/history.ts";
import type { CatalogSong } from "./engine/discover.ts";

declare const MusicKit: any;

const mk = () => MusicKit.getInstance();

async function pagedLibrary(path: string, maxPages: number): Promise<any[]> {
  const out: any[] = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await mk().api.music(path, { limit: 100, offset: page * 100 });
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
    mk()
      .api.music("/v1/me/recent/played/tracks", { limit: 30 })
      .then((r: any) => r?.data?.data ?? [])
      .catch(() => []),
  ]);
  const songs = [...library, ...recent]
    .filter((s: any) => s.attributes?.artistName && s.attributes?.name)
    .map((s: any) => ({
      artist: s.attributes.artistName,
      title: s.attributes.name,
      isrc: s.attributes.isrc,
      plays: s.attributes.playCount ?? 1,
    }));
  return { songs, artists: [...new Set(songs.map((s) => s.artist))] };
}

export async function findSong(artist: string, title: string): Promise<CatalogSong | null> {
  const res = await mk().api.music("/v1/catalog/{{storefrontId}}/search", {
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

export async function playSongs(ids: string[], startAt = 0): Promise<void> {
  await mk().setQueue({ songs: ids, startWith: startAt, startPlaying: true });
}

/** Marks the song as loved on Apple Music and adds it to the library. */
export async function favoriteSong(id: string): Promise<void> {
  await mk().api.music(`/v1/me/ratings/songs/${id}`, undefined, {
    fetchOptions: {
      method: "PUT",
      body: JSON.stringify({ type: "rating", attributes: { value: 1 } }),
    },
  });
  await mk().api.music("/v1/me/library", { "ids[songs]": id }, {
    fetchOptions: { method: "POST" },
  });
}

export interface NowPlaying {
  id: string;
  artist: string;
  title: string;
  isrc?: string;
}

/** Reports each track start, plus how long the previous track was listened to. */
export function watchPlayback(
  onTrack: (track: NowPlaying, previous: NowPlaying | null, listenedSeconds: number) => void,
): void {
  let previous: NowPlaying | null = null;
  let startedAt = Date.now();
  mk().addEventListener("nowPlayingItemDidChange", () => {
    const item = mk().nowPlayingItem;
    if (!item?.attributes) return;
    const track: NowPlaying = {
      id: item.id,
      artist: item.attributes.artistName,
      title: item.attributes.name,
      isrc: item.attributes.isrc,
    };
    if (previous?.id === track.id) return;
    onTrack(track, previous, (Date.now() - startedAt) / 1000);
    previous = track;
    startedAt = Date.now();
  });
}
