// 엔진 공통 도우미: 게임 흐름(game.ts)과 증강 효과(effects.ts)가 함께 쓴다.

import { Card, cardToken, rankName } from './cards.js';
import { AUGMENTS, AugmentId } from './augments.js';
import type { EvalRules } from './evaluator.js';
import type { GameState, LogEntry, NoteKind, OwnedAugment, Phase, PlayerState } from './types.js';

export const BLIND_LEVELS: ReadonlyArray<readonly [number, number]> = [
  [10, 20],
  [20, 40],
  [40, 80],
  [75, 150],
  [150, 300],
  [300, 600],
  [500, 1000],
  [1000, 2000],
  [2000, 4000],
  [4000, 8000],
];

export function blindsAt(levelIndex: number): { sb: number; bb: number } {
  if (levelIndex < BLIND_LEVELS.length) {
    const [sb, bb] = BLIND_LEVELS[levelIndex];
    return { sb, bb };
  }
  const [sb, bb] = BLIND_LEVELS[BLIND_LEVELS.length - 1];
  const f = 2 ** (levelIndex - BLIND_LEVELS.length + 1);
  return { sb: sb * f, bb: bb * f };
}

export function currentBlinds(state: GameState) {
  return blindsAt(state.levelIndex);
}

export const live = (p: PlayerState) => p.inHand && !p.folded;
export const canAct = (p: PlayerState) => live(p) && !p.allIn;

export function findAug(p: PlayerState, id: AugmentId): OwnedAugment | undefined {
  return p.augments.find((a) => a.id === id);
}

export function idxOf(state: GameState, id: string): number {
  return state.players.findIndex((p) => p.id === id);
}

export function playerById(state: GameState, id: string | undefined | null): PlayerState | undefined {
  return id ? state.players.find((p) => p.id === id) : undefined;
}

/** from 다음 좌석부터 한 바퀴 돌며 조건을 만족하는 첫 인덱스 */
export function nextIdx(state: GameState, from: number, pred: (p: PlayerState) => boolean): number {
  const n = state.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (pred(state.players[i])) return i;
  }
  return -1;
}

/** 딜러 왼쪽부터의 좌석 순서 */
export function seatOrderFromDealer(state: GameState): number[] {
  const n = state.players.length;
  return Array.from({ length: n }, (_, k) => (state.dealerIdx + 1 + k) % n);
}

export function addLog(state: GameState, text: string, opts: { to?: string[]; except?: string[] } = {}): void {
  const entry: LogEntry = { seq: ++state.logSeq, hand: state.handNumber, text };
  if (opts.to) entry.to = opts.to;
  if (opts.except) entry.except = opts.except;
  state.log.push(entry);
  if (state.log.length > 2000) state.log.splice(0, state.log.length - 2000);
}

export function cardsText(cards: Card[]): string {
  return cards.map(cardToken).join('');
}

export function augLabel(id: AugmentId, wildRank?: number): string {
  const d = AUGMENTS[id];
  const extra = id === 'favoritism' && wildRank ? `(${rankName(wildRank)})` : '';
  return `「${d.name}${extra} ${'★'.repeat(d.stars)}」`;
}

export function note(state: GameState, p: PlayerState, kind: NoteKind, text: string, cards?: Card[], targetId?: string): void {
  p.notes.push({ hand: state.handNumber, kind, text, cards, targetId });
  if (p.notes.length > 200) p.notes.splice(0, p.notes.length - 200);
  addLog(state, text, { to: [p.id] });
}

export function countUse(state: GameState, id: AugmentId): void {
  state.stats.uses[id] = (state.stats.uses[id] ?? 0) + 1;
}

export function rulesFor(p: PlayerState): EvalRules {
  return {
    fourFlush: !!findAug(p, 'fourFlush'),
    gapStraight: !!findAug(p, 'gapStraight'),
    wrapStraight: !!findAug(p, 'wrapStraight'),
    wildRank: findAug(p, 'favoritism')?.wildRank ?? null,
  };
}

/** 반응 대기 중이면 대기가 끝난 뒤 돌아갈 단계 */
export function basePhase(state: GameState): Phase {
  return state.phase === 'reaction' && state.reaction ? state.reaction.resume : state.phase;
}

export function handInProgress(state: GameState): boolean {
  const b = basePhase(state);
  return b === 'betting' || b === 'discard' || b === 'declare';
}

/**
 * 증강 이름을 공개한다. 위장이 준비되어 있으면 가짜 이름으로 공개된다.
 * 반환값: 다른 사람에게 보이는 증강 id
 */
export function revealAugment(state: GameState, p: PlayerState, aug: OwnedAugment): AugmentId {
  if (aug.revealed && aug.publicId) return aug.publicId;
  const disguise = findAug(p, 'disguise');
  if (disguise && aug.id !== 'disguise' && disguise.fakeId && (disguise.usesLeft ?? 0) > 0) {
    aug.publicId = disguise.fakeId;
    disguise.usesLeft = 0;
    disguise.fakeId = null;
    countUse(state, 'disguise');
    addLog(state, `위장 발동: ${augLabel(aug.id, aug.wildRank)}이(가) 상대에게는 ${augLabel(aug.publicId)}(으)로 보입니다.`, { to: [p.id] });
  } else {
    aug.publicId = aug.id;
  }
  aug.revealed = true;
  return aug.publicId;
}

/**
 * 이름이 공개되는 증강 사용/발동을 로그에 남긴다.
 * 위장으로 가짜 이름이 보이는 경우 상대에게는 세부 내용(대상 등)을 숨긴다.
 */
export function announceNamed(state: GameState, p: PlayerState, aug: OwnedAugment, verb: string, detail = ''): void {
  const pubId = revealAugment(state, p, aug);
  const tail = detail ? ` ${detail}` : '';
  if (pubId !== aug.id) {
    addLog(state, `${p.name} ▸ ${augLabel(pubId)} ${verb}`, { except: [p.id] });
    addLog(state, `${p.name} ▸ ${augLabel(aug.id, aug.wildRank)} ${verb}${tail} (상대에게는 ${augLabel(pubId)})`, { to: [p.id] });
  } else {
    addLog(state, `${p.name} ▸ ${augLabel(pubId)} ${verb}${tail}`);
  }
}

/** "○○님이 비공개 증강을 사용했습니다" — 정보형 증강과 공포탄이 완전히 같은 형태 */
export function announceAnonymous(state: GameState, p: PlayerState): void {
  addLog(state, `${p.name}님이 비공개 증강을 사용했습니다`, { except: [p.id] });
}

export function putChips(p: PlayerState, amount: number): number {
  const amt = Math.max(0, Math.min(amount, p.chips));
  p.chips -= amt;
  p.streetBet += amt;
  p.contributed += amt;
  if (p.chips === 0 && p.inHand) {
    p.allIn = true;
    p.wentAllIn = true;
  }
  return amt;
}

/** 서버 기준 족보 계산용 보드: 공개된 보드에서 봉인된 카드 제외 */
export function evalBoard(state: GameState): Card[] {
  return state.board.slice(0, state.boardRevealed).filter((_, i) => !state.effects.sealed.includes(i));
}

/** 이 플레이어가 볼 수 있는 보드 (짙은 안개로 가려진 플랍은 null) */
export function visibleBoard(state: GameState, viewer: PlayerState): (Card | null)[] {
  const fogged = state.effects.fogSeers.length > 0 && !state.effects.fogLifted && !state.effects.fogSeers.includes(viewer.id);
  return state.board.slice(0, state.boardRevealed).map((c, i) => (fogged && i < 3 ? null : c));
}

/** viewer 가 owner 의 홀카드를 볼 수 있는가 (본인·유리 테이블·쇼다운, 암전이면 본인도 못 봄) */
export function holeVisible(state: GameState, owner: PlayerState, viewer: PlayerState): boolean {
  if (owner.shown) return true;
  if (state.effects.glass && owner.inHand) return true;
  if (owner === viewer) return !state.effects.blackout;
  return false;
}

/** 보는 사람에게 보이는 공개 카드 (쇼다운·유리 테이블로 공개된 다른 사람 카드) */
export function publicCards(state: GameState): Card[] {
  const out: Card[] = [];
  for (const p of state.players) if (p.inHand && (p.shown || state.effects.glass)) out.push(...p.hole);
  return out;
}

/** 죽음과 세금: 이 플레이어가 액티브·공개형 증강을 쓸 때 낼 세금 (자기 선언분은 면제) */
export function taxFor(state: GameState, p: PlayerState): number {
  const n = state.taxers.filter((id) => id !== p.id).length;
  return n * currentBlinds(state).bb;
}

/** 세금을 낼 수 있는가: 핸드에 참여 중이면 남은 칩 전부까지, 핸드 밖에서는 칩이 남아야 한다 */
export function taxError(state: GameState, p: PlayerState): string | null {
  const tax = taxFor(state, p);
  if (tax <= 0) return null;
  const inPlay = live(p) && handInProgress(state);
  if (inPlay ? p.chips < tax : p.chips <= tax) return `죽음과 세금: 세금 ${tax}칩을 낼 수 없어 쓸 수 없습니다.`;
  return null;
}

/** 세금 납부 (은행으로). 낸 금액을 돌려준다 */
export function payTax(state: GameState, p: PlayerState): number {
  const tax = taxFor(state, p);
  if (tax <= 0) return 0;
  const paid = Math.min(tax, p.chips);
  p.chips -= paid;
  if (p.chips === 0 && live(p)) p.allIn = true;
  state.stats.bankTaxed += paid;
  addLog(state, `${p.name}: 죽음과 세금 — 은행에 ${paid}칩 납부`);
  return paid;
}

export function nameOf(state: GameState, id: string): string {
  return playerById(state, id)?.name ?? '?';
}
