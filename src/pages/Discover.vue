<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { Pick } from "../engine/discover.ts";
import { importPlayActivity, normalizeArtist } from "../engine/history.ts";
import { DEFAULT_LEVERS, learnFromReaction } from "../engine/score.ts";
import type { Levers } from "../engine/score.ts";
import { favoriteSong, playSongs, readLibraryAndRecent, removeFromQueue } from "../apple.ts";
import {
  artistCount,
  ensureLoaded,
  error,
  heardCount,
  markHeard,
  persist,
  picks,
  saved,
  searching,
  startDiscovery,
  status,
  stopDiscovery,
} from "../session.ts";

const apiKey = ref("");
const levers = ref<Levers>({ ...DEFAULT_LEVERS });
const focusTags = ref("");
const avoidTags = ref("");
const focusArtists = ref("");
const favorited = ref(new Set<string>());
const taskStatus = ref("");
const busy = ref(false);

const shownStatus = computed(() => taskStatus.value || status.value);
const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

async function saveSettings() {
  if (!saved.value) return;
  saved.value.apiKey = apiKey.value.trim();
  saved.value.levers = {
    ...levers.value,
    focusTags: splitList(focusTags.value),
    avoidTags: splitList(avoidTags.value),
    focusArtists: splitList(focusArtists.value),
  };
  await persist();
}

async function guarded(task: () => Promise<void>) {
  error.value = "";
  try {
    await task();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function withBusy(message: string, task: () => Promise<void>) {
  busy.value = true;
  taskStatus.value = message;
  await guarded(task);
  busy.value = false;
  taskStatus.value = "";
}

const syncLibrary = () =>
  withBusy("Reading your Apple Music library", async () => {
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
  withBusy("Importing play history", async () => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const result = importPlayActivity(await file.text());
    const taste = saved.value!.taste;
    result.songKeys.forEach((k) => taste.heardSongs.add(k));
    for (const [artist, plays] of Object.entries(result.artistPlays)) {
      taste.artistPlays[artist] = Math.max(taste.artistPlays[artist] ?? 0, plays);
      taste.artistNames[artist] ??= artist;
    }
    await persist();
  });

async function findMusic() {
  await saveSettings();
  startDiscovery();
}

const play = (index: number) => guarded(() => playSongs(picks.value.map((p) => p.id), index));

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
  picks.value
    .filter((p) => p.artistKey === pick.artistKey)
    .forEach((p) => removeFromQueue(p.id));
  picks.value = picks.value.filter((p) => p.artistKey !== pick.artistKey);
  await persist();
}

onMounted(async () => {
  await ensureLoaded();
  const s = saved.value!;
  apiKey.value = s.apiKey;
  levers.value = s.levers;
  focusTags.value = s.levers.focusTags.join(", ");
  avoidTags.value = s.levers.avoidTags.join(", ");
  focusArtists.value = s.levers.focusArtists.join(", ");
});
</script>

<template>
  <div class="q-pa-lg plugin-base dc">
    <h1 class="apple-heading">Deep Cuts</h1>
    <p class="dc-muted">{{ heardCount }} songs heard · {{ artistCount }} artists known</p>

    <section class="dc-row">
      <label>Last.fm API key <input v-model="apiKey" type="password" @change="saveSettings" /></label>
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

    <button v-if="!searching" class="c-btn dc-go" @click="findMusic">Find new music</button>
    <button v-else class="c-btn dc-go" @click="stopDiscovery">Stop finding</button>
    <p v-if="shownStatus" class="dc-muted">{{ shownStatus }}…</p>
    <p v-if="searching && picks.length" class="dc-muted">
      You can start listening now. New songs join the queue as they're found.
    </p>
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
