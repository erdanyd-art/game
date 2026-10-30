export type Night = {
  number: number;
  name: string;
  tagline: string;
  /** Tempo of the gamelan, and so of the flashing. */
  bpm: number;
  /** Distance from the start to the Firefly Tree, in world units. */
  length: number;
  /** Multiplier on the river's width; below 1 the banks close in. */
  width: number;
  clusters: number;
  frogs: number;
  /** How many bats can hunt at once. */
  bats: number;
  dawnSeconds: number;
  startSwarm: number;
  seed: number;
};

export const NIGHTS: readonly Night[] = [
  {
    number: 1,
    name: "Malam Pertama",
    tagline: "Belajar berkedip bersama.",
    bpm: 72,
    length: 3600,
    width: 1,
    clusters: 9,
    frogs: 2,
    bats: 0,
    dawnSeconds: 150,
    startSwarm: 12,
    seed: 1101,
  },
  {
    number: 2,
    name: "Muara Sunyi",
    tagline: "Katak-katak mulai lapar.",
    bpm: 78,
    length: 4400,
    width: 1,
    clusters: 11,
    frogs: 5,
    bats: 0,
    dawnSeconds: 130,
    startSwarm: 12,
    seed: 2203,
  },
  {
    number: 3,
    name: "Sayap Gelap",
    tagline: "Ada yang terbang tanpa cahaya.",
    bpm: 84,
    length: 5000,
    width: 0.95,
    clusters: 12,
    frogs: 5,
    bats: 2,
    dawnSeconds: 130,
    startSwarm: 14,
    seed: 3307,
  },
  {
    number: 4,
    name: "Hutan Akar",
    tagline: "Sungai menyempit, akar merapat.",
    bpm: 90,
    length: 5600,
    width: 0.85,
    clusters: 13,
    frogs: 8,
    bats: 3,
    dawnSeconds: 135,
    startSwarm: 14,
    seed: 4409,
  },
  {
    number: 5,
    name: "Pohon Kunang",
    tagline: "Malam terpanjang. Bawa semuanya pulang.",
    bpm: 96,
    length: 6400,
    width: 0.84,
    clusters: 15,
    frogs: 13,
    bats: 5,
    dawnSeconds: 140,
    startSwarm: 16,
    seed: 5501,
  },
];

/** Share of the night's fireflies that must reach the tree for 1, 2 and 3 stars. */
export const STAR_THRESHOLDS = [0.35, 0.6, 0.85] as const;

export function starsFor(delivered: number, total: number): number {
  if (total <= 0) return 0;
  const share = delivered / total;
  return STAR_THRESHOLDS.filter((threshold) => share >= threshold).length;
}
