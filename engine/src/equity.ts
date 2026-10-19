// 운명의 실: 두 사람만 리버까지 맞붙는다고 가정한 현재 승률.
// 남은 보드 카드를 모두 나열해 정확히 계산한다 (조합이 너무 많으면 고정 시드로 표본 추출).
// 각자의 족보 변형·연금술·기생·승격, 족보 역전, 봉인, 예약 카드, 더블 보드, 하이로우를 반영한다.

import { Card, fullDeck } from './cards.js';
import { invertedNow } from './core.js';
import { seededRng, shuffle } from './rng.js';
import { compareContenders } from './showdown.js';
import { contenderFor, handEvalFor } from './standing.js';
import type { GameState, PlayerState } from './types.js';

/** 정확히 나열할 최대 조합 수 (넘으면 표본 추출) */
const MAX_COMBOS = 20000;

function combos(n: number, k: number): number {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

/** pool 에서 k 장을 고르는 모든 조합 (또는 표본) 을 하나씩 넘긴다 */
function forEachDraw(pool: Card[], k: number, fn: (draw: Card[]) => void): number {
  if (k === 0) {
    fn([]);
    return 1;
  }
  if (combos(pool.length, k) > MAX_COMBOS) {
    const rng = seededRng(pool.length * 131 + k);
    for (let i = 0; i < MAX_COMBOS; i++) fn(shuffle([...pool], rng).slice(0, k));
    return MAX_COMBOS;
  }
  let count = 0;
  const pick: Card[] = [];
  const rec = (start: number) => {
    if (pick.length === k) {
      fn([...pick]);
      count++;
      return;
    }
    for (let i = start; i <= pool.length - (k - pick.length); i++) {
      pick.push(pool[i]);
      rec(i + 1);
      pick.pop();
    }
  };
  rec(0);
  return count;
}

/** a 의 승률 (0~1, 무승부는 절반) */
export function headsUpEquity(state: GameState, a: PlayerState, b: PlayerState): number {
  const boards = [state.board, ...(state.board2 ? [state.board2] : [])];
  const inverted = invertedNow(state);
  const modes = state.effects.highLow ? [inverted, !inverted] : [inverted];
  const reserved = new Map(state.reservedPublic.map((r) => [r.index, r.card]));
  let total = 0;
  for (const board of boards) {
    const known = new Set<Card>([...a.hole, ...b.hole, ...board.slice(0, state.boardRevealed), ...reserved.values()]);
    // 앞으로 나올 칸: 예약 카드는 고정, 나머지는 모르는 카드
    const future = Array.from({ length: board.length - state.boardRevealed }, (_, i) => state.boardRevealed + i);
    const open = future.filter((i) => !reserved.has(i));
    const pool = fullDeck().filter((c) => !known.has(c));
    let score = 0;
    const n = forEachDraw(pool, open.length, (draw) => {
      const full = [...board];
      open.forEach((idx, k) => (full[idx] = draw[k]));
      for (const [idx, c] of reserved) if (idx < full.length) full[idx] = c;
      const cardsForEval = full.filter((_, i) => !state.effects.sealed.includes(i));
      const ca = contenderFor(state, a, handEvalFor(state, a, cardsForEval));
      const cb = contenderFor(state, b, handEvalFor(state, b, cardsForEval));
      for (const inv of modes) {
        const r = compareContenders(ca, cb, { inverted: inv, board: cardsForEval }).result;
        score += (r > 0 ? 1 : r === 0 ? 0.5 : 0) / modes.length;
      }
    });
    total += score / n;
  }
  return total / boards.length;
}
