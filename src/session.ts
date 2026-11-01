import { ref, shallowRef } from "vue";
import { appendToQueue, findSong, queueRemaining, searchNotice, searchStats, watchPlayback } from "./apple.ts";
import { discover } from "./engine/discover.ts";
import type { Pick } from "./engine/discover.ts";
import { normalizeArtist, songKey } from "./engine/history.ts";
import { LastFm } from "./engine/lastfm.ts";
import { learnFromReaction } from "./engine/score.ts";
import { lastFmCache, load, save } from "./store.ts";
import type { Saved } from "./store.ts";

const SKIP_SECONDS = 30;
const TOP_UP_BELOW = 3;

// Lives outside the page so discovery keeps running after navigating away.
export const saved = shallowRef<Saved | null>(null);
export const picks = ref<Pick[]>([]);
export const status = ref("");
export const error = ref("");
export const searching = ref(false);
export const heardCount = ref(0);
export const artistCount = ref(0);

class Stopped extends Error {}
let stopRequested = false;

export async function persist() {
  if (!saved.value) return;
  await save(saved.value);
  heardCount.value = saved.value.taste.heardSongs.size;
  artistCount.value = Object.keys(saved.value.taste.artistPlays).length;
}

export function markHeard(artist: string, title: string, isrc?: string) {
  const taste = saved.value!.taste;
  taste.heardSongs.add(songKey(artist, title));
  if (isrc) taste.heardIsrcs.add(isrc);
}

export function stopDiscovery() {
  stopRequested = true;
  status.value = "Stopping after the current search";
}

/** Runs in the background. New picks join the list and the playing queue as they're found. */
export async function startDiscovery(append = false) {
  const s = saved.value;
  if (!s || searching.value) return;
  if (!s.apiKey) {
    error.value = "Add a Last.fm API key first.";
    return;
  }
  searching.value = true;
  stopRequested = false;
  error.value = "";
  if (!append) picks.value = [];
  searchStats.searches = 0;
  searchStats.withResults = 0;
  searchNotice.onChange = (m) => {
    status.value = m;
  };
  // Songs and artists already listed aren't heard yet, but shouldn't be picked again.
  const taste = {
    ...s.taste,
    heardSongs: new Set([...s.taste.heardSongs, ...picks.value.map((p) => songKey(p.artist, p.title))]),
    blockedArtists: [...s.taste.blockedArtists, ...picks.value.map((p) => p.artistKey)],
  };
  const check = () => {
    if (stopRequested) throw new Stopped();
  };
  try {
    await discover(
      new LastFm(s.apiKey, lastFmCache),
      findSong,
      taste,
      s.levers,
      (m) => {
        check();
        status.value = m;
      },
      (pick) => {
        picks.value.push(pick);
        s.artistTags[pick.artistKey] = pick.tags;
        appendToQueue(pick.id);
        check();
      },
    );
    if (!picks.value.length) {
      error.value =
        `Nothing matched. Apple Music searches: ${searchStats.searches}, ` +
        `with results: ${searchStats.withResults}. Try loosening the levers.`;
    }
  } catch (e) {
    if (!(e instanceof Stopped)) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    searching.value = false;
    status.value = "";
    await persist();
  }
}

let loading: Promise<void> | null = null;

/** Safe to call repeatedly. Also starts logging everything Cider plays. */
export function ensureLoaded(): Promise<void> {
  return (loading ??= load().then((loaded) => {
    saved.value = loaded;
    heardCount.value = loaded.taste.heardSongs.size;
    artistCount.value = Object.keys(loaded.taste.artistPlays).length;
    watchPlayback((track, previous, listened) => {
      markHeard(track.artist, track.title, track.isrc);
      if (previous && listened < SKIP_SECONDS) {
        const tags = loaded.artistTags[normalizeArtist(previous.artist)];
        if (tags) learnFromReaction(loaded.taste.tagWeights, tags, "skip");
      }
      persist();
      const left = queueRemaining();
      if (left !== null && left < TOP_UP_BELOW && !error.value) startDiscovery(true);
    });
  }));
}
