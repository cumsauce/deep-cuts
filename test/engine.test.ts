import assert from "node:assert/strict";
import { test } from "node:test";
import { discover } from "../src/engine/discover.ts";
import type { ArtistGraph, FindSong, TasteState } from "../src/engine/discover.ts";
import { importPlayActivity, songKey } from "../src/engine/history.ts";
import { DEFAULT_LEVERS, learnFromReaction, obscurityOf, rankCandidates } from "../src/engine/score.ts";

const taste = (over: Partial<TasteState> = {}): TasteState => ({
  artistPlays: { known: 100 },
  artistNames: { known: "Known" },
  artistFavorites: {},
  blockedArtists: [],
  heardSongs: new Set(),
  heardIsrcs: new Set(),
  tagWeights: {},
  ...over,
});

const listeners: Record<string, number> = { Niche: 5_000, Huge: 5_000_000, Far: 2_000 };
const graph: ArtistGraph = {
  similar: async (a) =>
    ({
      Known: [{ name: "Known", match: 1 }, { name: "Niche", match: 0.6 }, { name: "Huge", match: 0.9 }],
      Niche: [{ name: "Far", match: 0.8 }],
    })[a] ?? [],
  info: async (a) => ({ name: a, listeners: listeners[a] ?? 1, tags: [a === "Huge" ? "pop" : "dream pop"] }),
  topTracks: async () => ["One", "Two"],
};
const find: FindSong = async (artist, title) => ({
  id: `${artist}-${title}`, title, artist, album: "A", year: 2010, artworkUrl: "", isrc: `${artist}${title}`,
});

test("never recommends known artists or heard songs", async () => {
  const picks = await discover(graph, find, taste({ heardSongs: new Set([songKey("Niche", "One")]) }), {
    ...DEFAULT_LEVERS,
    adventurousness: 1,
    maxListeners: 0,
  });
  assert.ok(!picks.some((p) => p.artist === "Known"));
  assert.equal(picks.find((p) => p.artist === "Niche")?.title, "Two");
});

test("heard ISRC is excluded even when the title differs", async () => {
  const picks = await discover(graph, find, taste({ heardIsrcs: new Set(["NicheOne", "NicheTwo"]) }), {
    ...DEFAULT_LEVERS,
    adventurousness: 1,
    maxListeners: 0,
  });
  assert.ok(!picks.some((p) => p.artist === "Niche"));
});

test("listener cap removes popular artists", async () => {
  const picks = await discover(graph, find, taste(), { ...DEFAULT_LEVERS, adventurousness: 1, maxListeners: 10_000 });
  assert.deepEqual(picks.map((p) => p.artist), ["Niche"]);
});

test("more adventurousness reaches further artists", async () => {
  const picks = await discover(graph, find, taste(), { ...DEFAULT_LEVERS, adventurousness: 2 });
  assert.ok(picks.some((p) => p.artist === "Far"));
});

test("obscurity lever reorders results", () => {
  const list = [
    { key: "huge", name: "Huge", affinity: 1, listeners: 5_000_000, tags: [] },
    { key: "niche", name: "Niche", affinity: 0.6, listeners: 5_000, tags: [] },
  ];
  const rank = (obscurity: number) =>
    rankCandidates(list, { ...DEFAULT_LEVERS, maxListeners: 0, obscurity }, {}, new Set())[0].key;
  assert.equal(rank(0), "huge");
  assert.equal(rank(1), "niche");
  assert.ok(obscurityOf(100) > obscurityOf(1_000_000));
});

test("tag filters and learned weights apply", () => {
  const list = [
    { key: "a", name: "A", affinity: 1, listeners: 1000, tags: ["metal"] },
    { key: "b", name: "B", affinity: 1, listeners: 1000, tags: ["folk"] },
  ];
  const opts = { ...DEFAULT_LEVERS };
  assert.deepEqual(rankCandidates(list, { ...opts, avoidTags: ["Metal"] }, {}, new Set()).map((c) => c.key), ["b"]);
  const weights = {};
  learnFromReaction(weights, ["folk"], "favorite");
  assert.equal(rankCandidates(list, opts, weights, new Set())[0].key, "b");
  assert.deepEqual(rankCandidates(list, opts, {}, new Set(["a"])).map((c) => c.key), ["b"]);
});

test("search failures are reported and don't lose earlier picks", async () => {
  const levers = { ...DEFAULT_LEVERS, adventurousness: 1, maxListeners: 0, tracksPerArtist: 1 };
  const broken: FindSong = async () => {
    throw new Error("403");
  };
  const manyTracks = { ...graph, topTracks: async () => ["1", "2", "3", "4"] };
  const twoArtists = { ...manyTracks, similar: async (a: string) => (a === "Known" ? [{ name: "Niche", match: 1 }, { name: "Huge", match: 0.5 }, { name: "Far", match: 0.4 }] : []) };
  await assert.rejects(discover(twoArtists, broken, taste(), levers), /keeps failing: 403/);

  let calls = 0;
  const failsAfterFirst: FindSong = async (artist, title) => {
    if (++calls === 1) return find(artist, title);
    throw new Error("429");
  };
  const seen: string[] = [];
  const picks = await discover(twoArtists, failsAfterFirst, taste(), levers, undefined, (p) => seen.push(p.artist));
  assert.equal(picks.length, 1);
  assert.deepEqual(seen, [picks[0].artist]);
});

test("remasters and live versions count as the same song", () => {
  assert.equal(songKey("The Band", "Song (2011 Remaster)"), songKey("Band", "Song"));
  assert.equal(songKey("Band", "Song - Live"), songKey("band", "SONG"));
  assert.notEqual(songKey("Band", "Song"), songKey("Band", "Other"));
});

test("imports both CSV header styles, including quoted commas", () => {
  const a = importPlayActivity('Song Name,Artist Name\n"Hello, World",Foo\nBar,Foo\n');
  assert.equal(a.artistPlays.foo, 2);
  assert.ok(a.songKeys.includes(songKey("Foo", "Hello, World")));
  const b = importPlayActivity("Track Description,Date\nFoo - Baz,2020\n");
  assert.ok(b.songKeys.includes(songKey("Foo", "Baz")));
  assert.throws(() => importPlayActivity("X,Y\n1,2\n"), /No song column/);
});
