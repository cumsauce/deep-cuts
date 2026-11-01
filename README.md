# Deep Cuts

A [Cider](https://cider.sh) plugin that finds Apple Music songs you've never heard, based on what you have. It favors related artists over more from artists you already know, and can lean toward artists with fewer listeners.

> **Status: untested in Cider.** CI covers the build and the discovery engine's tests, but the plugin hasn't been run against Cider or a real Apple Music account yet. Expect rough edges.

## Install

You need Cider 2.5 or later, an Apple Music subscription, and a free [Last.fm API key](https://www.last.fm/api/account/create).

**macOS**

```bash
curl -L -o /tmp/deep-cuts.zip https://github.com/cumsauce/deep-cuts/releases/download/latest/deep-cuts.zip
```

```bash
mkdir -p ~/Library/"Application Support"/sh.cider.electron/plugins
```

```bash
unzip -o /tmp/deep-cuts.zip -d ~/Library/"Application Support"/sh.cider.electron/plugins
```

Then restart Cider and open **Deep Cuts** from the main menu. Run the same commands to update.

**Other systems:** unzip the same file into `%APPDATA%\C2Windows\plugins` on Windows or `~/.config/sh.cider.electron/plugins` on Linux.

## First run

1. Paste your Last.fm API key. It's stored only in Cider's local storage on that computer and sent only to Last.fm.
2. Click **Sync library**.
3. Optional but recommended: request your data from [privacy.apple.com](https://privacy.apple.com), then use **Import play history CSV** on `Apple Music Play Activity.csv`. Without it, the app can't know about songs you played but never saved.
4. Set the levers and click **Find new music**.

History, favorites, and settings stay on the computer where you use the plugin.

## Levers

| Lever | What it does |
|---|---|
| Adventurousness | How many steps to travel from artists you know (1-3) |
| Obscurity | Balances closest match against fewest listeners |
| Listener limit | Excludes artists above this listener count |
| More like these artists | Replaces your overall taste as the starting point |
| Only / avoid these tags | Requires or excludes Last.fm tags |
| Year range, tracks per artist, max per tag, batch size | Narrow or vary the results |

**Favorite** saves the song to Apple Music and boosts that artist and their tags. **Not this** blocks the artist. Skipping a recommended artist's song within 30 seconds counts as a mild negative.

## Limits

"Never heard" covers your library, recent plays, any imported history, and everything played in Cider. Plays elsewhere are missed until they reach your library or you import a newer export.

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm run build
```

Every push to `main` runs the tests and build, then replaces the `latest` release with a new `deep-cuts.zip`.
