// 테스트 도우미: 봇끼리 게임을 진행시키는 루프와 불변식 검사
import {
  createGame,
  applyAction,
  applyTimeouts,
  getPending,
  startNextHand,
  chooseBotAction,
  chooseBotOpportunistic,
  counterCandidates,
  getPlayerView,
  seededRng,
  type GameState,
  type CreateGameOptions,
  type GameAction,
  type Rng,
} from '../src/index.js';

export function makePlayers(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}`, isBot: true }));
}

/** 테이블 위 전체 칩. 핸드가 끝나 팟이 분배된 뒤에는 칩만 센다. */
export function totalChips(state: GameState): number {
  if (state.result) return state.players.reduce((s, p) => s + p.chips, 0);
  return state.players.reduce((s, p) => s + p.chips + p.contributed, 0) + state.deadMoney;
}

/** 은행에서 생기거나 사라진 칩을 반영한 기대 총액 */
export function expectedChips(state: GameState, initial: number): number {
  return initial + state.stats.bankChips - state.stats.bankTaxed;
}

function act(state: GameState, id: string, a: GameAction, strict: boolean): boolean {
  const r = applyAction(state, id, a);
  if (!r.ok && strict) throw new Error(`bot action rejected: ${id} ${JSON.stringify(a)} → ${r.error} (phase ${state.phase})`);
  return r.ok;
}

/** 봇 정책으로 한 걸음 진행. 진행할 수 없으면 false */
export function stepBots(state: GameState, rng: Rng, strict = true): boolean {
  const pending = getPending(state);
  if (pending.kind === 'none') return false;
  if (pending.kind === 'reaction') {
    for (const id of counterCandidates(state)) {
      const a = chooseBotAction(getPlayerView(state, id), rng);
      if (a) act(state, id, a, strict);
    }
    applyTimeouts(state);
    return true;
  }
  // 차례가 아니어도 쓰는 증강 (강제 집행, 거짓말 탐지기, 암전, 죽음과 세금)
  for (const p of state.players) {
    if (p.out || pending.playerIds.includes(p.id)) continue;
    const a = chooseBotOpportunistic(getPlayerView(state, p.id), rng);
    if (a && act(state, p.id, a, strict)) return true;
  }
  if (pending.kind === 'handEnd') {
    for (const id of pending.playerIds) {
      const a = chooseBotAction(getPlayerView(state, id), rng);
      if (a) act(state, id, a, strict);
    }
    const r = startNextHand(state);
    if (!r.ok) throw new Error(r.error);
    return true;
  }
  for (let guard = 0; guard < 20; guard++) {
    const id = pending.playerIds[0];
    const a = chooseBotAction(getPlayerView(state, id), rng);
    if (!a) throw new Error(`bot ${id} has no action in ${pending.kind}`);
    act(state, id, a, strict);
    if (getPending(state).seq !== pending.seq || a.type !== 'useAugment') return true;
  }
  throw new Error('bot loop');
}

export function playGame(n: number, seed: number, opts: CreateGameOptions = {}, hook?: (s: GameState) => void, maxSteps = 200000): GameState {
  const rng = seededRng(seed);
  const state = createGame(makePlayers(n), { rng, ...opts });
  const initial = totalChips(state);
  for (let i = 0; i < maxSteps; i++) {
    hook?.(state);
    if (state.phase === 'gameOver') return state;
    stepBots(state, rng);
    if (state.phase !== 'reaction') {
      const now = totalChips(state);
      if (now !== expectedChips(state, initial)) {
        throw new Error(`chip conservation broken at hand ${state.handNumber}: ${now} vs ${expectedChips(state, initial)}`);
      }
    }
  }
  throw new Error('game did not finish');
}
