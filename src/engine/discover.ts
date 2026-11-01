import { normalizeArtist, songKey } from "./history.ts";
import { rankCandidates, seedWeight } from "./score.ts";
import type { Candidate, Levers, TagWeights } from "./score.ts";

export interface ArtistInfo {
  name: string;
  listeners: number;
  tags: string[];
}

export interface SimilarArtist {
  name: string;
  match: number;
}

/** Relationship data source. Last.fm in production. */
export interface ArtistGraph {
  similar(artist: string): Promise<SimilarArtist[]>;
  info(artist: string): Promise<ArtistInfo | null>;
  topTracks(artist: string): Promise<string[]>;
}

export interface CatalogSong {
  id: string;
  title: string;
  artist: string;
  album: string;
  year: number;
  artworkUrl: string;
  isrc?: string;
}

/** Finds a song on Apple Music. Must return null when the artist doesn't match. */
export type FindSong = (artist: string, title: string) => Promise<CatalogSong | null>;

export interface TasteState {
  artistPlays: Record<string, number>;
  /** Display names for normalized artist keys, used for Last.fm lookups. */
  artistNames: Record<string, string>;
  artistFavorites: Record<string, number>;
  blockedArtists: string[];
  heardSongs: Set<string>;
  heardIsrcs: Set<string>;
  tagWeights: TagWeights;
}

export interface Pick extends CatalogSong {
  artistKey: string;
  listeners: number;
  tags: string[];
  why: string;
}

const HOP_DECAY = 0.45;
const MAX_SEEDS = 40;
const SIMILAR_PER_ARTIST = 30;
const EXPAND_PER_HOP = 25;
const INFO_LOOKUPS = 150;
const TOP_TRACKS_SEARCHED = 4;
const MAX_SEARCH_FAILURES = 5;

function chooseSeeds(state: TasteState, levers: Levers) {
  if (levers.focusArtists.length) {
    return levers.focusArtists.map((name) => ({ name, weight: 10 }));
  }
  const keys = new Set([
    ...Object.keys(state.artistPlays),
    ...Object.keys(state.artistFavorites),
  ]);
  return [...keys]
    .map((k) => ({
      name: state.artistNames[k] ?? k,
      weight: seedWeight(state.artistPlays[k] ?? 0, state.artistFavorites[k] ?? 0),
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_SEEDS);
}

export async function discover(
  graph: ArtistGraph,
  findSong: FindSong,
  state: TasteState,
  levers: Levers,
  onProgress: (message: string) => void = () => {},
  onPick: (pick: Pick) => void = () => {},
): Promise<Pick[]> {
  const known = new Set([
    ...Object.keys(state.artistPlays),
    ...Object.keys(state.artistFavorites),
  ]);
  const found = new Map<string, { name: string; affinity: number; via: string }>();
  let frontier = chooseSeeds(state, levers).map((s) => ({ ...s, via: s.name }));
  if (!frontier.length) throw new Error("No listening history yet. Sync or import it first.");

  for (let hop = 1; hop <= levers.adventurousness; hop++) {
    onProgress(`Exploring related artists, step ${hop} of ${levers.adventurousness}`);
    const decay = HOP_DECAY ** (hop - 1);
    for (const seed of frontier) {
      for (const sim of await graph.similar(seed.name).then((s) => s.slice(0, SIMILAR_PER_ARTIST))) {
        const key = normalizeArtist(sim.name);
        if (!key || known.has(key)) continue;
        const gain = seed.weight * sim.match * decay;
        const prior = found.get(key);
        if (prior) prior.affinity += gain;
        else found.set(key, { name: sim.name, affinity: gain, via: seed.via });
      }
    }
    // Later hops start from this hop's strongest discoveries.
    frontier = [...found.values()]
      .sort((a, b) => b.affinity - a.affinity)
      .slice(0, EXPAND_PER_HOP)
      .map((a) => ({ name: a.name, weight: a.affinity, via: a.via }));
  }

  onProgress("Checking listener counts and tags");
  const candidates: Candidate[] = [];
  const shortlist = [...found.entries()]
    .sort((a, b) => b[1].affinity - a[1].affinity)
    .slice(0, INFO_LOOKUPS);
  for (const [key, entry] of shortlist) {
    const info = await graph.info(entry.name);
    if (!info) continue;
    candidates.push({
      key,
      name: info.name,
      affinity: entry.affinity,
      listeners: info.listeners,
      tags: info.tags,
    });
  }

  const ranked = rankCandidates(
    candidates,
    levers,
    state.tagWeights,
    new Set(state.blockedArtists),
  );

  const picks: Pick[] = [];
  let failures = 0;
  for (const [index, artist] of ranked.entries()) {
    if (picks.length >= levers.batchSize) break;
    onProgress(
      `Finding unheard songs on Apple Music: artist ${index + 1} of ${ranked.length}, ${picks.length} found`,
    );
    let taken = 0;
    for (const title of await graph.topTracks(artist.name).then((t) => t.slice(0, TOP_TRACKS_SEARCHED))) {
      if (taken >= levers.tracksPerArtist) break;
      if (state.heardSongs.has(songKey(artist.name, title))) continue;
      let song: CatalogSong | null;
      try {
        song = await findSong(artist.name, title);
        failures = 0;
      } catch (e) {
        if (++failures >= MAX_SEARCH_FAILURES) {
          const reason = e instanceof Error ? e.message : String(e);
          if (picks.length) return picks;
          throw new Error(`Apple Music search keeps failing: ${reason}`);
        }
        continue;
      }
      if (!song) continue;
      if (state.heardSongs.has(songKey(song.artist, song.title))) continue;
      if (song.isrc && state.heardIsrcs.has(song.isrc)) continue;
      if (levers.yearFrom && song.year < levers.yearFrom) continue;
      if (levers.yearTo && song.year > levers.yearTo) continue;
      const pick: Pick = {
        ...song,
        artistKey: artist.key,
        listeners: artist.listeners,
        tags: artist.tags,
        why: `Related to ${found.get(artist.key)?.via ?? "your listening"}`,
      };
      picks.push(pick);
      onPick(pick);
      taken++;
    }
  }
  return picks;
}
