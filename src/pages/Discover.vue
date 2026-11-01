<script setup lang="ts">
import { onMounted, ref, shallowRef } from "vue";
import { discover } from "../engine/discover.ts";
import type { Pick } from "../engine/discover.ts";
import { importPlayActivity, normalizeArtist, songKey } from "../engine/history.ts";
import { LastFm } from "../engine/lastfm.ts";
import { DEFAULT_LEVERS, learnFromReaction } from "../engine/score.ts";
import type { Levers } from "../engine/score.ts";
import { favoriteSong, findSong, playSongs, readLibraryAndRecent, searchNotice, searchStats, watchPlayback } from "../apple.ts";
import { lastFmCache, load, save } from "../store.ts";
import type { Saved } from "../store.ts";

const SKIP_SECONDS = 30;

const saved = shallowRef<Saved | null>(null);
const apiKey = ref("");
const levers = ref<Levers>({ ...DEFAULT_LEVERS });
const focusTags = ref("");
const avoidTags = ref("");
const focusArtists = ref("");
const picks = ref<Pick[]>([]);
const favorited = ref(new Set<string>());
const status = ref("");
const error = ref("");
const busy = ref(false);
const heardCount = ref(0);
const artistCount = ref(0);

const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

function refreshCounts() {
  if (!saved.value) return;
  heardCount.value = saved.value.taste.heardSongs.size;
  artistCount.value = Object.keys(saved.value.taste.artistPlays).length;
}

async function persist() {
  if (!saved.value) return;
  saved.value.apiKey = apiKey.value.trim();
  saved.value.levers = {
    ...levers.value,
    focusTags: splitList(focusTags.value),
    avoidTags: splitList(avoidTags.value),
    focusArtists: splitList(focusArtists.value),
  };
  await save(saved.value);
  refreshCounts();
}

function markHeard(artist: string, title: string, isrc?: string) {
  const taste = saved.value!.taste;
  taste.heardSongs.add(songKey(artist, title));
  if (isrc) taste.heardIsrcs.add(isrc);
}

async function guarded(task: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  try {
    await task();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
    status.value = "";
  }
}

const syncLibrary = () =>
  guarded(async () => {
    status.value = "Reading your Apple Music library";
    const { songs } = await readLibraryAndRecent();
    const taste = saved.value!.taste;
    const seen = new Set<string>();
    const totals: Record<string, number> = {};
    for (const s of songs) {
      markHeard(s.artist, s.title, s.isrc);
      const key = normalizeArtist(s.artist);
      taste.artistNames[key] = s.artist;
      const id = `${key}|${s.title}`;
      if (seen.has(id)) continue;
      seen.add(id);
      totals[key] = (totals[key] ?? 0) + s.plays;
    }
    // Keeps the higher count so re-syncing never inflates plays.
    for (const [key, plays] of Object.entries(totals)) {
      taste.artistPlays[key] = Math.max(taste.artistPlays[key] ?? 0, plays);
    }
    await persist();
  });

const importCsv = (event: Event) =>
  guarded(async () => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    status.value = "Importing play history";
    const result = importPlayActivity(await file.text());
    const taste = saved.value!.taste;
    result.songKeys.forEach((k) => taste.heardSongs.add(k));
    for (const [artist, plays] of Object.entries(result.artistPlays)) {
      taste.artistPlays[artist] = Math.max(taste.artistPlays[artist] ?? 0, plays);
      taste.artistNames[artist] ??= artist;
    }
    await persist();
  });

const findMusic = () =>
  guarded(async () => {
    if (!apiKey.value.trim()) throw new Error("Add a Last.fm API key first.");
    await persist();
    const graph = new LastFm(apiKey.value.trim(), lastFmCache);
    picks.value = [];
    searchNotice.onChange = (m) => {
      status.value = m;
    };
    searchStats.searches = 0;
    searchStats.withResults = 0;
    await discover(
      graph,
      findSong,
      saved.value!.taste,
      saved.value!.levers,
      (m) => {
        status.value = m;
      },
      (pick) => {
        picks.value.push(pick);
        saved.value!.artistTags[pick.artistKey] = pick.tags;
      },
    );
    await persist();
    if (!picks.value.length) {
      error.value =
        `Nothing matched. Apple Music searches: ${searchStats.searches}, ` +
        `with results: ${searchStats.withResults}. Try loosening the levers.`;
    }
  });

const play = (index: number) =>
  guarded(() => playSongs(picks.value.map((p) => p.id), index));

const favorite = (pick: Pick) =>
  guarded(async () => {
    await favoriteSong(pick.id);
    const taste = saved.value!.taste;
    taste.artistFavorites[pick.artistKey] = (taste.artistFavorites[pick.artistKey] ?? 0) + 1;
    taste.artistNames[pick.artistKey] = pick.artist;
    learnFromReaction(taste.tagWeights, pick.tags, "favorite");
    favorited.value = new Set(favorited.value).add(pick.id);
    await persist();
  });

async function reject(pick: Pick) {
  const taste = saved.value!.taste;
  taste.blockedArtists.push(pick.artistKey);
  learnFromReaction(taste.tagWeights, pick.tags, "reject");
  markHeard(pick.artist, pick.title, pick.isrc);
  picks.value = picks.value.filter((p) => p.artistKey !== pick.artistKey);
  await persist();
}

onMounted(async () => {
  saved.value = await load();
  apiKey.value = saved.value.apiKey;
  levers.value = saved.value.levers;
  focusTags.value = saved.value.levers.focusTags.join(", ");
  avoidTags.value = saved.value.levers.avoidTags.join(", ");
  focusArtists.value = saved.value.levers.focusArtists.join(", ");
  refreshCounts();

  // Records everything Cider plays, including music started outside this page.
  watchPlayback((track, previous, listened) => {
    const s = saved.value!;
    markHeard(track.artist, track.title, track.isrc);
    if (previous && listened < SKIP_SECONDS) {
      const tags = s.artistTags[normalizeArtist(previous.artist)];
      if (tags) learnFromReaction(s.taste.tagWeights, tags, "skip");
    }
    persist();
  });
});
</script>

<template>
  <div class="q-pa-lg plugin-base dc">
    <h1 class="apple-heading">Deep Cuts</h1>
    <p class="dc-muted">{{ heardCount }} songs heard · {{ artistCount }} artists known</p>

    <section class="dc-row">
      <label>Last.fm API key <input v-model="apiKey" type="password" @change="persist" /></label>
      <button class="c-btn" :disabled="busy" @click="syncLibrary">Sync library</button>
      <label class="c-btn">Import play history CSV
        <input type="file" accept=".csv" hidden @change="importCsv" />
      </label>
    </section>

    <section class="dc-levers">
      <label>Adventurousness: {{ levers.adventurousness }} steps
        <input v-model.number="levers.adventurousness" type="range" min="1" max="3" />
      </label>
      <label>Obscurity: {{ Math.round(levers.obscurity * 100) }}%
        <input v-model.number="levers.obscurity" type="range" min="0" max="1" step="0.05" />
      </label>
      <label>Listener limit (0 for none)
        <input v-model.number="levers.maxListeners" type="number" min="0" step="10000" />
      </label>
      <label>Tracks per artist
        <input v-model.number="levers.tracksPerArtist" type="number" min="1" max="5" />
      </label>
      <label>Max per tag
        <input v-model.number="levers.maxPerTag" type="number" min="1" />
      </label>
      <label>Batch size
        <input v-model.number="levers.batchSize" type="number" min="5" max="100" />
      </label>
      <label>From year (0 for any)
        <input v-model.number="levers.yearFrom" type="number" min="0" />
      </label>
      <label>To year (0 for any)
        <input v-model.number="levers.yearTo" type="number" min="0" />
      </label>
      <label class="dc-wide">More like these artists (replaces your overall taste)
        <input v-model="focusArtists" placeholder="Cocteau Twins, Slowdive" />
      </label>
      <label class="dc-wide">Only these tags
        <input v-model="focusTags" placeholder="dream pop, shoegaze" />
      </label>
      <label class="dc-wide">Avoid these tags
        <input v-model="avoidTags" placeholder="christmas, comedy" />
      </label>
    </section>

    <button class="c-btn dc-go" :disabled="busy" @click="findMusic">Find new music</button>
    <p v-if="status" class="dc-muted">{{ status }}…</p>
    <p v-if="error" class="dc-error">{{ error }}</p>

    <ol class="dc-list">
      <li v-for="(pick, i) in picks" :key="pick.id">
        <img :src="pick.artworkUrl" alt="" width="60" height="60" />
        <div class="dc-meta">
          <strong>{{ pick.title }}</strong>
          <span>{{ pick.artist }} · {{ pick.album }} · {{ pick.year }}</span>
          <span class="dc-muted">
            {{ pick.listeners.toLocaleString() }} listeners · {{ pick.why }} · {{ pick.tags.slice(0, 3).join(", ") }}
          </span>
        </div>
        <button class="c-btn" @click="play(i)">Play</button>
        <button class="c-btn" :disabled="favorited.has(pick.id)" @click="favorite(pick)">
          {{ favorited.has(pick.id) ? "Favorited" : "Favorite" }}
        </button>
        <button class="c-btn" @click="reject(pick)">Not this</button>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.dc-muted { opacity: 0.65; }
.dc-error { color: #e5534b; }
.dc-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 20px; }
.dc-levers { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; margin-bottom: 20px; }
.dc-levers label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.dc-wide { grid-column: span 2; }
.dc-go { margin-bottom: 12px; }
.dc-list { list-style: none; padding: 0; }
.dc-list li { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-top: 1px solid rgba(128, 128, 128, 0.25); }
.dc-list img { border-radius: 4px; }
.dc-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: 13px; }
</style>
