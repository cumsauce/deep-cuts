# AGENTS.md

Handoff notes for agents working on Deep Cuts. The README is the user-facing install guide; this file is everything else.

## What this is

A plugin for [Cider](https://cider.sh), a third-party Apple Music client. It recommends songs the user has **never heard**, favoring artists *related to* their taste over more from artists they already know, with a lean toward artists with fewer listeners. Favorites and skips feed back into future picks.

The user's priorities, in order:
1. Never play something already heard.
2. Related artists over same-artist or same-album picks.
3. Levers to steer results (obscurity, adventurousness, tags, focus artists, era).
4. Favorites saved to Apple Music and fed back into recommendations.
5. Start listening right away while discovery continues slowly in the background.

## Status

- **Tested:** the discovery engine (`src/engine/`) has unit tests, and CI builds the plugin.
- **Partly confirmed by the user:** the plugin loads in Cider 4.0.25 on macOS, Last.fm lookups work, and Apple Music searches ran but returned 429 rate-limit errors.
- **Never confirmed working:** `Sync library`, `Play`, auto-advance between picks, background top-ups, and `Favorite`. Treat these as suspect.
- **Nothing can be run locally by an agent:** Cider isn't installed where development happened. Every runtime change has to be pushed, installed by the user, and reported back. Ask the user for the exact on-page error or Cider developer-console output.

## Layout

| Path | Role |
|---|---|
| `src/main.ts` | Plugin entry. Registers the page element and the "Deep Cuts" main-menu entry, and loads the session at startup so plays are logged even before the page is opened. |
| `src/plugin.config.ts` | Manifest (identifier `local.deep-cuts`, `pluginKitVersion: "4"`). |
| `src/session.ts` | Module-level state that survives page navigation: saved data, the current picks, and background discovery with automatic top-ups. |
| `src/pages/Discover.vue` | UI: levers, sync and import, and the pick list with Play, Favorite, and "Not this". |
| `src/apple.ts` | Everything that touches Apple or Cider: library reads, song search, playback queue, favorites, and now-playing polling. |
| `src/store.ts` | IndexedDB persistence. The `lastfm` store is a generic response cache, and also caches Apple search results. |
| `src/engine/history.ts` | Name normalization, song keys, CSV parsing, and import of Apple's privacy-export play history. |
| `src/engine/score.ts` | Levers, ranking, obscurity scoring, and learning from reactions. |
| `src/engine/discover.ts` | Pipeline: seeds, related-artist expansion, ranking, then song lookup and filtering. Data sources are injected as interfaces. |
| `src/engine/lastfm.ts` | Last.fm client with throttling, 30-day caching, and timeouts. |
| `test/engine.test.ts` | Engine tests with fake data sources. |
| `.github/workflows/build.yml` | Tests, builds, zips, and replaces the `latest` release on each push to `main`. |

Keep `src/engine/` free of browser, Cider, and Vue dependencies so it stays testable with plain Node.

## Commands

```bash
npm install
```

```bash
npm test
```

```bash
npm run build
```

`npm test` uses Node's built-in TypeScript support, which needs Node 22.18 or later. CI uses Node 24. `npm run build` type-checks with `vue-tsc` (strict, with unused-variable errors) and then bundles with Vite 8.

If an agent's sandbox blocks `npm install` because it runs third-party code, rely on CI: push, then check with `gh run watch` and `gh run view --log-failed`.

## Release and install

Each push to `main` replaces the GitHub release tagged `latest` with `deep-cuts.zip`, which contains `local.deep-cuts/plugin.js` and `plugin.yml`. The user installs with:

```bash
curl -fL -o /tmp/deep-cuts.zip https://github.com/cumsauce/deep-cuts/releases/download/latest/deep-cuts.zip && unzip -o /tmp/deep-cuts.zip -d ~/Library/"Application Support"/sh.cider.genten/plugins
```

Then they must fully quit Cider with Cmd+Q and reopen it.

## Cider 4 facts learned the hard way

These contradict the plugin template's README and older Cider docs:

- **Plugin folder:** Cider 4 on macOS uses `~/Library/Application Support/sh.cider.genten/plugins`, not `sh.cider.electron`. Cider 4's Windows and Linux paths are unconfirmed.
- **No MusicKit:** `MusicKit` isn't a global in Cider 4, and PluginKit's `useMusicKit()` returns null. Use PluginKit's `AppleMusic` controller and its `v3()` request helper instead. The API reference is `docs/API Documentation.md` on the `cider-4` branch of `ciderapp/pluginkit`.
- **No queue API:** PluginKit only offers `AppleMusic.playItemById({ type, id })`, which hardcodes the `us` storefront. `apple.ts` keeps its own queue and advances by polling every 2 seconds for `__PLUGINSYS__.Stores.appleMusicStore.audioElement.ended`, which is undocumented. There's no documented track-change event either, so now-playing changes are polled too.
- **`v3()` hits Apple's main API, which rate-limits hard:** catalog search through it returned persistent 429s even when paced. Cider's helper also appears to retry internally, so calls can hang instead of failing. Every `v3` call is wrapped in a 10-second timeout.
- **Song search uses the public iTunes Search API** (`itunes.apple.com/search`): it allows cross-origin requests, needs no auth, and returns `trackId` values that are the same IDs Cider plays. It has no ISRCs, so new picks are de-duplicated by normalized artist and title only. It's also rate-limited, so `findSong` uses adaptive pacing: a 6-second base gap that widens on each failure up to 30 seconds and recovers gradually, exponential backoff, up to 4 attempts per song, and a 30-day cache. The user still reported limits about every other artist before this pacing shipped.
- **Still on `v3()` and likely to hit 429s:** library sync (`/v1/me/library/songs`, one page per second), recent plays, and favorites (a PUT to `/v1/me/ratings/songs/{id}` plus a POST to `/v1/me/library`). Whether `v3()` accepts the `fetchOptions` method and body is unverified.

## Discovery pipeline

1. **Seeds:** artists weighted by `log1p(plays) + 3 × favorites`, top 40. "More like these artists" replaces them.
2. **Expansion:** Last.fm `artist.getSimilar`, for 1 to 3 hops depending on adventurousness, with a 0.45 decay per hop. Each later hop expands only the top 25. Known artists are never candidates.
3. **Ranking:** Last.fm `artist.getInfo` supplies listener counts and tags for the top 150. The score blends normalized affinity with obscurity (`1 − log10(listeners)/7`) according to the obscurity lever, multiplied by `√affinity` so obscurity alone can't pull in unrelated artists. Learned tag weights adjust the result. Then the listener limit, tag filters, blocked artists, and the per-tag cap apply.
4. **Songs:** Last.fm `artist.getTopTracks` provides the first 4 titles, each searched on iTunes. A pick is dropped if heard (by song key or ISRC) or outside the year range.

Feedback: Favorite adds +1 to that artist's tags, "Not this" adds −1 and blocks the artist, and skipping within 30 seconds adds −0.15. Tag weights are clamped to ±5.

"Heard" comes from library sync, recent plays, the imported privacy-export CSV, and every track Cider plays while the plugin is loaded.

## Known gaps and ideas

- Confirm Play, auto-advance, top-ups, Favorite, and Sync in Cider before building more on them.
- If `v3()` stays rate-limited, library sync may need a different source, such as relying on the privacy-export CSV.
- Picks reset when Cider restarts. Only taste data, the heard set, settings, and caches persist.
- If the user's account isn't in the US store, playback may fail for some songs, because PluginKit hardcodes `us`.
- Ideas the user found appealing but that aren't built: audio-similarity from 30-second previews, and ListenBrainz as a second similarity source.

## Conventions

- Match the existing style: TypeScript, small focused modules, and short comments that explain *why*.
- Add engine tests for engine changes, and run `npm test` before pushing.
- Push to `main` only with the user's go-ahead. Each push publishes a new release, which is how the user receives fixes. Watch CI until it passes, and fix it if it fails.
- The development machine has no git identity. Commit with `git -c user.name=cumsauce -c user.email=cumsauce@users.noreply.github.com commit ...`, and don't change global git config.
- End commit messages with a `Co-Authored-By` line naming the agent that made the change.
- The repo has no license yet. Don't add one without asking.
