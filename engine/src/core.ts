// 엔진 공통 도우미: 게임 흐름(game.ts)과 증강 효과(effects.ts)가 함께 쓴다.

import { Card, cardToken, rankName, rankOf } from './cards.js';
import { AUGMENTS, AugmentId } from './augments.js';
import type { AppliedVariant, EvalRules } from './evaluator.js';
import type { BlindSchedule, GameState, LogEntry, NoteKind, OwnedAugment, Phase, PlayerState } from './types.js';

/** 기본 표: 시작 BB 의 배수 (이후 2배씩) */
export const STANDARD_MULTIPLIERS: readonly number[] = [1, 2, 4, 7.5, 15, 30, 60];

/** 보기 좋은 숫자로 반올림: 10 미만은 정수, 100 미만은 5 단위, 그 이상은 두 번째 자리를 5 단위로 */
export function niceRound(x: number, mode: 'round' | 'ceil' = 'round'): number {
  const f = mode === 'ceil' ? Math.ceil : Math.round;
  if (x < 10) return Math.max(1, f(x));
  const step = x < 100 ? 5 : 5 * 10 ** (Math.floor(Math.log10(x)) - 1);
  return f(x / step) * step;
}

/** 레벨(0부터)의 빅블라인드 */
export function bigBlindAt(levelIndex: number, baseBB: number, schedule: BlindSchedule): number {
  if (schedule === 'x1.5') {
    let bb = baseBB;
    for (let i = 0; i < levelIndex; i++) {
      let next = niceRound(bb * 1.5);
      if (next <= bb) next = niceRound(bb * 1.5, 'ceil');
      bb = Math.max(next, bb + 1);
    }
    return bb;
  }
  const m = levelIndex < STANDARD_MULTIPLIERS.length
    ? STANDARD_MULTIPLIERS[levelIndex]
    : STANDARD_MULTIPLIERS[STANDARD_MULTIPLIERS.length - 1] * 2 ** (levelIndex - STANDARD_MULTIPLIERS.length + 1);
  return Math.max(2, Math.round(baseBB * m));
}

/** 블라인드: 스몰블라인드는 빅블라인드의 절반 (내림) */
export function blindsAt(levelIndex: number, baseBB = 20, schedule: BlindSchedule = 'standard'): { sb: number; bb: number } {
  const bb = bigBlindAt(levelIndex, baseBB, schedule);
  return { sb: Math.max(1, Math.floor(bb / 2)), bb };
}

export function currentBlinds(state: GameState) {
  return blindsAt(state.levelIndex, state.options.bigBlind, state.options.blindSchedule);
}

/** 자리에 앉아 게임을 이어 가는 플레이어 (탈락·추방 제외) */
export const active = (p: PlayerState) => !p.out && !p.kicked;

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
    fourStraight: !!findAug(p, 'fourStraight'),
    doubleStep: !!findAug(p, 'doubleStep'),
    parity: findAug(p, 'parity')?.parity ?? null,
    numberMirror: !!findAug(p, 'numberMirror'),
    royalty: !!findAug(p, 'royalty'),
    colorFlush: p.colorBlindOn,
    crown: findAug(p, 'underdogCrown') ? p.hole.filter((c) => rankOf(c) === 2) : undefined,
    neighbors: !!findAug(p, 'neighbors'),
    triplets: !!findAug(p, 'triplets'),
  };
}

/** 족보를 바꾼 변형 → 그 변형을 만든 증강 */
export const VARIANT_AUG: Record<AppliedVariant, AugmentId> = {
  fourFlush: 'fourFlush',
  gapStraight: 'gapStraight',
  wrapStraight: 'wrapStraight',
  wild: 'favoritism',
  fourStraight: 'fourStraight',
  doubleStep: 'doubleStep',
  parity: 'parity',
  blackjack: 'blackjack',
  numberMirror: 'numberMirror',
  royalty: 'royalty',
  colorFlush: 'colorBlind',
  crown: 'underdogCrown',
  neighbors: 'neighbors',
  triplets: 'triplets',
  omaha: 'omahaBlood',
  shadow: 'shadow',
};

/** 반응 대기 중이면 대기가 끝난 뒤 돌아갈 단계 */
export function basePhase(state: GameState): Phase {
  const ph = state.phase === 'reaction' && state.reaction ? state.reaction.resume : state.phase;
  // 제안·입찰 응답 대기 중이면 그 전 단계
  return ph === 'respond' && state.respond ? state.respond.resume : ph;
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
  aug.hidden = false;
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

/** 지금 족보 순위가 뒤집혀 있는가: 밥상 뒤집기 횟수 + 언더독, 짝수 번이면 상쇄 */
export function invertedNow(state: GameState): boolean {
  return (state.effects.flips + (state.effects.underdog ? 1 : 0)) % 2 === 1;
}

/**
 * 가림 규칙: 이 플레이어에게 무엇을 숨기는가 (서버가 뷰를 만들 때 적용하고, 가린 정보와 그 파생 정보는 보내지 않는다)
 * - board: 보드 전체 (실명 다트)
 * - suits: 보드 카드의 무늬 (안경 없어서 잘 안보여)
 * - amounts: 다른 사람의 칩·베팅 금액을 대략값으로 (안경 없어서 잘 안보여)
 * 쇼다운(또는 핸드 종료) 이후에는 모두 풀린다.
 */
export interface MaskRules {
  board: boolean;
  suits: boolean;
  amounts: boolean;
}

export function maskFor(state: GameState, p: PlayerState): MaskRules {
  const e = state.effects;
  const live = !e.fogLifted && state.phase !== 'handEnd' && state.phase !== 'gameOver';
  const glasses = live && e.glasses.length > 0 && !e.glasses.includes(p.id) && !e.glassesImmune.includes(p.id);
  return { board: !e.fogLifted && e.blindDarted.includes(p.id), suits: glasses, amounts: glasses };
}

/** 보드로 계산되는 파생 정보(현재 족보·카운팅·승률 등)를 보낼 수 없는가 */
export function boardInfoHidden(state: GameState, p: PlayerState): boolean {
  const m = maskFor(state, p);
  return m.board || m.suits;
}

/** 실명 다트 대상: 쇼다운 전까지 보드(와 보드로 계산되는 정보)를 볼 수 없다 */
export function boardBlind(state: GameState, p: PlayerState): boolean {
  return maskFor(state, p).board;
}

/** 보드 카드가 담긴 로그를 받으면 안 되는 사람 (실명 다트 대상) */
export function boardBlindIds(state: GameState): string[] {
  return state.players.filter((p) => maskFor(state, p).board).map((p) => p.id);
}

/** 보드 카드가 담긴 로그: 짙은 안개로 가려진 사람, 실명 다트 대상에게는 카드 없이 */
export function logBoard(state: GameState, text: string, hiddenText: string, fogged: boolean): void {
  const fog = state.effects.fogSeers;
  const blind = boardBlindIds(state);
  const seers = fogged && fog.length ? fog.filter((id) => !blind.includes(id)) : null;
  if (seers) {
    addLog(state, hiddenText, { except: seers });
    if (seers.length) addLog(state, `${text} (안개: 나만 보임)`, { to: seers });
  } else if (blind.length) {
    addLog(state, hiddenText, { to: blind });
    addLog(state, text, { except: blind });
  } else {
    addLog(state, text);
  }
}

/** 첫 스트리트(플랍)에 공개되는 장수: 짙은 안개가 가리는 범위 (거꾸로 강을 거슬러면 1장) */
export function flopCount(state: GameState): number {
  return state.revealPlan[0];
}

/** 메이드 인 헤븐으로 줄어드는 이 플레이어의 행동 시간 (초) */
export function turnCutFor(state: GameState, playerId: string): number {
  let cut = 0;
  for (const h of state.heaven) {
    if (h.by === playerId || h.immune.includes(playerId)) continue;
    cut += 5 * Math.max(0, state.handNumber - h.startHand);
  }
  return cut;
}

/** 플레이어별 행동 제한 시간 (방 설정 base 초에서 증강 효과를 뺌, 최소 5초) */
export function turnSecondsFor(state: GameState, playerId: string, base: number): number {
  const cut = turnCutFor(state, playerId);
  return cut > 0 ? Math.max(5, base - cut) : base;
}

/** 암전 때문에 자기 카드를 못 보는가 (면역이면 봄, 유리 테이블이면 모두 봄) */
export function ownCardsHidden(state: GameState, p: PlayerState): boolean {
  const e = state.effects;
  return e.blackout && !e.blackoutImmune.includes(p.id) && !(e.glass && !e.glassImmune.includes(p.id));
}

/** 자물쇠가 걸린 베팅 라운드인가 */
export function lockError(state: GameState): string | null {
  return state.round.locked && handInProgress(state) ? '자물쇠: 이번 베팅 라운드에는 액티브·공개형 증강을 쓸 수 없습니다.' : null;
}

/** 서버 기준 족보 계산용 보드: 공개된 보드에서 봉인된 카드 제외 */
export function evalBoard(state: GameState): Card[] {
  return state.board.slice(0, state.boardRevealed).filter((_, i) => !state.effects.sealed.includes(i));
}

/** 이 플레이어가 볼 수 있는 보드 (짙은 안개로 가려진 플랍은 null) */
export function visibleBoard(state: GameState, viewer: PlayerState): (Card | null)[] {
  return boardView(state, state.board, viewer);
}

/** 보드 하나를 보는 사람 기준으로 (짙은 안개·실명 다트로 가려진 칸은 null) */
export function boardView(state: GameState, board: Card[], viewer: PlayerState): (Card | null)[] {
  const fogged = state.effects.fogSeers.length > 0 && !state.effects.fogLifted && !state.effects.fogSeers.includes(viewer.id);
  const blind = boardBlind(state, viewer);
  const fc = flopCount(state);
  return board.slice(0, state.boardRevealed).map((c, i) => (blind || (fogged && i < fc) ? null : c));
}

/** viewer 가 owner 의 홀카드를 볼 수 있는가 (본인·유리 테이블·쇼다운, 암전이면 본인도 못 봄) */
export function holeVisible(state: GameState, owner: PlayerState, viewer: PlayerState): boolean {
  if (owner.shown) return true;
  if (owner === viewer) return !ownCardsHidden(state, owner);
  if (glassShows(state, owner)) return true;
  return false;
}

/** 유리 테이블로 이 사람 카드가 공개되어 있는가 (면역이면 숨김) */
export function glassShows(state: GameState, owner: PlayerState): boolean {
  return state.effects.glass && owner.inHand && !state.effects.glassImmune.includes(owner.id);
}

/** 보는 사람에게 보이는 공개 카드 (쇼다운·유리 테이블로 공개된 다른 사람 카드) */
export function publicCards(state: GameState): Card[] {
  const out: Card[] = [];
  for (const p of state.players) if (p.inHand && (p.shown || glassShows(state, p))) out.push(...p.hole);
  return out;
}

/** 죽음과 세금: 이 플레이어가 액티브·공개형 증강을 쓸 때 낼 세금 (자기 선언분은 면제) */
export function taxFor(state: GameState, p: PlayerState): number {
  const n = state.taxers.filter((id) => id !== p.id && !(state.taxExempt[id] ?? []).includes(p.id)).length;
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
export function payTax(state: GameState, p: PlayerState, secret = false): number {
  const tax = taxFor(state, p);
  if (tax <= 0) return 0;
  const paid = Math.min(tax, p.chips);
  p.chips -= paid;
  if (p.chips === 0 && live(p)) {
    p.allIn = true;
    p.wentAllIn = true;
  }
  state.stats.bankTaxed += paid;
  if (secret) {
    addLog(state, `누군가 죽음과 세금 — 은행에 ${paid}칩 납부`, { except: [p.id] });
    addLog(state, `${p.name}: 죽음과 세금 — 은행에 ${paid}칩 납부`, { to: [p.id] });
  } else addLog(state, `${p.name}: 죽음과 세금 — 은행에 ${paid}칩 납부`);
  return paid;
}

export function nameOf(state: GameState, id: string): string {
  return playerById(state, id)?.name ?? '?';
}
