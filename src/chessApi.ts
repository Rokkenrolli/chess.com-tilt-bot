import Joi from 'joi';

const API = 'https://api.chess.com/pub';
const USER_AGENT = process.env.CHESS_API_USER_AGENT ?? 'chess-tilt-bot/1.0';
const MINUTE = 60_000;

/** Results that chess.com reports for the drawing side; anything that is not a win or a draw is a loss. */
const DRAW_RESULTS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

/** Losses the player chose rather than suffered: they gave the game up instead of being beaten. */
const CONCEDED_RESULTS = new Set(['resigned', 'abandoned']);

const ECO_URL_HEADER = /\[ECOUrl "([^"]+)"\]/;

/** White's move tokens in the movetext ("12. Nf3"); black's "12..." never matches. */
const MOVE_NUMBER = /(\d+)\.\s/g;

export type GameResult = 'win' | 'loss' | 'draw';

/**
 * The only game shape the scoring code sees. Everything chess.com-specific (result codes,
 * `eco` opening URLs, ids hidden in `url`) is normalised away here.
 */
export type GameHistory = {
  id: number;
  url: string;
  endTime: number;
  color: 'white' | 'black';
  result: GameResult;
  /** The player gave the game up (resigned or abandoned) instead of being beaten. */
  conceded: boolean;
  /** Full moves played, undefined when the game carried no movetext. */
  moves?: number;
  accuracy?: number;
  opponent: string;
  opening?: string;
  playedEnglundGambit: boolean;
};

export class ChessApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type ChessPlayer = { username: string; result: string; rating?: number };

type ChessGame = {
  url: string;
  pgn?: string;
  eco?: string;
  end_time: number;
  accuracies?: { white?: number; black?: number };
  white: ChessPlayer;
  black: ChessPlayer;
};

const playerSchema = Joi.object<ChessPlayer>({
  username: Joi.string().required(),
  result: Joi.string().required(),
  rating: Joi.number(),
});

const gameSchema = Joi.object<ChessGame>({
  url: Joi.string().required(),
  pgn: Joi.string(),
  eco: Joi.string(),
  end_time: Joi.number().required(),
  accuracies: Joi.object({ white: Joi.number(), black: Joi.number() }),
  white: playerSchema.required(),
  black: playerSchema.required(),
});

const profileSchema = Joi.object<{ avatar?: string }>({ avatar: Joi.string() });

const archivesSchema = Joi.object<{ archives: string[] }>({
  archives: Joi.array().items(Joi.string()).required(),
});

const monthSchema = Joi.object<{ games: ChessGame[] }>({
  games: Joi.array().items(gameSchema).required(),
});

const cache = new Map<string, { value: unknown; expiresAt: number }>();

/** Reads through the cache and hands back a payload already validated against `schema`. */
async function fetchJson<T>(url: string, schema: Joi.ObjectSchema<T>, ttlMs: number): Promise<T> {
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) {
    const notFound = response.status === 404;
    throw new ChessApiError(notFound ? 'player not found' : 'chess.com unavailable', notFound ? 404 : 502);
  }

  const { value, error } = schema.validate(await response.json(), { stripUnknown: true });
  if (error) throw new ChessApiError(`unexpected chess.com payload: ${error.message}`, 502);

  cache.set(url, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/** Past months are immutable, the running month still grows. */
function archiveTtl(archiveUrl: string): number {
  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return archiveUrl.endsWith(currentMonth) ? 5 * MINUTE : 24 * 60 * MINUTE;
}

function playerUrl(userId: string): string {
  return `${API}/player/${encodeURIComponent(userId.toLowerCase())}`;
}

/** Profile picture for the report; players without one return undefined. */
export async function fetchAvatar(userId: string): Promise<string | undefined> {
  const profile = await fetchJson(playerUrl(userId), profileSchema, 24 * 60 * MINUTE);
  return profile.avatar;
}

function gameIdFromUrl(url: string): number {
  return Number.parseInt(url.split('/').pop() ?? '', 10);
}

function playerColor(game: ChessGame, userId: string): 'white' | 'black' | undefined {
  const target = userId.toLowerCase();
  if (game.white.username.toLowerCase() === target) return 'white';
  if (game.black.username.toLowerCase() === target) return 'black';
  return undefined;
}

/** chess.com classifies the opening for us: `eco` (or the PGN's ECOUrl) points at /openings/<slug>. */
function openingSlug(game: ChessGame): string | undefined {
  for (const candidate of [game.eco, game.pgn?.match(ECO_URL_HEADER)?.[1]]) {
    const slug = candidate?.split('/openings/')[1];
    if (slug) return slug;
  }
  return undefined;
}

/** Opening slugs trail off into move lists ("Kings-Pawn-Opening-1...e5"); keep just the name. */
function openingName(slug: string): string {
  const words = slug.split('-');
  const firstMove = words.findIndex((word) => /^\d/.test(word));
  return (firstMove === -1 ? words : words.slice(0, firstMove)).join(' ');
}

function classifyResult(result: string): GameResult {
  if (result === 'win') return 'win';
  return DRAW_RESULTS.has(result) ? 'draw' : 'loss';
}

/** How long the game lasted, read off the last full move number in the movetext. */
function moveCount(pgn: string | undefined): number | undefined {
  const lastMove = [...(pgn?.matchAll(MOVE_NUMBER) ?? [])].at(-1)?.[1];
  return lastMove ? Number.parseInt(lastMove, 10) : undefined;
}

function toGameHistory(game: ChessGame, id: number, color: 'white' | 'black'): GameHistory {
  const opponentColor = color === 'white' ? 'black' : 'white';
  const slug = openingSlug(game);
  return {
    id,
    url: game.url,
    endTime: game.end_time,
    color,
    result: classifyResult(game[color].result),
    conceded: CONCEDED_RESULTS.has(game[color].result),
    moves: moveCount(game.pgn),
    accuracy: game.accuracies?.[color],
    opponent: game[opponentColor].username,
    opening: slug ? openingName(slug) : undefined,
    playedEnglundGambit: color === 'black' && (slug?.toLowerCase().includes('englund-gambit') ?? false),
  };
}

/**
 * The player's games newest first, walking the monthly archives backwards. Lazy on purpose: a month
 * is only fetched once the caller has consumed everything newer than it.
 */
async function* walkGames(userId: string, archiveUrls: string[]): AsyncGenerator<GameHistory> {
  for (const archiveUrl of archiveUrls) {
    const { games } = await fetchJson(archiveUrl, monthSchema, archiveTtl(archiveUrl));

    for (const game of games.toReversed()) {
      const color = playerColor(game, userId);
      if (color) {
        yield toGameHistory(game, gameIdFromUrl(game.url), color);
      }
    }
  }
}

/**
 * The `nHistory` games ending at (and including) the anchor game, newest first. The anchor is
 * `fromGame`, or the player's latest ended game when omitted. Callers that need the sliding
 * window simply ask for a wider `nHistory` and slice.
 */
export async function fetchUserData(userId: string, fromGame?: number, nHistory = 5): Promise<GameHistory[]> {
  const { archives } = await fetchJson(`${playerUrl(userId)}/games/archives`, archivesSchema, 5 * MINUTE);
  const games = walkGames(userId, archives.toReversed());

  // Walk back until the anchor game turns up; with no fromGame the newest game is the anchor.
  let anchor: GameHistory | undefined;
  while (!anchor) {
    const next = await games.next();
    if (next.done) {
      const missing = fromGame === undefined ? 'no games found' : `game ${fromGame} not found`;
      throw new ChessApiError(`${missing} for ${userId}`, 404);
    }
    if (fromGame === undefined || next.value.id === fromGame) anchor = next.value;
  }

  // Then keep going from the anchor to fill the window. The walker resumes where the search stopped,
  // so the games newer than the anchor are never revisited.
  const history = [anchor];
  while (history.length < nHistory) {
    const next = await games.next();
    if (next.done) break;
    history.push(next.value);
  }

  return history;
}
