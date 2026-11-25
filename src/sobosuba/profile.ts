import type { ArenaTheme } from './arena';

export const achievements = [
  { id: 'first', title: '第一滴', goal: '完成第一次计分合成', theme: 'mint' },
  { id: '128', title: '合成入门', goal: '单局合成出 128', theme: 'orange' },
  { id: '1024', title: '苏打达人', goal: '单局合成出 1024', theme: 'ocean' },
  { id: '100', title: '持续融合', goal: '累计完成 100 次计分合成', theme: 'nebula' },
  { id: '8192', title: '高阶突破', goal: '单局合成出 8192', theme: 'prism' },
] as const;

export const themes = {
  soda: {
    name: '柠檬黄', board: '#151307', grid: '#51472a', accent: '#f7df3b', danger: '#ff8056',
    colors: [
      '#f9e34a', '#ffae39', '#fff1a0', '#cfe158', '#ff8451', '#e4cd9a', '#73e6bf', '#87c8ff',
      '#e594e5', '#bf9dff', '#f7819f', '#72c98b', '#6ce1ed', '#d58a43', '#92a6eb', '#e6f0fd',
    ],
  },
  mint: {
    name: '薄荷汽水', board: '#081e20', grid: '#2b4b4c', accent: '#74eed1', danger: '#ff8c85',
    colors: [
      '#74eed1', '#9deb81', '#65c5fa', '#facc80', '#fc8bb3', '#e5fba9', '#aaa0ff', '#ff9c83',
      '#72c8a1', '#e895e8', '#80e5ff', '#ffed9e', '#d0a67e', '#a9f4d6', '#e8b1f9', '#c0caed',
    ],
  },
  orange: {
    name: '落日橙糖', board: '#231610', grid: '#503627', accent: '#ffb367', danger: '#ff837e',
    colors: [
      '#ffb367', '#f97d85', '#f6dd79', '#8fe5b0', '#8bbafa', '#ff9aca', '#f4c85d', '#dd9cf4',
      '#eb8c58', '#89dbc4', '#b1a7fb', '#fff1c5', '#cbd66b', '#83d4ed', '#d8a27d', '#f1a8d6',
    ],
  },
  ocean: {
    name: '深海霓虹', board: '#0b1424', grid: '#293e60', accent: '#8cc7ff', danger: '#ff9381',
    colors: [
      '#8cc7ff', '#66efd8', '#abd9ff', '#f0ef87', '#f8a577', '#f785b4', '#b8a4ff', '#84d18b',
      '#ffd078', '#e39bf2', '#76b7e8', '#9cf9c2', '#ffc8a5', '#74d9ee', '#d8e4f7', '#dbad83',
    ],
  },
  nebula: {
    name: '星云果冻', board: '#211322', grid: '#51334a', accent: '#ffa0c8', danger: '#ffc078',
    colors: [
      '#ffa0c8', '#82e8ed', '#f6b17d', '#a5cdfc', '#f1f68b', '#f984a7', '#b5a4ff', '#efc490',
      '#83d29b', '#8eb8ef', '#ffc781', '#ec9de7', '#b1fbdf', '#caad84', '#76cfef', '#f4dbe7',
    ],
  },
  prism: {
    name: '晶体汽水', board: '#171c13', grid: '#374631', accent: '#e9ed95', danger: '#ff967e',
    colors: [
      '#e9ed95', '#92ebbd', '#8adfff', '#ffc182', '#ff9fa3', '#ffa9e4', '#8ecb80', '#f0dd6e',
      '#b6a2f5', '#71dccd', '#f59474', '#8fabf3', '#e9b5f5', '#cbab88', '#a9edfd', '#ecf3cf',
    ],
  },
} satisfies Record<string, ArenaTheme & { name: string }>;

export type ThemeId = keyof typeof themes;
export type AchievementId = typeof achievements[number]['id'];

export interface RoundRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  score: string;
  highestLevel: number;
  merges: number;
  shots: number;
  reason: 'blocked' | 'aborted';
}

export interface Profile {
  version: 1;
  best: string;
  totalMerges: number;
  achievements: AchievementId[];
  theme: ThemeId;
  sound: boolean;
  reducedMotion: boolean | null;
  guideSeen: boolean;
  rounds: RoundRecord[];
}

const KEY = 'sobosuba.profile.v1';
const isDecimal = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isRound = (value: unknown): value is RoundRecord =>
  isRecord(value) && typeof value.id === 'string' &&
  isCount(value.startedAt) && isCount(value.endedAt) && value.endedAt >= value.startedAt && value.endedAt <= 8.64e15 &&
  isDecimal(value.score) && isCount(value.highestLevel) && value.highestLevel <= 65_535 &&
  isCount(value.merges) && isCount(value.shots) &&
  (value.reason === 'blocked' || value.reason === 'aborted');

export function unlocked(profile: Profile, theme: ThemeId): boolean {
  return theme === 'soda' || achievements.some(item => item.theme === theme && profile.achievements.includes(item.id));
}

export function readProfile(): { profile: Profile; storageOk: boolean } {
  const profile: Profile = {
    version: 1, best: '0', totalMerges: 0, achievements: [], theme: 'soda',
    sound: true, reducedMotion: null, guideSeen: false, rounds: [],
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return { profile, storageOk: true };
    let data: unknown;
    try { data = JSON.parse(raw); } catch { data = null; }
    if (!isRecord(data) || data.version !== 1) return { profile, storageOk: true };
    if (isDecimal(data.best)) profile.best = data.best;
    if (isCount(data.totalMerges)) profile.totalMerges = data.totalMerges;
    if (Array.isArray(data.achievements)) {
      const stored: unknown[] = data.achievements;
      profile.achievements = achievements.map(item => item.id).filter(id => stored.includes(id));
    }
    if (typeof data.theme === 'string' && Object.hasOwn(themes, data.theme) && unlocked(profile, data.theme as ThemeId)) {
      profile.theme = data.theme as ThemeId;
    }
    if (typeof data.sound === 'boolean') profile.sound = data.sound;
    if (typeof data.reducedMotion === 'boolean') profile.reducedMotion = data.reducedMotion;
    if (typeof data.guideSeen === 'boolean') profile.guideSeen = data.guideSeen;
    if (Array.isArray(data.rounds)) {
      const unique = new Map(data.rounds.filter(isRound).map(round => [round.id, round]));
      profile.rounds = [...unique.values()].sort((a, b) => b.endedAt - a.endedAt);
    }
    return { profile, storageOk: true };
  } catch {
    return { profile, storageOk: false };
  }
}

export function writeProfile(profile: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

export function compareScore(a: string, b: string) {
  if (a.length !== b.length) return a.length - b.length;
  return a === b ? 0 : a > b ? 1 : -1;
}

export function formatScore(score: string) {
  return score.length <= 10
    ? score.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : `${score[0]}.${score.slice(1, 3)}e+${score.length - 1}`;
}
