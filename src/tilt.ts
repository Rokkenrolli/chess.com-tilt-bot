import type { GameHistory, GameResult } from './chessApi.ts';

/** How fast older games stop mattering by position in the window, newest game first. */
export const DECAY = 0.85;

/** Wall-clock decay: a game this many hours before the anchor counts half as much. */
const TIME_HALF_LIFE_HOURS = 24;
/** However long ago it was, a game inside the window never stops counting entirely. */
const MIN_TIME_WEIGHT = 0.25;
const HOUR_SECONDS = 3600;

const ENGLUND_BONUS = 10;

/** Points a record of nothing but early concessions can add on top of the base score. */
const CONCESSION_WEIGHT = 20;
/** What a concession is worth before the earliness escalation, so a long fight still counts. */
const CONCESSION_BASE = 0.3;
/** Moves; giving up this many moves in is already worth only ~1/e of an instant resignation. */
const EARLINESS_SCALE = 15;
/** Giving up a game you opened with the Englund Gambit yourself is peak tilt. */
const ENGLUND_CONCESSION_MULTIPLIER = 1.5;

const LOSS_VALUE: Record<GameResult, number> = { win: 0, draw: 0.5, loss: 1 };

export type Tilt = {
  tiltScore: number;
  tiltInRadians: number;
  /** One flag per game in the window, newest first. Only the first one earns the bonus. */
  englundBonus: boolean[];
};

export type TiltDistributionEntry = {
  gameId: number;
  endTime: number;
  tiltScore: number;
  tiltInRadians: number;
  usedEnglundGambit: boolean;
};

/**
 * How much each game in the window counts: its position in the window times how long before the
 * anchor game it was actually played, so an evening of blitz outweighs games from last week.
 * Both are measured from the newest game in the window, never from the current time, so a pinned
 * historical window keeps scoring the way it did on the day.
 */
export function gameWeights(gameHistory: GameHistory[]): number[] {
  const anchor = gameHistory[0];
  if (!anchor) return [];

  return gameHistory.map((game, index) => {
    const ageHours = Math.max(0, anchor.endTime - game.endTime) / HOUR_SECONDS;
    const timeWeight = Math.max(MIN_TIME_WEIGHT, 0.5 ** (ageHours / TIME_HALF_LIFE_HOURS));
    return DECAY ** index * timeWeight;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Weighted mean of a per-game value, normalised so a 0…1 value stays in 0…1. */
function weightedAverage(gameHistory: GameHistory[], value: (game: GameHistory) => number): number {
  const weights = gameWeights(gameHistory);
  let weighted = 0;
  let total = 0;
  gameHistory.forEach((game, index) => {
    weighted += weights[index]! * value(game);
    total += weights[index]!;
  });
  return total === 0 ? 0 : weighted / total;
}

/** How far the player fell short of their own best game in the window. */
function accuracyDrop(gameHistory: GameHistory[]): number {
  const accuracies = gameHistory
    .map((game) => game.accuracy)
    .filter((accuracy): accuracy is number => accuracy !== undefined);

  // A single analysed game gives no baseline to fall short of.
  if (accuracies.length < 2) return 0;

  const best = Math.max(...accuracies);
  const mean = accuracies.reduce((sum, accuracy) => sum + accuracy, 0) / accuracies.length;
  return best === 0 ? 0 : clamp((best - mean) / best, 0, 1);
}

/**
 * Giving a game up is worse than losing it, and the earlier it happened the worse it reads — the
 * escalation decays exponentially in the number of moves played. Doing it in a game the player
 * opened with the Englund Gambit multiplies the damage.
 */
function concessionSeverity(game: GameHistory): number {
  if (!game.conceded) return 0;

  // Without movetext there is no telling how early it was, so only the base counts.
  const earliness = game.moves === undefined ? 0 : Math.exp(-game.moves / EARLINESS_SCALE);
  const severity = CONCESSION_BASE + (1 - CONCESSION_BASE) * earliness;
  return game.playedEnglundGambit ? severity * ENGLUND_CONCESSION_MULTIPLIER : severity;
}

/** Extra points for the games the player handed over, weighted like the loss rate. */
export function concessionPenalty(gameHistory: GameHistory[]): number {
  return CONCESSION_WEIGHT * weightedAverage(gameHistory, concessionSeverity);
}

function trailingLossRatio(gameHistory: GameHistory[]): number {
  let losses = 0;
  while (gameHistory[losses]?.result === 'loss') losses += 1;
  return losses / gameHistory.length;
}

export function calculateTilt(gameHistory: GameHistory[]): Tilt {
  const englundBonus = gameHistory.map((game) => game.playedEnglundGambit);
  if (gameHistory.length === 0) return { tiltScore: 0, tiltInRadians: 0, englundBonus };

  const raw =
    0.5 * weightedAverage(gameHistory, (game) => LOSS_VALUE[game.result]) +
    0.3 * accuracyDrop(gameHistory) +
    0.2 * trailingLossRatio(gameHistory);

  const total =
    100 * raw + (englundBonus[0] ? ENGLUND_BONUS : 0) + concessionPenalty(gameHistory);
  const tiltScore = Math.round(clamp(total, 0, 100) * 100) / 100;
  return { tiltScore, tiltInRadians: (tiltScore / 100) * (Math.PI / 2), englundBonus };
}

/**
 * The same score computed over a window that slides one game back at a time, newest first, so a
 * caller can see whether the tilt is climbing or cooling. Expects roughly `2 * nHistory` games.
 */
export function calculateTiltDistribution(gameHistory: GameHistory[], nHistory: number): TiltDistributionEntry[] {
  const distribution: TiltDistributionEntry[] = [];

  for (let start = 0; start < nHistory; start += 1) {
    const window = gameHistory.slice(start, start + nHistory);
    const anchor = window[0];
    // A one-game window says nothing about a trend.
    if (!anchor || window.length < 2) break;

    const { tiltScore, tiltInRadians, englundBonus } = calculateTilt(window);
    distribution.push({
      gameId: anchor.id,
      endTime: anchor.endTime,
      tiltScore,
      tiltInRadians,
      usedEnglundGambit: englundBonus[0] ?? false,
    });
  }

  return distribution;
}
