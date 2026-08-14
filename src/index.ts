import http from 'node:http';
import Joi from 'joi';
import { ChessApiError, fetchAvatar, fetchUserData, type GameHistory } from './chessApi.ts';
import {
  calculateTilt,
  calculateTiltDistribution,
  concessionPenalty,
  gameWeights,
  type Tilt,
  type TiltDistributionEntry,
} from './tilt.ts';

const PORT = Number(process.env.PORT ?? 3000);

const ROUTE = /^\/tilt-score(-of-opponent)?\/([^/]+)(\/report)?$/;

type Query = { fromGame?: number; nHistory: number };

const querySchema = Joi.object<Query>({
  fromGame: Joi.number().integer().positive(),
  nHistory: Joi.number().integer().min(1).max(50).default(5),
});

type Report = {
  subject: string;
  /** Set on the opponent routes: the player whose opponent we scored. */
  opponentOf?: string;
  avatar?: string;
  games: GameHistory[];
  tilt: Tilt;
  distribution: TiltDistributionEntry[];
};

/** A skew of pi/2 would flatten the avatar out of existence, so lean it as far as stays visible. */
const MAX_SKEW_RADIANS = 1.2;
const AVATAR_SIZE = 104;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatDate(endTime: number): string {
  return new Date(endTime * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function verdict(tiltScore: number): string {
  if (tiltScore < 25) return 'calm';
  if (tiltScore < 50) return 'skewed';
  if (tiltScore < 75) return 'tilted';
  return 'Frothing';
}

function meanAccuracy(games: GameHistory[]): string {
  const accuracies = games
    .map((game) => game.accuracy)
    .filter((accuracy): accuracy is number => accuracy !== undefined);
  if (accuracies.length === 0) return '—';
  return (accuracies.reduce((sum, accuracy) => sum + accuracy, 0) / accuracies.length).toFixed(1);
}

/** Inline SVG trend line over the sliding-window scores, oldest → newest, with Englund games marked. */
function renderChart(distribution: TiltDistributionEntry[]): string {
  const width = 640;
  const height = 180;
  const pad = 24;
  const points = [...distribution].reverse();
  if (points.length === 0) return '<p class="muted">Not enough games for a trend.</p>';

  const x = (index: number) =>
    points.length === 1 ? width / 2 : pad + (index / (points.length - 1)) * (width - 2 * pad);
  const y = (score: number) => pad + (1 - score / 100) * (height - 2 * pad);

  const line = points.map((point, index) => `${x(index).toFixed(1)},${y(point.tiltScore).toFixed(1)}`).join(' ');
  const markers = points
    .map((point, index) => {
      const title = `${formatDate(point.endTime)} — ${point.tiltScore}${point.usedEnglundGambit ? ' — Englund Gambit' : ''}`;
      return `<circle cx="${x(index).toFixed(1)}" cy="${y(point.tiltScore).toFixed(1)}" r="${point.usedEnglundGambit ? 7 : 4}" class="${point.usedEnglundGambit ? 'englund' : 'point'}"><title>${escapeHtml(title)}</title></circle>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Tilt trend">
    <line x1="${pad}" y1="${y(0)}" x2="${width - pad}" y2="${y(0)}" class="axis" />
    <line x1="${pad}" y1="${y(100)}" x2="${width - pad}" y2="${y(100)}" class="axis" />
    <polyline points="${line}" class="trend" />
    ${markers}
  </svg>
  <p class="muted">Oldest → newest. Ringed points are games played with the Englund Gambit.</p>`;
}

/**
 * The player's face, leaning over by exactly as much as they are tilted. A transform reserves no
 * layout space, so the frame pads by the overhang the lean actually produces — half the height
 * times tan(skew) on each side — instead of letting the corners run off the page.
 */
function renderAvatar(subject: string, avatar: string | undefined, tiltInRadians: number): string {
  const skew = Math.min(tiltInRadians, MAX_SKEW_RADIANS);
  const overhang = Math.round((AVATAR_SIZE / 2) * Math.tan(skew));
  const inner = avatar
    ? `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(subject)}" />`
    : escapeHtml(subject.slice(0, 1).toUpperCase());
  return `<div class="frame" style="padding: 0 ${overhang}px" title="skewed by ${tiltInRadians.toFixed(3)} rad">
      <div class="avatar" style="transform: skewX(-${skew.toFixed(3)}rad)">${inner}</div>
    </div>`;
}

function renderReport({ subject, opponentOf, avatar, games, tilt, distribution }: Report): string {
  const englundGames = tilt.englundBonus.filter(Boolean).length;
  const earlierEnglund = tilt.englundBonus[0] ? englundGames - 1 : englundGames;
  const wins = games.filter((game) => game.result === 'win').length;
  const draws = games.filter((game) => game.result === 'draw').length;
  const losses = games.filter((game) => game.result === 'loss').length;
  const conceded = games.filter((game) => game.conceded);
  const concession = concessionPenalty(games);
  const weights = gameWeights(games);

  const gameRows = games
    .map(
      (game, index) => `<tr>
        <td>${formatDate(game.endTime)}</td>
        <td><a href="${escapeHtml(game.url)}">${escapeHtml(game.opponent)}</a></td>
        <td>${game.color}</td>
        <td class="${game.result}">${game.result}${game.conceded ? ` <span class="tag">conceded${game.moves === undefined ? '' : ` m${game.moves}`}</span>` : ''}</td>
        <td><span class="opening" title="${escapeHtml(game.opening ?? '')}">${escapeHtml(game.opening ?? '—')}</span></td>
        <td>${game.playedEnglundGambit ? '<span class="tag">Englund</span>' : ''}</td>
        <td>${game.accuracy?.toFixed(1) ?? '—'}</td>
        <td>${weights[index]?.toFixed(2) ?? '—'}</td>
      </tr>`,
    )
    .join('');

  const windowRows = distribution
    .map(
      (entry) => `<tr>
        <td>${formatDate(entry.endTime)}</td>
        <td>${entry.gameId}</td>
        <td>${entry.tiltScore}</td>
        <td>${entry.tiltInRadians.toFixed(3)}</td>
        <td>${entry.usedEnglundGambit ? '<span class="tag">Englund</span>' : ''}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tilt report — ${escapeHtml(subject)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; margin: 0 auto; padding: 2rem 1.5rem; max-width: 46rem; line-height: 1.5; }
    h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
    .headline { display: flex; align-items: flex-end; gap: 1rem; flex-wrap: wrap; }
    .frame { flex: none; }
    .avatar { width: ${AVATAR_SIZE}px; height: ${AVATAR_SIZE}px; border-radius: .5rem; overflow: hidden; display: grid; place-items: center; font-size: 3rem; font-weight: 700; background: color-mix(in srgb, currentColor 12%, transparent); }
    .avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .score { font-size: 4rem; font-weight: 700; line-height: 1; }
    .score span { font-size: 1.5rem; font-weight: 400; opacity: .6; }
    .verdict { font-size: 1.1rem; text-transform: uppercase; letter-spacing: .1em; }
    .muted { opacity: .65; font-size: .85rem; }
    .badge { display: inline-block; margin: .75rem 0; padding: .4rem .7rem; border-radius: .4rem; background: #f5c14211; border: 1px solid #f5c142; }
    /* inline-block keeps a tag from being split in half across a line break */
    .tag { display: inline-block; white-space: nowrap; font-size: .7rem; padding: .1rem .35rem; border-radius: .3rem; border: 1px solid currentColor; }
    .scroll { overflow-x: auto; margin: .5rem 0 2rem; }
    table { width: 100%; border-collapse: collapse; font-size: .9rem; }
    th, td { text-align: left; padding: .35rem .4rem; border-bottom: 1px solid currentColor; border-color: color-mix(in srgb, currentColor 15%, transparent); white-space: nowrap; }
    /* opening names run long, so ellipsise them and keep the full text in the tooltip */
    .opening { display: block; max-width: 15rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .win { color: #2e7d32; } .loss { color: #c62828; } .draw { opacity: .7; }
    svg { width: 100%; height: auto; }
    .trend { fill: none; stroke: currentColor; stroke-width: 2; }
    .point { fill: currentColor; }
    .englund { fill: none; stroke: #f5c142; stroke-width: 3; }
    .axis { stroke: currentColor; opacity: .2; }
    a { color: inherit; }
  </style>
</head>
<body>
  <h1>${escapeHtml(subject)}${opponentOf ? ` <span class="muted">— opponent of ${escapeHtml(opponentOf)}</span>` : ''}</h1>
  <div class="headline">
    ${renderAvatar(subject, avatar, tilt.tiltInRadians)}
    <div>
      <div class="score">${tilt.tiltScore}<span>/100</span></div>
      <p class="verdict">${verdict(tilt.tiltScore)}</p>
    </div>
  </div>
  <p class="muted"> Tilt ${tilt.tiltInRadians.toFixed(3)} radians</p>
  ${
    tilt.englundBonus[0]
      ? `<p class="badge">Englund Gambit detected — +10${earlierEnglund > 0 ? ` <span class="muted">…and ${earlierEnglund} earlier game${earlierEnglund === 1 ? '' : 's'}</span>` : ''}</p>`
      : earlierEnglund > 0
        ? `<p class="badge muted">Englund Gambit in ${earlierEnglund} earlier game${earlierEnglund === 1 ? '' : 's'} — no bonus, the latest game was something else.</p>`
        : ''
  }

  <h2>Tilt trend</h2>
  ${renderChart(distribution)}
  <div class="scroll">
    <table>
      <thead><tr><th>Window ends</th><th>Game</th><th>Tilt</th><th>Radians</th><th></th></tr></thead>
      <tbody>${windowRows}</tbody>
    </table>
  </div>

  <h2>Games used</h2>
  <p class="muted">${games.length} games — ${wins}W / ${draws}D / ${losses}L, mean accuracy ${meanAccuracy(games)}${
    conceded.length > 0
      ? ` — conceded ${conceded.length} (${conceded.map((game) => (game.moves === undefined ? 'moves unknown' : `move ${game.moves}`)).join(', ')}) for +${concession.toFixed(1)}`
      : ''
  }</p>
  <div class="scroll">
    <table>
      <thead><tr><th>Ended (UTC)</th><th>Opponent</th><th>Colour</th><th>Result</th><th>Opening</th><th></th><th>Accuracy</th><th>Weight</th></tr></thead>
      <tbody>${gameRows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

function send(res: http.ServerResponse, status: number, contentType: string, body: string, cacheControl?: string): void {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (cacheControl) headers['cache-control'] = cacheControl;
  res.writeHead(status, headers);
  res.end(body);
}

function sendError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof ChessApiError) {
    send(res, error.status, 'application/json; charset=utf-8', JSON.stringify({ error: error.message }));
    return;
  }
  console.error(error);
  send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: 'internal error' }));
}

/**
 * Finished games never change, so a pinned window can be cached far longer than a floating one.
 * An opponent window is never pinned: it is anchored at the opponent's latest game, which drifts.
 */
function cacheControlFor(pinned: boolean): string {
  return `public, max-age=${pinned ? 86400 : 300}`;
}

async function handle(res: http.ServerResponse, username: string, opponent: boolean, report: boolean, query: Query) {
  let subject = username;
  if (opponent) {
    const [reference] = await fetchUserData(username, query.fromGame, 1);
    subject = reference!.opponent;
  }

  // The distribution slides a full window back over the history, hence twice the games.
  const games = await fetchUserData(subject, opponent ? undefined : query.fromGame, query.nHistory * 2);
  const tilt = calculateTilt(games.slice(0, query.nHistory));
  const distribution = calculateTiltDistribution(games, query.nHistory);
  const cacheControl = cacheControlFor(Boolean(query.fromGame) && !opponent);

  if (report) {
    const html = renderReport({
      subject,
      opponentOf: opponent ? username : undefined,
      // Decorative only: a missing profile picture must not fail the report.
      avatar: await fetchAvatar(subject).catch(() => undefined),
      games: games.slice(0, query.nHistory),
      tilt,
      distribution,
    });
    send(res, 200, 'text/html; charset=utf-8', html, cacheControl);
    return;
  }

  send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ...tilt, tiltDistribution: distribution }), cacheControl);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    send(res, 405, 'application/json; charset=utf-8', JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = ROUTE.exec(url.pathname);
  if (!route) {
    send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'not found' }));
    return;
  }

  const { value, error } = querySchema.validate(Object.fromEntries(url.searchParams), { convert: true });
  if (error) {
    send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: error.message }));
    return;
  }

  const [, opponent, username, report] = route;
  handle(res, decodeURIComponent(username!), Boolean(opponent), Boolean(report), value).catch((err) =>
    sendError(res, err),
  );
});

server.listen(PORT, '0.0.0.0', () => console.log(`chess tilt api listening on ${PORT}`));
