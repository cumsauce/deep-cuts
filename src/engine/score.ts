export interface Levers {
  /** How many similarity steps to travel from known artists (1-3). */
  adventurousness: number;
  /** 0 favors closest match, 1 favors fewest listeners. */
  obscurity: number;
  /** Hard listener ceiling. 0 disables it. */
  maxListeners: number;
  focusTags: string[];
  avoidTags: string[];
  /** Artists that replace the general taste profile as starting points. */
  focusArtists: string[];
  yearFrom: number;
  yearTo: number;
  tracksPerArtist: number;
  /** Maximum picks sharing one primary tag. */
  maxPerTag: number;
  batchSize: number;
}

export const DEFAULT_LEVERS: Levers = {
  adventurousness: 2,
  obscurity: 0.5,
  maxListeners: 250_000,
  focusTags: [],
  avoidTags: [],
  focusArtists: [],
  yearFrom: 0,
  yearTo: 0,
  tracksPerArtist: 1,
  maxPerTag: 8,
  batchSize: 25,
};

export interface Candidate {
  key: string;
  name: string;
  /** Accumulated seed weight x similarity x distance decay. */
  affinity: number;
  listeners: number;
  tags: string[];
}

export type TagWeights = Record<string, number>;

const MAX_LISTENERS_LOG = 7; // ~10M listeners counts as fully mainstream

export function obscurityOf(listeners: number): number {
  const v = 1 - Math.log10(Math.max(listeners, 1)) / MAX_LISTENERS_LOG;
  return Math.min(1, Math.max(0, v));
}

export function seedWeight(plays: number, favorites: number): number {
  return Math.log1p(plays) + favorites * 3;
}

export function rankCandidates(
  candidates: Candidate[],
  levers: Levers,
  tagWeights: TagWeights,
  blocked: Set<string>,
): Candidate[] {
  const avoid = new Set(levers.avoidTags.map((t) => t.toLowerCase()));
  const focus = new Set(levers.focusTags.map((t) => t.toLowerCase()));
  const maxAffinity = Math.max(...candidates.map((c) => c.affinity), 1e-9);

  const scored = candidates
    .filter((c) => !blocked.has(c.key))
    .filter((c) => !levers.maxListeners || c.listeners <= levers.maxListeners)
    .filter((c) => !c.tags.some((t) => avoid.has(t)))
    .filter((c) => !focus.size || c.tags.some((t) => focus.has(t)))
    .map((c) => {
      const affinity = c.affinity / maxAffinity;
      const blend =
        (1 - levers.obscurity) * affinity + levers.obscurity * obscurityOf(c.listeners);
      const learned = c.tags.reduce((sum, t) => sum + (tagWeights[t] ?? 0), 0);
      // Keeps some similarity in play so obscurity alone can't pick unrelated artists.
      return { c, score: blend * Math.sqrt(affinity) * Math.max(0.1, 1 + 0.1 * learned) };
    })
    .sort((a, b) => b.score - a.score);

  const perTag: Record<string, number> = {};
  const out: Candidate[] = [];
  for (const { c } of scored) {
    const tag = c.tags[0];
    if (tag && (perTag[tag] ?? 0) >= levers.maxPerTag) continue;
    if (tag) perTag[tag] = (perTag[tag] ?? 0) + 1;
    out.push(c);
  }
  return out;
}

/** Applies a reaction to the artist's tags. Favorites teach more than skips. */
export function learnFromReaction(
  weights: TagWeights,
  tags: string[],
  reaction: "favorite" | "skip" | "reject",
): void {
  const delta = { favorite: 1, skip: -0.15, reject: -1 }[reaction];
  for (const t of tags) {
    weights[t] = Math.max(-5, Math.min(5, (weights[t] ?? 0) + delta));
  }
}
