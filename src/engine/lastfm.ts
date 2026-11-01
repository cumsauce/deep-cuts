import type { ArtistGraph, ArtistInfo, SimilarArtist } from "./discover.ts";

const API = "https://ws.audioscrobbler.com/2.0/";
const MIN_GAP_MS = 220;
const CACHE_DAYS = 30;
const REQUEST_TIMEOUT_MS = 15_000;
const IGNORED_TAGS = new Set(["seen live", "favorites", "favourite", "albums i own", "under 2000 listeners"]);

export interface Cache {
  get(key: string): Promise<{ at: number; value: unknown } | undefined>;
  set(key: string, value: { at: number; value: unknown }): Promise<void>;
}

export class LastFm implements ArtistGraph {
  private nextSlot = 0;
  private apiKey: string;
  private cache: Cache;

  constructor(apiKey: string, cache: Cache) {
    this.apiKey = apiKey;
    this.cache = cache;
  }

  private async call(method: string, artist: string, limit?: number): Promise<any> {
    const cacheKey = `${method}:${artist.toLowerCase()}`;
    const hit = await this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_DAYS * 86_400_000) return hit.value;

    const wait = this.nextSlot - Date.now();
    this.nextSlot = Math.max(this.nextSlot, Date.now()) + MIN_GAP_MS;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    const params = new URLSearchParams({
      method,
      artist,
      api_key: this.apiKey,
      format: "json",
      autocorrect: "1",
    });
    if (limit) params.set("limit", String(limit));
    const res = await fetch(`${API}?${params}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = await res.json();
    // Error 6 means Last.fm doesn't know this artist, which is a normal result.
    if (body.error && body.error !== 6) throw new Error(`Last.fm: ${body.message}`);
    const value = body.error ? null : body;
    await this.cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  async similar(artist: string): Promise<SimilarArtist[]> {
    const body = await this.call("artist.getSimilar", artist, 50);
    return (body?.similarartists?.artist ?? []).map((a: any) => ({
      name: a.name,
      match: Number(a.match) || 0,
    }));
  }

  async info(artist: string): Promise<ArtistInfo | null> {
    const body = await this.call("artist.getInfo", artist);
    if (!body?.artist) return null;
    return {
      name: body.artist.name,
      listeners: Number(body.artist.stats?.listeners) || 0,
      tags: (body.artist.tags?.tag ?? [])
        .map((t: any) => String(t.name).toLowerCase())
        .filter((t: string) => !IGNORED_TAGS.has(t)),
    };
  }

  async topTracks(artist: string): Promise<string[]> {
    const body = await this.call("artist.getTopTracks", artist, 20);
    return (body?.toptracks?.track ?? []).map((t: any) => t.name);
  }
}
