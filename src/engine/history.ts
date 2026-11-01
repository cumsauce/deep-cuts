/** Normalizes names so remasters, live tags and punctuation don't defeat matching. */
export function normalizeArtist(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^the\s+/, "")
    .replace(/\s*(&|\band\b)\s*/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const VERSION_TAG =
  /\s*[([-][^)\]]*\b(remaster(ed)?|live|mono|stereo|deluxe|version|edit|mix|bonus|anniversary|explicit|clean)\b[^)\]]*[)\]]?\s*$/i;

export function normalizeTitle(title: string): string {
  let t = title;
  while (VERSION_TAG.test(t)) t = t.replace(VERSION_TAG, "");
  return normalizeArtist(t);
}

export function songKey(artist: string, title: string): string {
  return `${normalizeArtist(artist)}|${normalizeTitle(title)}`;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export interface ImportedPlays {
  songKeys: string[];
  artistPlays: Record<string, number>;
  rows: number;
}

/**
 * Reads Apple's "Apple Music Play Activity.csv". Header names have varied
 * between exports, so columns are found by name rather than position.
 */
export function importPlayActivity(csv: string): ImportedPlays {
  const [header, ...rows] = parseCsv(csv.replace(/^﻿/, ""));
  if (!header) throw new Error("The file is empty.");
  const find = (...names: string[]) =>
    header.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const title = find("song name", "track name", "track description", "content name");
  const artist = find("artist name", "container artist name", "artist");
  if (title < 0) throw new Error("No song column found. Is this the Play Activity CSV?");

  const songKeys = new Set<string>();
  const artistPlays: Record<string, number> = {};
  for (const r of rows) {
    let songName = r[title]?.trim() ?? "";
    let artistName = artist >= 0 ? (r[artist]?.trim() ?? "") : "";
    // "Track Description" exports combine both as "Artist - Song".
    if (!artistName && songName.includes(" - ")) {
      const at = songName.indexOf(" - ");
      artistName = songName.slice(0, at);
      songName = songName.slice(at + 3);
    }
    if (!songName || !artistName) continue;
    songKeys.add(songKey(artistName, songName));
    const a = normalizeArtist(artistName);
    artistPlays[a] = (artistPlays[a] ?? 0) + 1;
  }
  return { songKeys: [...songKeys], artistPlays, rows: rows.length };
}
