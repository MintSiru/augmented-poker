// 증강 효과 함수 레지스트리.
// - ACTIVE: 선언형 증강. check(시점·대상 검증) → 3초 반응 대기 → resolve(효과 적용). 카운터되면 onCountered.
// - PASSIVE: 엔진이 정해진 시점에 부르는 훅 (홀카드 수, 폴드, 핸드 종료, 정보 노출, 강제 폴드 방어).
// 족보 변형(원형·4장 플러시·징검다리·편애)은 core.rulesFor, 동점 처리(키커 장인·절대 키커)는 showdown.ts 에서 처리한다.
// 새 증강은 augments.ts 에 정의를 추가하고 여기에 효과를 등록하면 된다.

import { Card, cardToken, fullDeck, isCard, rankOf, rankName, suitOf } from './cards.js';
import { AUGMENTS, AugmentId, canHold, isActiveAugment, isAugmentId } from './augments.js';
import { blackjackCards, isMadeHand, Category, CATEGORY_NAMES } from './evaluator.js';
import { pickOne } from './rng.js';
import { compareContenders } from './showdown.js';
import { contenderFor, handEvalFor, standingOf } from './standing.js';
import {
  active,
  addLog,
  canAct,
  announceNamed,
  basePhase,
  boardBlind,
  boardBlindIds,
  boardInfoHidden,
  flopCount,
  logBoard,
  maskFor,
  invertedNow,
  ownCardsHidden,
  cardsText,
  countUse,
  currentBlinds,
  evalBoard,
  findAug,
  handInProgress,
  holeVisible,
  idxOf,
  live,
  nameOf,
  note,
  playerById,
  publicCards,
  putChips,
  rulesFor,
  taxError,
  visibleBoard,
} from './core.js';
import type { ActiveParams, Declaration, GameState, HandResult, OwnedAugment, PlayerState, RespondAnswer, RespondState, ScheduledTask } from './types.js';

/** 효과 함수가 게임 흐름을 건드릴 때 쓰는 엔진 기능 (game.ts 가 제공) */
export interface EngineOps {
  /** 폴드 처리 (보험 등 폴드 훅 포함). 흐름 진행은 하지 않는다 */
  fold(p: PlayerState, forced: boolean): void;
  /** 서킷브레이커: 이번 베팅 라운드를 처음부터 다시 */
  restartRound(): void;
  /** 하이카드: 핸드를 무효화하고 홀카드 1장 승부 */
  highCardDuel(): void;
  /** 나 다시 돌아갈래: 핸드를 프리플랍부터 다시 */
  restartHand(declarer: PlayerState): void;
  /** 보드 카드 1장 추가 공개 (플러스 원) */
  addBoardCard(label: string): void;
  /** 베팅 행동 뒤 흐름 진행 (무임승차 콜) */
  afterBet(idx: number): void;
  /** 제안·입찰 시작: 응답이 모두 모이거나 15초가 지나면 효과의 respond.done 이 불린다 */
  startRespond(spec: Pick<RespondState, 'kind' | 'augment' | 'ownerId' | 'participants' | 'params'>): void;
}

export interface Ctx {
  state: GameState;
  ops: EngineOps;
  owner: PlayerState;
  aug: OwnedAugment;
}

export interface ActiveEffect {
  /** 사용 가능 여부 (시점·대상). 횟수와 보유는 엔진이 공통으로 검사. atResolve=true 는 반응 대기 후 재검사 */
  check(ctx: Ctx, params: ActiveParams, atResolve: boolean): string | null;
  /** 선언 시 추가로 소모할 것 (양치기 소년의 가짜 공개 등) */
  consume?(ctx: Ctx, params: ActiveParams): void;
  resolve(ctx: Ctx, params: ActiveParams, decl: Declaration): void;
  onCountered?(ctx: Ctx, params: ActiveParams): void;
  /** 선언 세부 (로그, 공개) */
  detail?(ctx: Ctx, params: ActiveParams): string;
  /** 제안·입찰형: 응답 검증, 기본 응답(시간 초과·자리 비움), 결과 처리 */
  respond?: RespondHooks;
}

export interface RespondHooks {
  error(ctx: Ctx, r: RespondState, p: PlayerState, a: RespondAnswer): string | null;
  fallback(ctx: Ctx, r: RespondState, p: PlayerState): RespondAnswer;
  /** 응답이 모두 모였을 때. true 를 돌려주면 r 을 고친 채로 응답을 더 받는다 (공동 환승의 카드 고르기) */
  done(ctx: Ctx, r: RespondState): boolean;
}

export type InfoKind = 'clairvoyance' | 'thermal' | 'liedetector' | 'thermometer';

const INFO_NAME: Record<InfoKind, string> = { clairvoyance: '투시', thermal: '열화상 카메라', liedetector: '거짓말 탐지기', thermometer: '온도계' };

export interface PassiveEffect {
  /** 받는 홀카드 수 */
  holeCards?: number;
  onFold?(ctx: Ctx, forced: boolean): void;
  onHandEnd?(ctx: Ctx, result: HandResult): void;
  /** 정보형 증강에 노출될 때. 'fake' 를 돌려주면 보는 사람에게 가짜 결과를 보여 준다 */
  onInfoExposed?(ctx: Ctx, looker: PlayerState, kind: InfoKind): 'fake' | void;
  /** 다른 사람 증강의 강제 폴드를 막으면 true */
  blockForcedFold?(ctx: Ctx): boolean;
  /** 칩이 0이 되어 탈락할 때. true 면 탈락하지 않는다 (부활 대기 등) */
  onBust?(ctx: Ctx): boolean;
  /** 증강 선택 라운드가 시작될 때 (선택지를 받은 뒤) */
  onPickRound?(ctx: Ctx): void;
  /** 내가 증강을 얻었을 때 (얻은 증강 자신 포함) */
  onAcquire?(ctx: Ctx, got: OwnedAugment): void;
}

// ───────────────────────── 공통 검사 ─────────────────────────

function targetOf(ctx: Ctx, params: ActiveParams): PlayerState | undefined {
  const t = playerById(ctx.state, params.targetId);
  return t && t !== ctx.owner ? t : undefined;
}

function needLive(ctx: Ctx): string | null {
  if (!handInProgress(ctx.state)) return '핸드가 진행 중일 때만 쓸 수 있습니다.';
  if (!live(ctx.owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
  return null;
}

function opponentInHand(ctx: Ctx, params: ActiveParams): string | null {
  const err = needLive(ctx);
  if (err) return err;
  const t = targetOf(ctx, params);
  if (!t) return '대상을 고르세요.';
  if (!live(t) || !t.hole.length) return '대상은 이번 핸드에 참여 중인 상대여야 합니다.';
  return null;
}

/** 보드로 계산되는 정보를 쓰는 증강: 실명 다트 대상은 쓸 수 없다 */
function needSight(ctx: Ctx): string | null {
  return boardBlind(ctx.state, ctx.owner) ? '실명 다트: 이번 핸드에는 보드를 볼 수 없어 쓸 수 없습니다.' : null;
}

/** 보드의 무늬까지 알아야 계산되는 정보 (순위표·운명의 실·블랙잭 제외): 가림 규칙이 걸리면 쓸 수 없다 */
function needClearSight(ctx: Ctx): string | null {
  return needSight(ctx) ?? (boardInfoHidden(ctx.state, ctx.owner) ? '안경 없어서 잘 안보여: 이번 핸드에는 보드가 또렷하지 않아 쓸 수 없습니다.' : null);
}

/** 프리플랍 베팅 중 내 차례 (실명 다트·너 나가·하이카드) */
function preflopMyTurn(ctx: Ctx): string | null {
  const { state, owner } = ctx;
  if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.boardRevealed > 0) return '프리플랍 베팅 중에만 선언할 수 있습니다.';
  if (state.toAct !== idxOf(state, owner.id)) return '내 차례에만 선언할 수 있습니다.';
  if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
  return null;
}

/** 지목형 증강(강제 집행·실명 다트·너 나가)의 대상 검사: 철벽이면 지목할 수 없다 */
function targetable(t: PlayerState): string | null {
  return t.ironWall ? `${t.name}은(는) 철벽으로 이번 핸드에 지목할 수 없습니다.` : null;
}

/** 강제 폴드 방어 (방탄조끼) */
function blocksForcedFold(ctx: Ctx, victim: PlayerState): boolean {
  for (const a of victim.augments) {
    const hook = PASSIVE[a.id]?.blockForcedFold;
    if (hook && hook({ ...ctx, owner: victim, aug: a })) return true;
  }
  return false;
}

/** 핸드 사이 (다음 핸드 배분 전) */
function betweenHandsCheck(ctx: Ctx): string | null {
  const b = basePhase(ctx.state);
  if (b !== 'handEnd' && b !== 'augmentSelect') return '카드를 나눠 주기 전(핸드 사이)에만 선언할 수 있습니다.';
  if (!active(ctx.owner)) return '게임에 참여하고 있지 않습니다.';
  return null;
}

function validHoleIndex(owner: PlayerState, ci: unknown): ci is number {
  return typeof ci === 'number' && Number.isInteger(ci) && ci >= 0 && ci < owner.hole.length;
}

function hiLoText(cards: Card[]): string {
  const hi = cards.filter((c) => rankOf(c) >= 10).length;
  return `하이 ${hi}장, 로우 ${cards.length - hi}장`;
}

/** 정보형 증강 노출: 대상의 역정보/거울 훅을 부른다 */
export function exposeInfo(ctx: Ctx, target: PlayerState, kind: InfoKind): boolean {
  let fake = false;
  for (const a of target.augments) {
    const hook = PASSIVE[a.id]?.onInfoExposed;
    if (hook && hook({ ...ctx, owner: target, aug: a }, ctx.owner, kind) === 'fake') fake = true;
  }
  return fake;
}

/** 면역으로 빠진 사람 표시 */
function immuneText(state: GameState, ids: string[], what = '효과에서 빠짐'): string {
  return ids.length ? ` (면역: ${ids.map((id) => nameOf(state, id)).join(', ')} ${what})` : '';
}

const SUIT_NAME: Record<string, string> = { s: '♠ 스페이드', h: '♥ 하트', d: '♦ 다이아몬드', c: '♣ 클로버' };
const SUITS = ['s', 'h', 'd', 'c'] as const;

/** 턴과 리버 사이: 다음에 나올 턴 카드와 리버 첫 카드의 보드 위치 */
function turnRiverIdx(state: GameState): number[] {
  return [state.boardRevealed, Math.min(state.board.length, state.revealPlan[1] + state.extraCards)];
}

function realMade(state: GameState, p: PlayerState): boolean {
  return isMadeHand(p.hole, evalBoard(state), rulesFor(p));
}

// ───────────────────────── 증강 이동 (증강 셔플·대출 몰수·사냥꾼) ─────────────────────────

/** 증강 하나를 다른 사람에게 넘긴다 (남은 횟수 그대로, 받은 사람만 앎) */
export function moveAugment(from: PlayerState, to: PlayerState, aug: OwnedAugment): void {
  from.augments = from.augments.filter((a) => a !== aug);
  aug.revealed = false;
  aug.publicId = null;
  aug.hidden = false;
  aug.armed = aug.id === 'exemption' ? false : aug.armed;
  to.augments.push(aug);
}

/** 증강 셔플: ring 의 각자가 무작위 증강 1개를 왼쪽(다음 자리) 사람에게. 보유 규칙에 맞는 조합을 고른다 */
function shuffleAugments(state: GameState, ring: PlayerState[]): boolean {
  if (ring.length < 2) return false;
  const next = (i: number) => ring[(i + 1) % ring.length];
  let best: (OwnedAugment | null)[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    const out = ring.map((p) => (p.augments.length ? pickOne(p.augments, state.rng) : null));
    // 받는 사람이 (자기가 넘긴 것을 뺀) 보유 증강과 함께 가질 수 있는가
    const okFor = (i: number) => {
      const g = out[i];
      if (!g) return true;
      const r = next(i);
      const ri = (i + 1) % ring.length;
      const keeps = r.augments.filter((a) => a !== out[ri]).map((a) => a.id);
      return canHold(keeps, g.id);
    };
    const valid = out.map((g, i) => (okFor(i) ? g : null));
    if (valid.filter(Boolean).length > best.filter(Boolean).length) best = valid;
    if (out.every((_, i) => okFor(i))) break;
  }
  if (!best.some(Boolean)) return false;
  best.forEach((g, i) => {
    if (!g) return;
    const from = ring[i];
    const to = next(i);
    moveAugment(from, to, g);
    note(state, from, 'augment', `증강 셔플: ${AUGMENTS[g.id].name}을(를) ${to.name}에게 넘겼습니다`);
    note(state, to, 'augment', `증강 셔플: ${from.name}에게서 ${AUGMENTS[g.id].name}을(를) 받았습니다 (남은 횟수 ${g.usesLeft ?? '-'})`);
  });
  return true;
}

/** 다 쓴 ★·★★ 액티브 증강 중 무작위 1개를 1회 충전 (사냥꾼·재충전) */
export function rechargeable(p: PlayerState, maxStars: number): OwnedAugment[] {
  return p.augments.filter((a) => {
    const d = AUGMENTS[a.id];
    return isActiveAugment(a.id) && d.stars <= maxStars && d.uses?.per === 'game' && (a.usesLeft ?? 0) <= 0;
  });
}

// ───────────────────────── 제안·응답 공통 ─────────────────────────

function bbOf(state: GameState): number {
  return currentBlinds(state).bb;
}

function respondBusy(state: GameState): string | null {
  return state.respond ? '다른 제안·입찰이 진행 중입니다.' : null;
}

/** 칩을 옮긴다 (to 가 null 이면 은행). 모자라면 있는 만큼. 핸드 중 칩이 0이 되면 올인 */
export function transfer(state: GameState, from: PlayerState, to: PlayerState | null, amount: number): number {
  const amt = Math.max(0, Math.min(amount, from.chips));
  from.chips -= amt;
  if (to) to.chips += amt;
  else state.stats.bankPaid += amt;
  if (from.chips === 0 && amt > 0 && live(from)) {
    from.allIn = true;
    from.wentAllIn = true;
  }
  return amt;
}

/** 입찰금을 팟(데드 머니)에 넣는다 */
function payToPot(state: GameState, p: PlayerState, amount: number): number {
  const amt = transfer(state, p, null, amount);
  state.stats.bankPaid -= amt;
  state.deadMoney += amt;
  return amt;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** 입찰 검증: 0(불참) 또는 1BB 이상 내 칩까지 */
function bidError(state: GameState, p: PlayerState, bid: unknown): string | null {
  if (!isInt(bid) || bid < 0) return '입찰가를 올바르게 정하세요.';
  if (bid === 0) return null;
  if (bid < bbOf(state)) return `입찰가는 0(불참) 또는 ${bbOf(state)} 이상이어야 합니다.`;
  if (bid > p.chips) return '보유 칩보다 많이 입찰할 수 없습니다.';
  return null;
}

/** 최고 입찰자 (동점이면 무작위) */
function topBidder(state: GameState, r: RespondState): { p: PlayerState; bid: number } | null {
  let best = 0;
  let ids: string[] = [];
  for (const id of r.participants) {
    const b = r.answers[id]?.bid ?? 0;
    const p = playerById(state, id);
    if (!p || !live(p) || b <= 0 || b > p.chips) continue;
    if (b > best) {
      best = b;
      ids = [id];
    } else if (b === best) ids.push(id);
  }
  if (!ids.length) return null;
  return { p: playerById(state, pickOne(ids, state.rng))!, bid: best };
}

/** 입찰 참여자: 핸드에 남아 1BB 이상 있고 보드를 볼 수 있는 사람 */
function bidders(state: GameState, needHole: boolean): string[] {
  return state.players.filter((p) => live(p) && p.chips >= bbOf(state) && !boardBlind(state, p) && (!needHole || p.hole.length > 0)).map((p) => p.id);
}

const truthNames = [...CATEGORY_NAMES.slice(0, 7), '포카드 이상'];

/** 명추리: 선언자가 이미 아는 대상의 카드 (공개 카드·내 정보 기록·양치기 소년·경매 카드) */
export function knownCardsFor(state: GameState, owner: PlayerState, target: PlayerState): Card[] {
  const out = new Set<Card>([...owner.hole, ...publicCards(state), ...target.shepherdShown]);
  for (const c of visibleBoard(state, owner)) if (c) out.add(c);
  if (state.auctionCard) out.add(state.auctionCard);
  for (const n of owner.notes) if (n.hand === state.handNumber && n.targetId === target.id) for (const c of n.cards ?? []) out.add(c);
  return [...out];
}

/** 명추리 대상이 될 수 있는가: 이미 내가 홀카드를 모두 아는 상대는 안 된다 */
function knownTargetError(state: GameState, owner: PlayerState, t: PlayerState): string | null {
  // 내가 아는 정보만으로 판단한다 (진짜 카드와 비교하지 않음 — 역정보 여부가 드러나지 않게)
  const about = new Set<Card>(t.shepherdShown);
  if (holeVisible(state, t, owner)) for (const c of t.hole) about.add(c);
  for (const n of owner.notes) if (n.hand === state.handNumber && n.targetId === t.id) for (const c of n.cards ?? []) about.add(c);
  return about.size >= t.hole.length ? `${t.name}의 홀카드는 이미 모두 알고 있어 지목할 수 없습니다.` : null;
}

const yesNo = (v: unknown) => (typeof v === 'boolean' ? null : '수락 여부를 정하세요.');

// ───────────────────────── 액티브 효과 ─────────────────────────

export const ACTIVE: Partial<Record<AugmentId, ActiveEffect>> = {
  thermal: {
    check: opponentInHand,
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      let text = hiLoText(t.hole);
      if (exposeInfo(ctx, t, 'thermal')) {
        // 역정보: 실제와 다른 하이/로우 조합
        const n = t.hole.length;
        const real = t.hole.filter((c) => rankOf(c) >= 10).length;
        const others = Array.from({ length: n + 1 }, (_, i) => i).filter((h) => h !== real);
        const h = pickOne(others, ctx.state.rng);
        text = `하이 ${h}장, 로우 ${n - h}장`;
      }
      note(ctx.state, ctx.owner, 'thermal', `열화상 카메라: ${t.name}의 홀카드 — ${text}`, undefined, t.id);
    },
  },

  clairvoyance: {
    check: opponentInHand,
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const t = targetOf(ctx, params)!;
      let card = pickOne(t.hole, state.rng);
      if (exposeInfo(ctx, t, 'clairvoyance')) {
        // 역정보: 대상이 갖지 않았고 내가 이미 아는 카드도 아닌 가짜 카드
        const known = new Set<Card>([...t.hole, ...owner.hole, ...visibleBoard(state, owner).filter((c): c is Card => !!c), ...publicCards(state)]);
        card = pickOne(fullDeck().filter((c) => !known.has(c)), state.rng);
      }
      note(state, owner, 'clairvoyance', `투시: ${t.name}의 홀카드 중 1장은 ${cardToken(card)}`, [card], t.id);
    },
  },

  liedetector: {
    check(ctx, params) {
      const err = needLive(ctx);
      if (err) return err;
      const { state } = ctx;
      const la = state.lastAggression;
      const t = targetOf(ctx, params);
      if (!la || la.seq !== state.betActionSeq || la.street !== state.street || basePhase(state) !== 'betting') {
        return '상대가 베팅·레이즈한 직후에만 쓸 수 있습니다.';
      }
      if (!t || idxOf(state, t.id) !== la.idx) return '방금 베팅·레이즈한 상대를 고르세요.';
      if (!live(t)) return '대상이 핸드에 없습니다.';
      return null;
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      let made = realMade(ctx.state, t);
      if (exposeInfo(ctx, t, 'liedetector')) made = !made;
      note(ctx.state, ctx.owner, 'liedetector', `거짓말 탐지기: ${t.name} — ${made ? '메이드 핸드입니다' : '메이드 핸드가 아닙니다'}`, undefined, t.id);
    },
  },

  foresight: {
    check(ctx) {
      const err = needLive(ctx) ?? needSight(ctx);
      if (err) return err;
      const { state, owner } = ctx;
      if ((state.street !== 'flop' && state.street !== 'turn') || state.boardRevealed >= state.board.length) return '플랍 이후, 리버가 나오기 전에만 쓸 수 있습니다.';
      if (owner.foreseen.includes(state.boardRevealed)) return '이미 다음 카드를 보았습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const bi = state.boardRevealed;
      const card = state.board[bi];
      owner.foreseen.push(bi);
      note(state, owner, 'foresight', `예지: 다음 보드 카드(${state.street === 'flop' ? '턴' : '리버'})는 ${cardToken(card)}`, [card]);
    },
  },

  inquiry: {
    check(ctx, params) {
      const t = targetOf(ctx, params);
      if (!t || t.out) return '대상을 고르세요.';
      return null;
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      // 잠복으로 숨긴 증강은 빠진다
      const stars = t.augments.filter((x) => !x.hidden).map((x) => AUGMENTS[x.id].stars).sort((x, y) => y - x);
      const text = stars.length ? stars.map((s) => '★'.repeat(s)).join(', ') : '증강 없음';
      note(ctx.state, ctx.owner, 'inquiry', `탐문: ${t.name}의 증강 별 개수 — ${text}`, undefined, t.id);
    },
  },

  blank: {
    check(ctx) {
      if (!ctx.owner.augments.some((a) => a.id !== 'blank' && isActiveAugment(a.id))) return '다른 액티브 증강을 보유했을 때만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx) {
      note(ctx.state, ctx.owner, 'blank', '공포탄: 알림만 보냈습니다 (효과 없음).');
    },
  },

  mulligan: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop') return '프리플랍에만 쓸 수 있습니다.';
      if (!live(owner) || owner.allIn) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (owner.actedPreflop) return '프리플랍에 행동하기 전에만 쓸 수 있습니다.';
      const { bb } = currentBlinds(state);
      if (owner.chips <= bb) return `칩이 1BB(${bb})보다 많아야 합니다.`;
      const blind = ownCardsHidden(state, owner);
      const ci = params.cardIndex;
      if (!blind && (typeof ci !== 'number' || !Number.isInteger(ci) || ci < 0 || ci >= owner.hole.length)) return '교체할 카드를 고르세요.';
      if (!state.deck.length) return '덱에 남은 카드가 없습니다.';
      return null;
    },
    detail: (ctx) => `— 1BB(${currentBlinds(ctx.state).bb}) 내고 홀카드 1장 교체`,
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const { bb } = currentBlinds(state);
      owner.chips -= bb;
      owner.mulliganFee += bb;
      state.deadMoney += bb;
      const blind = ownCardsHidden(state, owner);
      const ci = blind ? state.rng.int(owner.hole.length) : params.cardIndex!;
      const old = owner.hole[ci];
      const fresh = state.deck.shift()!;
      owner.hole[ci] = fresh;
      owner.discarded.push(old);
      state.used.push({ card: old, kind: 'discard' });
      addLog(state, `${owner.name}: 1BB(${bb}) 내고 홀카드 1장 교체`);
      if (blind) note(state, owner, 'mulligan', '멀리건: 암전 중이라 무작위 1장을 교체했습니다.');
      else note(state, owner, 'mulligan', `멀리건: ${cardToken(old)} → ${cardToken(fresh)}`, [old, fresh]);
    },
  },

  rewind: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || (state.windowStage !== 'turn' && state.windowStage !== 'river')) return '턴·리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (!state.deck.length) return '덱에 남은 카드가 없습니다.';
      if (state.fixedIdx.includes(state.boardRevealed - 1)) return '예약·확정된 카드는 되감을 수 없습니다.';
      return null;
    },
    resolve(ctx) {
      const { state } = ctx;
      const i = state.boardRevealed - 1;
      const old = state.board[i];
      const fresh = state.deck.shift()!;
      state.board[i] = fresh;
      state.used.push({ card: old, kind: 'rewind' });
      state.effects.rewinds++;
      const label = state.street === 'turn' ? '턴' : '리버';
      const blind = boardBlindIds(state);
      addLog(state, `되감기: ${label} ${cardToken(old)} 버림 → 새 카드 ${cardToken(fresh)}`, blind.length ? { except: blind } : {});
      if (blind.length) addLog(state, `되감기: ${label} 카드가 바뀌었습니다`, { to: blind });
    },
  },

  seal: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'river') return '리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      const bi = params.boardIndex;
      if (typeof bi !== 'number' || !Number.isInteger(bi) || bi < 0 || bi >= state.boardRevealed) return '봉인할 보드 카드를 고르세요.';
      if (state.effects.sealed.includes(bi)) return '이미 봉인된 카드입니다.';
      if (state.effects.sealed.length >= 2) return '한 핸드에 보드 카드는 2장까지만 봉인할 수 있습니다.';
      return null;
    },
    resolve(ctx, params) {
      const { state } = ctx;
      const bi = params.boardIndex!;
      state.effects.sealed.push(bi);
      const card = state.board[bi];
      const blind = boardBlindIds(state);
      const fog = state.effects.fogSeers.filter((id) => !blind.includes(id));
      const foggedIdx = bi < flopCount(state) && state.effects.fogSeers.length > 0 && !state.effects.fogLifted;
      if (blind.length && !foggedIdx) {
        addLog(state, `봉인: 보드 ${bi + 1}번째 카드가 이번 핸드 족보 계산에서 빠집니다`, { to: blind });
        addLog(state, `봉인: ${cardToken(card)}가 이번 핸드 족보 계산에서 빠집니다`, { except: blind });
      } else if (foggedIdx) {
        // 안개에 가려진 플랍 카드는 볼 수 있는 사람에게만 카드 이름을 보여 준다
        addLog(state, `봉인: 보드 ${bi + 1}번째 카드가 이번 핸드 족보 계산에서 빠집니다`, { except: fog });
        addLog(state, `봉인: 보드 ${bi + 1}번째 카드 ${cardToken(card)}가 이번 핸드 족보 계산에서 빠집니다`, { to: fog });
      } else {
        addLog(state, `봉인: ${cardToken(card)}가 이번 핸드 족보 계산에서 빠집니다`);
      }
    },
  },

  freeRide: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.toAct !== idxOf(state, owner.id)) return '내 차례에 콜할 때만 쓸 수 있습니다.';
      const owed = state.currentBet - owner.streetBet - owner.streetShort;
      const setter = state.betSetter;
      if (owed <= 0) return '콜할 금액이 없습니다.';
      if (!setter || !(setter.raise || state.players[setter.idx].allIn)) return '레이즈나 올인에 콜할 때만 쓸 수 있습니다.';
      if (owner.chips <= 0) return '칩이 없습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner, ops } = ctx;
      const idx = idxOf(state, owner.id);
      const owed = state.currentBet - owner.streetBet - owner.streetShort;
      const pay = putChips(owner, Math.ceil(owed / 2));
      if (!owner.allIn) owner.streetShort += owed - pay;
      owner.acted = true;
      owner.actedLevel = state.currentBet;
      owner.forcedCall = false;
      if (state.street === 'preflop') owner.actedPreflop = true;
      owner.lastAction = `무임승차 콜 ${pay}`;
      addLog(state, `${owner.name}: 무임승차 콜 (${pay}칩만 내고 ${owed}칩 콜로 처리)`);
      ops.afterBet(idx);
    },
  },

  enforcement: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'river') return '리버 베팅 라운드에서만 쓸 수 있습니다.';
      if (!live(owner) || !owner.allIn || owner.streetBet <= 0) return '리버에서 내가 올인한 뒤에만 쓸 수 있습니다.';
      const t = targetOf(ctx, params);
      if (!t || !live(t) || t.allIn) return '핸드에 남아 있는 상대를 고르세요.';
      const wall = targetable(t);
      if (wall) return wall;
      if (t.chips + t.streetBet <= owner.streetBet) return '나보다 칩이 많은 상대만 지목할 수 있습니다.';
      if (t.streetBet + t.streetShort >= state.currentBet) return '이미 콜한 상대입니다.';
      return null;
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      t.forcedCall = true;
      addLog(ctx.state, `강제 집행: ${t.name}은(는) 이번에 폴드할 수 없고 콜해야 합니다`);
    },
  },

  shepherd: {
    check(ctx, params, atResolve) {
      const { state, owner, aug } = ctx;
      if (basePhase(state) !== 'betting' || state.street === 'preflop') return '플랍 이후 베팅 라운드에서만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (state.effects.glass) return '유리 테이블 중에는 쓸 수 없습니다.';
      if (params.card !== undefined) {
        const c = params.card;
        if (!atResolve && aug.fakeUsed) return '가짜 공개는 게임 1회만 쓸 수 있습니다.';
        if (!isCard(c)) return '가짜 카드를 올바르게 고르세요.';
        if (owner.hole.includes(c)) return '내 카드입니다. 진짜 공개를 고르세요.';
        const shown = new Set<Card>([
          ...state.board.slice(0, state.boardRevealed),
          ...publicCards(state),
          ...state.players.flatMap((p) => p.shepherdShown),
        ]);
        if (shown.has(c)) return '보드나 이미 공개된 카드와 겹칠 수 없습니다.';
        return null;
      }
      const ci = params.cardIndex;
      if (typeof ci !== 'number' || !Number.isInteger(ci) || ci < 0 || ci >= owner.hole.length) return '공개할 카드를 고르세요.';
      return null;
    },
    consume(ctx, params) {
      if (params.card !== undefined) ctx.aug.fakeUsed = true;
    },
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const fake = params.card !== undefined;
      const card = fake ? params.card! : owner.hole[params.cardIndex!];
      owner.shepherdShown.push(card);
      if (fake) owner.shepherdLied = true;
      // 진짜와 가짜가 다른 사람 화면에서 구별되지 않도록 같은 문장
      addLog(state, `${owner.name}: 홀카드 ${cardToken(card)} 공개`);
      if (fake) addLog(state, '(가짜 카드를 공개했습니다. 쇼다운까지 가면 들킵니다)', { to: [owner.id] });
    },
  },

  blackout: {
    check(ctx) {
      const b = basePhase(ctx.state);
      if (b !== 'handEnd' && b !== 'augmentSelect') return '카드를 나눠 주기 전(핸드 사이)에만 선언할 수 있습니다.';
      return null;
    },
    resolve(ctx, _params, decl) {
      ctx.state.blackoutNext = true;
      ctx.state.blackoutBy = ctx.owner.id;
      ctx.state.blackoutImmuneNext = [...decl.immune];
      addLog(ctx.state, `암전: 다음 핸드는 모두 자기 홀카드를 보지 못한 채 진행합니다${immuneText(ctx.state, decl.immune)}`);
    },
  },

  glassTable: {
    check: (ctx) => (handInProgress(ctx.state) ? null : '핸드가 진행 중일 때만 쓸 수 있습니다.'),
    resolve(ctx, _params, decl) {
      ctx.state.effects.glass = true;
      ctx.state.effects.glassImmune = [...decl.immune];
      addLog(ctx.state, `유리 테이블: 이번 핸드는 모든 홀카드를 공개한 채 진행합니다${immuneText(ctx.state, decl.immune)}`);
    },
  },

  russianRoulette: {
    check(ctx) {
      if (!handInProgress(ctx.state)) return '핸드가 진행 중일 때만 쓸 수 있습니다.';
      if (ctx.state.players.filter(live).length < 3) return '폴드하지 않은 사람이 3명 이상일 때만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx, _params, decl) {
      const { state, ops } = ctx;
      const pool = state.players.filter((p) => live(p) && !decl.immune.includes(p.id));
      if (!pool.length) {
        addLog(state, '러시안 룰렛: 추첨할 사람이 없습니다');
        return;
      }
      const victim = pickOne(pool, state.rng);
      addLog(state, `러시안 룰렛: ${victim.name}에게 당첨!${immuneText(state, decl.immune, '추첨 제외')}`);
      if (blocksForcedFold(ctx, victim)) return;
      ops.fold(victim, true);
    },
  },

  flipTable: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'river') return '리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx) {
      const e = ctx.state.effects;
      e.flips++;
      addLog(ctx.state, invertedNow(ctx.state) ? '밥상 뒤집기: 이번 핸드는 족보가 역전되어 가장 낮은 패가 승리합니다' : '밥상 뒤집기: 족보 역전이 상쇄되어 원래 순위로 돌아갑니다');
    },
  },

  heavyFog: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.boardRevealed > 0) return '플랍이 깔리기 전(프리플랍)에만 선언할 수 있습니다.';
      if (!live(ctx.owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx, _params, decl) {
      const fog = ctx.state.effects.fogSeers;
      for (const id of [ctx.owner.id, ...decl.immune]) if (!fog.includes(id)) fog.push(id);
      addLog(ctx.state, `짙은 안개: 이번 플랍은 ${ctx.owner.name}만 보고, 다른 사람에게는 쇼다운 때 공개됩니다${immuneText(ctx.state, decl.immune, '플랍을 봄')}`);
    },
  },

  deathTax: {
    check: (ctx) => (ctx.state.taxers.includes(ctx.owner.id) ? '이미 선언했습니다.' : null),
    resolve(ctx, _params, decl) {
      const { state, owner } = ctx;
      state.taxers.push(owner.id);
      if (decl.immune.length) state.taxExempt[owner.id] = [...decl.immune];
      addLog(state, `죽음과 세금: 이제부터 게임이 끝날 때까지 ${owner.name}을(를) 뺀 모두가 액티브·공개형 증강을 쓸 때마다 은행에 1BB를 냅니다 (선언자 ${state.taxers.length}명)`);
    },
  },

  // ═════════════════════════ 2차 풀 ═════════════════════════

  thermometer: {
    check: opponentInHand,
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      exposeInfo(ctx, t, 'thermometer');
      const sum = t.hole.reduce((a, c) => a + rankOf(c), 0);
      note(ctx.state, ctx.owner, 'thermometer', `온도계: ${t.name}의 홀카드 숫자 합은 15 ${sum >= 15 ? '이상' : '미만'}`, undefined, t.id);
    },
  },

  radar: {
    check(ctx, params) {
      const err = needLive(ctx) ?? needSight(ctx);
      if (err) return err;
      const bi = params.boardIndex;
      const vis = visibleBoard(ctx.state, ctx.owner);
      if (typeof bi !== 'number' || !Number.isInteger(bi) || !vis[bi]) return '내가 볼 수 있는 보드 카드를 고르세요.';
      return null;
    },
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const card = state.board[params.boardIndex!];
      const r = rankOf(card);
      const n = state.players.filter((p) => p !== owner && live(p) && p.hole.some((c) => rankOf(c) === r)).length;
      note(state, owner, 'radar', `레이더: ${cardToken(card)}와 같은 숫자(${rankName(r)})의 홀카드를 가진 상대 ${n}명`, [card]);
    },
  },

  colorForecast: {
    check(ctx) {
      const err = needLive(ctx) ?? needSight(ctx);
      if (err) return err;
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || (state.street !== 'flop' && state.street !== 'turn')) return '플랍·턴 베팅 라운드에서만 쓸 수 있습니다.';
      if (state.toAct !== idxOf(state, owner.id)) return '내 차례(행동 전)에만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const card = state.board[state.boardRevealed];
      note(state, owner, 'forecast', `색채 예보: 다음 보드 카드(${state.street === 'flop' ? '턴' : '리버'})의 무늬는 ${SUIT_NAME[suitOf(card)]}`);
    },
  },

  leaderboard: {
    check(ctx) {
      const err = needLive(ctx) ?? needClearSight(ctx);
      if (err) return err;
      if (ctx.state.boardRevealed < 4) return '턴이 공개된 뒤에만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx) {
      const { rank, of } = standingOf(ctx.state, ctx.owner);
      note(ctx.state, ctx.owner, 'leaderboard', `순위표: 남은 ${of}명 중 ${rank}등`);
    },
  },

  destinyDraw: {
    // 다른 사람이 가져온 카드인지는 서버만 안다: 미리 알려 주지 않도록 반응 대기 후 적용할 때 확인한다
    check(ctx, params, atResolve) {
      const err = betweenHandsCheck(ctx);
      if (err) return err;
      const { state, owner } = ctx;
      if (owner.destinyCard) return '이미 다음 핸드 카드를 골랐습니다.';
      const c = params.card;
      if (!isCard(c)) return '받을 카드를 고르세요.';
      if (owner.keptCard === c || owner.lockerStored === c) return '이미 내가 가져가는 카드입니다.';
      if (atResolve && state.players.some((p) => p !== owner && (p.keptCard === c || p.lockerStored === c || p.destinyCard === c))) return '다른 사람이 가져온 카드라 고를 수 없습니다.';
      if (state.nextHand.freezeCard === c) return '동결된 카드는 고를 수 없습니다.';
      return null;
    },
    resolve(ctx, params) {
      ctx.owner.destinyCard = params.card!;
      note(ctx.state, ctx.owner, 'info', `데스티니 드로우: 다음 핸드에 ${cardToken(params.card!)}을(를) 홀카드로 받습니다.`, [params.card!]);
    },
  },

  blindDraw: {
    check(ctx, params) {
      const err = needLive(ctx);
      if (err) return err;
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.boardRevealed < 4) return '턴 공개 이후 베팅 라운드에서만 쓸 수 있습니다.';
      if (!ownCardsHidden(state, owner) && !validHoleIndex(owner, params.cardIndex)) return '버릴 카드를 고르세요.';
      if (!state.deck.length) return '덱에 남은 카드가 없습니다.';
      return null;
    },
    detail: () => '— 홀카드 1장을 덱 맨 위 카드로 교체',
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const hidden = ownCardsHidden(state, owner);
      const ci = hidden || !validHoleIndex(owner, params.cardIndex) ? state.rng.int(owner.hole.length) : params.cardIndex!;
      const old = owner.hole[ci];
      const fresh = state.deck.shift()!;
      owner.hole[ci] = fresh;
      owner.discarded.push(old);
      state.used.push({ card: old, kind: 'discard' });
      if (hidden) note(state, owner, 'info', '블라인드 드로우: 암전 중이라 무작위 1장을 교체했습니다.');
      else note(state, owner, 'info', `블라인드 드로우: ${cardToken(old)} → ${cardToken(fresh)}`, [old, fresh]);
    },
  },

  eitherOr: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'flop') return '플랍 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      const err = needSight(ctx);
      if (err) return err;
      if (state.players.some((p) => p.eitherOr)) return '이번 턴은 이미 양자택일 중입니다.';
      if (state.fixedIdx.includes(state.boardRevealed)) return '다음 카드는 이미 확정된 카드입니다.';
      if (!state.deck.length) return '덱에 남은 카드가 없습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const cards = [state.board[state.boardRevealed], state.deck.shift()!];
      owner.eitherOr = { cards, pick: null };
      note(state, owner, 'info', `양자택일: 턴 후보 ${cardsText(cards)} — 턴이 공개되기 전에 하나를 고르세요 (고르지 않으면 첫 번째)`, cards);
    },
  },

  lastFork: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'river') return '리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (!ownCardsHidden(state, owner) && !validHoleIndex(owner, params.cardIndex)) return '버릴 카드를 고르세요.';
      if (!state.deck.length) return '덱에 남은 카드가 없습니다.';
      return null;
    },
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const ci = validHoleIndex(owner, params.cardIndex) ? params.cardIndex! : state.rng.int(owner.hole.length);
      const old = owner.hole[ci];
      const fresh = state.deck.shift()!;
      owner.hole[ci] = fresh;
      state.used.push({ card: old, kind: 'shown' });
      addLog(state, `마지막 갈림길: ${owner.name}이(가) 홀카드 ${cardToken(old)}을(를) 공개하고 버린 뒤 새 카드 1장을 받았습니다`);
      if (ownCardsHidden(state, owner)) note(state, owner, 'info', '마지막 갈림길: 새 카드를 받았습니다 (암전 중)');
      else note(state, owner, 'info', `마지막 갈림길: 새 카드 ${cardToken(fresh)}`, [fresh]);
    },
  },

  blackjack: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'river') return '리버 공개 직후(리버 베팅 전)에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      const err = needSight(ctx);
      if (err) return err;
      if (owner.blackjackOn) return '이미 발동했습니다.';
      if (!blackjackCards([...owner.hole, ...evalBoard(state)])) return '지금 카드로는 21을 만들 수 없습니다.';
      return null;
    },
    resolve(ctx) {
      ctx.owner.blackjackOn = true;
      const bj = blackjackCards([...ctx.owner.hole, ...evalBoard(ctx.state)])!;
      note(ctx.state, ctx.owner, 'info', `블랙잭: ${cardsText(bj)} = 21 — 가장 낮은 풀하우스와 동급으로 인정됩니다 (원래 족보가 더 높으면 원래 족보)`, bj);
    },
  },

  circuitBreaker: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.toAct !== idxOf(state, owner.id)) return '내 차례에만 선언할 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (state.round.raiseCap !== null) return '이미 다시 시작한 라운드입니다.';
      if (state.round.raises < 3) return `이번 라운드 레이즈가 3번 이상이어야 합니다 (지금 ${state.round.raises}번).`;
      return null;
    },
    resolve: (ctx) => ctx.ops.restartRound(),
  },

  bet: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.effects.bomb) return '프리플랍에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (owner.actedPreflop) return '프리플랍 내 첫 행동 전에만 쓸 수 있습니다.';
      const c = params.choice;
      if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > 7) return '예측할 족보 종류를 고르세요.';
      return null;
    },
    resolve(ctx, params) {
      const names = ['하이카드', '원페어', '투페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드 이상'];
      ctx.owner.betPrediction = params.choice!;
      note(ctx.state, ctx.owner, 'bet', `내기할래?: 이번 핸드 우승 족보를 「${names[params.choice!]}」(으)로 예측했습니다.`);
    },
  },

  rumor: {
    check(ctx, params) {
      if (!active(ctx.owner)) return '게임에 참여하고 있지 않습니다.';
      return isAugmentId(params.augment) ? null : '소문낼 증강을 고르세요.';
    },
    detail: (_ctx, p) => (p.augment ? `— 「${AUGMENTS[p.augment].name}」` : ''),
    resolve(ctx, params) {
      addLog(ctx.state, `📢 소문: 이 테이블 누군가 「${AUGMENTS[params.augment!].name}」 증강을 가지고 있다`);
    },
  },

  ironWall: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop') return '핸드 시작 시(프리플랍)에만 선언할 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (owner.actedPreflop) return '프리플랍 내 첫 행동 전에만 선언할 수 있습니다.';
      if (owner.ironWall) return '이미 선언했습니다.';
      return null;
    },
    resolve(ctx) {
      ctx.owner.ironWall = true;
      addLog(ctx.state, `철벽: ${ctx.owner.name}은(는) 이번 핸드 동안 지목형 증강의 대상이 될 수 없습니다`);
    },
  },

  padlock: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting') return '베팅 라운드 중에만 쓸 수 있습니다.';
      if (state.round.locked) return '이미 잠긴 라운드입니다.';
      if (state.round.actions > 0) return '베팅 라운드가 시작되고 아무도 행동하기 전에만 선언할 수 있습니다.';
      if (!active(ctx.owner)) return '게임에 참여하고 있지 않습니다.';
      return null;
    },
    resolve(ctx) {
      ctx.state.round.locked = true;
      addLog(ctx.state, '자물쇠: 이번 베팅 라운드 동안 모두 액티브·공개형 증강을 쓸 수 없습니다 (카운터 스펠 포함)');
    },
  },

  bombPot: {
    check(ctx) {
      return betweenHandsCheck(ctx) ?? (ctx.state.bombNext ? '이미 다음 핸드가 폭탄 팟입니다.' : null);
    },
    resolve(ctx) {
      ctx.state.bombNext = true;
      addLog(ctx.state, `폭탄 팟: 다음 핸드는 블라인드 대신 전원이 3BB를 내고 바로 플랍부터 시작합니다`);
    },
  },

  underdog: {
    check: betweenHandsCheck,
    resolve(ctx) {
      ctx.state.underdogLeft += 3;
      addLog(ctx.state, '언더독: 다음 핸드부터 3핸드 동안 족보 순위가 뒤바뀌어 가장 낮은 패가 승리합니다');
    },
  },

  blindDart: {
    check(ctx, params) {
      const err = preflopMyTurn(ctx);
      if (err) return err;
      const t = targetOf(ctx, params);
      if (!t || !live(t)) return '핸드에 남아 있는 상대를 고르세요.';
      return targetable(t);
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params, decl) {
      const { state } = ctx;
      const t = targetOf(ctx, params)!;
      if (decl.immune.includes(t.id)) return addLog(state, `실명 다트: ${t.name}이(가) 면역으로 막았습니다`);
      if (t.ironWall) return addLog(state, `실명 다트: ${t.name}의 철벽에 막혔습니다`);
      state.effects.blindDarted.push(t.id);
      addLog(state, `실명 다트: ${t.name}은(는) 이번 핸드 동안 보드를 볼 수 없습니다 (쇼다운 때 공개)`);
    },
  },

  getOut: {
    check(ctx, params) {
      const err = preflopMyTurn(ctx);
      if (err) return err;
      if (ctx.state.players.filter(live).length < 3) return '핸드에 3명 이상 남아 있을 때만 쓸 수 있습니다.';
      const t = targetOf(ctx, params);
      if (!t || !live(t)) return '핸드에 남아 있는 상대를 고르세요.';
      return targetable(t);
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params, decl) {
      const { state, ops } = ctx;
      const t = targetOf(ctx, params)!;
      if (decl.immune.includes(t.id)) return addLog(state, `너 나가: ${t.name}이(가) 면역으로 막았습니다`);
      if (t.ironWall) return addLog(state, `너 나가: ${t.name}의 철벽에 막혔습니다`);
      addLog(state, `너 나가: ${t.name}을(를) 이번 핸드에서 내보냅니다`);
      if (blocksForcedFold(ctx, t)) return;
      ops.fold(t, true);
    },
  },

  highCardDuel: {
    check: preflopMyTurn,
    resolve: (ctx) => ctx.ops.highCardDuel(),
  },

  restart: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.toAct !== idxOf(state, owner.id)) return '쇼다운 전, 베팅 중 내 차례에만 선언할 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (state.effects.restarted) return '다시 시작한 핸드에서는 쓸 수 없습니다.';
      return null;
    },
    resolve: (ctx) => ctx.ops.restartHand(ctx.owner),
  },

  // ═════════════════════════ 3차 풀: 시야·시간 ═════════════════════════

  glasses: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.round.actions > 0) return '프리플랍 베팅이 시작되기 전(아무도 행동하기 전)에만 선언할 수 있습니다.';
      if (!live(ctx.owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx, _params, decl) {
      const e = ctx.state.effects;
      if (!e.glasses.includes(ctx.owner.id)) e.glasses.push(ctx.owner.id);
      for (const id of decl.immune) if (!e.glassesImmune.includes(id)) e.glassesImmune.push(id);
      if (!e.glassesSeq) e.glassesSeq = ctx.state.logSeq + 1;
      addLog(ctx.state, `안경 없어서 잘 안보여: 이번 핸드 동안 ${ctx.owner.name}을(를) 뺀 모두에게 보드 무늬가 안 보이고 금액은 대략값으로 보입니다${immuneText(ctx.state, decl.immune, '또렷하게 봄')}`);
    },
  },

  heaven: {
    check: (ctx) => (active(ctx.owner) ? null : '게임에 참여하고 있지 않습니다.'),
    resolve(ctx, _params, decl) {
      const { state, owner } = ctx;
      state.heaven.push({ by: owner.id, startHand: state.handNumber, immune: [...decl.immune] });
      addLog(state, `메이드 인 헤븐: 다음 핸드부터 ${owner.name}을(를) 뺀 모두의 행동 시간이 매 핸드 5초씩 줄어듭니다 (최소 5초, 다음 블라인드 레벨까지)${immuneText(state, decl.immune, '원래 시간 유지')}`);
    },
  },

  // ═════════════════════════ 3차 풀: 보드·팟 구조 ═════════════════════════

  plusOne: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'river') return '리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (state.board.length >= 7 || state.deck.length < (state.board2 ? 2 : 1)) return '보드를 더 늘릴 수 없습니다.';
      return null;
    },
    resolve: (ctx) => ctx.ops.addBoardCard('플러스 원'),
  },

  capitalism: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'flop') return '플랍 공개 후 플랍 베팅 라운드에서만 선언할 수 있습니다.';
      if (state.effects.capitalism) return '이미 자본주의가 걸려 있습니다.';
      return needLive(ctx);
    },
    resolve(ctx) {
      ctx.state.effects.capitalism = true;
      addLog(ctx.state, '자본주의: 플랍·턴 베팅 라운드가 끝날 때마다 가장 크게 베팅·레이즈한 사람이 보드 카드를 1장 더 깔지 정합니다');
    },
  },

  reverseRiver: {
    check: (ctx) => betweenHandsCheck(ctx) ?? (ctx.state.nextHand.reverse ? '이미 다음 핸드에 걸려 있습니다.' : null),
    resolve(ctx) {
      ctx.state.nextHand.reverse = true;
      addLog(ctx.state, '거꾸로 강을 거슬러: 다음 핸드는 보드가 1장 → 1장 → 3장 순서로 공개됩니다');
    },
  },

  doubleBoard: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.boardRevealed > 0) return '플랍이 깔리기 전(프리플랍)에만 선언할 수 있습니다.';
      if (state.board2) return '이미 보드가 2세트입니다.';
      if (state.deck.length < state.board.length) return '덱에 남은 카드가 부족합니다.';
      return needLive(ctx);
    },
    resolve(ctx) {
      const { state } = ctx;
      state.board2 = state.deck.splice(0, state.board.length);
      addLog(state, '더블 보드: 보드를 2세트 깔고, 각 보드의 승자가 팟을 절반씩 나눕니다');
    },
  },

  twoFates: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'turn') return '턴 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (state.board2) return '이미 보드가 2세트입니다.';
      if (state.players.filter(live).length < 2 || state.players.filter(canAct).length > 1) return '남은 플레이어가 모두 올인해 더 베팅할 수 없을 때만 쓸 수 있습니다.';
      if (state.deck.length < state.board.length - state.boardRevealed) return '덱에 남은 카드가 부족합니다.';
      return null;
    },
    resolve(ctx) {
      const { state } = ctx;
      state.board2 = [...state.board.slice(0, state.boardRevealed), ...state.deck.splice(0, state.board.length - state.boardRevealed)];
      state.effects.twoFates = true;
      addLog(state, '두 번의 운명: 리버를 두 번 따로 뽑아 각 결과에 팟의 절반을 배정합니다');
    },
  },

  prophecy: {
    check: (ctx) => betweenHandsCheck(ctx) ?? (ctx.state.nextHand.prophecy ? '이미 다음 핸드에 걸려 있습니다.' : null),
    resolve(ctx) {
      ctx.state.nextHand.prophecy = true;
      addLog(ctx.state, '미리 온 결말: 다음 핸드 시작 때 덱에서 1장을 공개해 리버로 예약합니다');
    },
  },

  turnRiver: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'flop') return '플랍 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      const err = needSight(ctx);
      if (err) return err;
      const [a, b] = turnRiverIdx(state);
      if (b >= state.board.length) return '남은 보드 카드가 부족합니다.';
      if (state.fixedIdx.includes(a) || state.fixedIdx.includes(b) || state.players.some((p) => p.eitherOr || p.turnRiver)) return '턴·리버 카드가 이미 확정되어 있습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const idx = turnRiverIdx(state);
      const cards = idx.map((i) => state.board[i]);
      owner.turnRiver = { idx, cards, swap: null };
      for (const i of idx) state.fixedIdx.push(i);
      note(state, owner, 'info', `턴과 리버 사이: 턴 ${cardToken(cards[0])}, 리버 ${cardToken(cards[1])} — 순서를 바꿀지 정하세요 (정하지 않으면 그대로)`, cards);
    },
  },

  highLow: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.boardRevealed > 0) return '플랍이 깔리기 전(프리플랍)에만 선언할 수 있습니다.';
      if (state.effects.highLow) return '이미 하이로우입니다.';
      return needLive(ctx);
    },
    resolve(ctx) {
      ctx.state.effects.highLow = true;
      addLog(ctx.state, '하이로우: 이번 팟은 가장 높은 패와 가장 낮은 패가 반씩 나눕니다');
    },
  },

  freeze: {
    check(ctx, params, atResolve) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'handEnd' || !state.result) return '핸드가 끝난 뒤(결과 화면)에만 쓸 수 있습니다.';
      if (!active(owner)) return '게임에 참여하고 있지 않습니다.';
      const bi = params.boardIndex;
      const board = state.result.board;
      if (typeof bi !== 'number' || !Number.isInteger(bi) || bi < 0 || bi >= board.length) return '공개된 보드 카드를 고르세요.';
      const c = board[bi];
      if (state.nextHand.freezeCard) return '이미 동결된 카드가 있습니다.';
      if (atResolve && state.players.some((p) => p.keptCard === c || p.lockerStored === c || p.destinyCard === c)) return '다른 효과가 이미 가져가는 카드입니다.';
      return null;
    },
    detail: (ctx, p) => `— ${typeof p.boardIndex === 'number' && ctx.state.result ? cardToken(ctx.state.result.board[p.boardIndex]) : ''}`,
    resolve(ctx, params) {
      const c = ctx.state.result!.board[params.boardIndex!];
      ctx.state.nextHand.freezeCard = c;
      addLog(ctx.state, `동결: ${cardToken(c)}이(가) 다음 핸드 플랍에 반드시 포함됩니다`);
    },
  },

  magnet: {
    check(ctx, params) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'flop') return '플랍 공개 후 플랍 베팅 라운드에서만 쓸 수 있습니다.';
      if (state.effects.magnet) return '이미 자석이 걸려 있습니다.';
      const c = params.choice;
      if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > 3) return '무늬를 고르세요.';
      return needLive(ctx);
    },
    detail: (_ctx, p) => `— ${SUIT_NAME[SUITS[p.choice ?? 0]]}`,
    resolve(ctx, params) {
      const suit = SUITS[params.choice!];
      ctx.state.effects.magnet = { suit, used: false };
      addLog(ctx.state, `자석: ${SUIT_NAME[suit]} — 턴·리버에서 이 무늬가 아닌 카드가 처음 나오면 버리고 다시 뽑습니다`);
    },
  },

  swapBoard: {
    check(ctx, params) {
      const err = needLive(ctx);
      if (err) return err;
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || (state.street !== 'turn' && state.street !== 'river')) return '턴 공개 이후 베팅 라운드에서만 쓸 수 있습니다.';
      if (!validHoleIndex(owner, params.cardIndex)) return '바꿀 내 홀카드를 고르세요.';
      const bi = params.boardIndex;
      if (typeof bi !== 'number' || !Number.isInteger(bi) || bi < 0 || bi >= state.boardRevealed) return '바꿀 보드 카드를 고르세요.';
      return null;
    },
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const ci = params.cardIndex!;
      const bi = params.boardIndex!;
      const mine = owner.hole[ci];
      const boardCard = state.board[bi];
      owner.hole[ci] = boardCard;
      state.board[bi] = mine;
      logBoard(state, `맞바꾸기: ${owner.name}이(가) 홀카드 ${cardToken(mine)}와(과) 보드 ${cardToken(boardCard)}를 바꿨습니다`, `맞바꾸기: ${owner.name}이(가) 홀카드 1장과 보드 ${bi + 1}번째 카드를 바꿨습니다`, false);
    },
  },

  lastStand: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop') return '프리플랍에만 선언할 수 있습니다.';
      if (!live(owner) || owner.actedPreflop) return '프리플랍 내 첫 행동 전에만 선언할 수 있습니다.';
      if (state.effects.lastStand) return '이미 배수진입니다.';
      return null;
    },
    resolve(ctx, _params, decl) {
      ctx.state.effects.lastStand = true;
      ctx.state.effects.lastStandImmune = [...decl.immune];
      addLog(ctx.state, `배수진: 이번 핸드는 모두 폴드할 수 없고 체크·콜만 할 수 있습니다${immuneText(ctx.state, decl.immune, '폴드 가능')}`);
    },
  },

  sidePotBreaker: {
    check(ctx) {
      const { state, owner } = ctx;
      const r = state.result;
      if (basePhase(state) !== 'handEnd' || !r || !r.showdown) return '쇼다운이 끝난 뒤(결과 화면)에만 쓸 수 있습니다.';
      if (!owner.wentAllIn) return '내가 올인한 핸드에서만 쓸 수 있습니다.';
      if (!r.pots[0]?.winners.includes(owner.id)) return '메인 팟을 이겼을 때만 쓸 수 있습니다.';
      if (!r.pots.some((p, k) => k > 0 && !p.eligible.includes(owner.id) && p.amount > 0)) return '다른 플레이어들끼리 쌓은 사이드팟이 없습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const r = state.result!;
      let total = 0;
      for (const [k, pot] of r.pots.entries()) {
        if (k === 0 || pot.eligible.includes(owner.id)) continue;
        const take = Math.floor(pot.amount * 0.3);
        const each = Math.floor(take / pot.winners.length);
        pot.winners.forEach((id, i) => {
          const w = playerById(state, id)!;
          const amt = Math.min(w.chips, each + (i === 0 ? take - each * pot.winners.length : 0));
          w.chips -= amt;
          r.won[id] = (r.won[id] ?? 0) - amt;
          total += amt;
        });
      }
      owner.chips += total;
      r.won[owner.id] = (r.won[owner.id] ?? 0) + total;
      const text = `${owner.name}: 사이드 팟 브레이커 — 사이드팟의 30%인 ${total}칩을 가져옴`;
      r.extras.push(text);
      addLog(state, text);
    },
  },

  // ═════════════════════════ 3차 풀: 제안·응답 ═════════════════════════

  pickMe: {
    check(ctx, params) {
      const err = opponentInHand(ctx, params);
      if (err) return err;
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || (state.street !== 'flop' && state.street !== 'turn')) return '플랍·턴 베팅 라운드에서만 쓸 수 있습니다.';
      if (state.toAct !== idxOf(state, owner.id)) return '내 차례(행동 전)에만 쓸 수 있습니다.';
      if (!validHoleIndex(owner, params.cardIndex)) return '보여 줄 내 홀카드를 고르세요.';
      return respondBusy(state);
    },
    detail: (ctx, p) => `— ${nameOf(ctx.state, p.targetId ?? '')}에게 제안`,
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const t = targetOf(ctx, params)!;
      const card = owner.hole[params.cardIndex!];
      ctx.ops.startRespond({ kind: 'offer', augment: 'pickMe', ownerId: owner.id, participants: [t.id], params: { targetId: t.id, cardIndex: params.cardIndex, card } });
      if (!ownCardsHidden(state, owner)) addLog(state, `골라 봐: ${t.name}에게 보여 줄 카드 ${cardToken(card)}`, { to: [owner.id] });
    },
    respond: {
      error: (_ctx, _r, _p, a) => yesNo(a.accept),
      // 시간 초과는 거절
      fallback: () => ({ accept: false }),
      done(ctx, r) {
        const { state, owner } = ctx;
        const t = playerById(state, r.params.targetId)!;
        if (!r.answers[t.id]?.accept || !live(t) || !live(owner)) {
          addLog(state, `골라 봐: ${t.name}이(가) 제안을 거절했습니다`);
          return false;
        }
        const card = owner.hole.includes(r.params.card!) ? r.params.card! : owner.hole[r.params.cardIndex ?? 0];
        const paid = transfer(state, t, owner, 3 * bbOf(state));
        addLog(state, `골라 봐: ${t.name}이(가) 수락 — ${owner.name}에게 ${paid}칩을 내고 홀카드 1장을 봅니다`);
        note(state, t, 'info', `골라 봐: ${owner.name}의 홀카드 중 1장은 ${cardToken(card)}`, [card], owner.id);
        return false;
      },
    },
  },

  jointTransfer: {
    check(ctx, params) {
      const { state } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'flop') return '플랍 공개 직후 선언 기회에만 쓸 수 있습니다.';
      return opponentInHand(ctx, params) ?? respondBusy(state);
    },
    detail: (ctx, p) => `— ${nameOf(ctx.state, p.targetId ?? '')}에게 교환 제안`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      ctx.ops.startRespond({ kind: 'offer', augment: 'jointTransfer', ownerId: ctx.owner.id, participants: [t.id], params: { targetId: t.id } });
    },
    respond: {
      error(_ctx, r, p, a) {
        if (r.stage === 'offer') return yesNo(a.accept);
        return validHoleIndex(p, a.cardIndex) ? null : '건넬 홀카드를 고르세요.';
      },
      fallback: (ctx, r, p) => (r.stage === 'offer' ? { accept: false } : { cardIndex: ctx.state.rng.int(Math.max(1, p.hole.length)) }),
      done(ctx, r) {
        const { state, owner } = ctx;
        const t = playerById(state, r.params.targetId)!;
        if (r.stage === 'offer') {
          if (!r.answers[t.id]?.accept || !live(t) || !live(owner)) {
            addLog(state, `공동 환승: ${t.name}이(가) 교환을 거절했습니다`);
            return false;
          }
          addLog(state, `공동 환승: ${t.name}이(가) 수락 — 두 사람이 홀카드 1장씩을 비공개로 골라 맞바꿉니다`);
          r.stage = 'pick';
          r.participants = [owner.id, t.id];
          r.answers = {};
          return true;
        }
        if (!live(t) || !live(owner)) {
          addLog(state, '공동 환승: 한 사람이 핸드를 떠나 교환이 취소되었습니다');
          return false;
        }
        const ia = r.answers[owner.id]?.cardIndex ?? 0;
        const ib = r.answers[t.id]?.cardIndex ?? 0;
        const give = owner.hole[ia];
        const get = t.hole[ib];
        owner.hole[ia] = get;
        t.hole[ib] = give;
        note(state, owner, 'info', `공동 환승: ${cardToken(give)}을(를) 주고 ${cardToken(get)}을(를) 받았습니다`, [give, get], t.id);
        note(state, t, 'info', `공동 환승: ${cardToken(get)}을(를) 주고 ${cardToken(give)}을(를) 받았습니다`, [get, give], owner.id);
        addLog(state, `공동 환승: ${owner.name}와(과) ${t.name}이(가) 홀카드 1장씩을 맞바꿨습니다`);
        return false;
      },
    },
  },

  loanShark: {
    check(ctx, params) {
      const { state, owner } = ctx;
      const b = basePhase(state);
      if (b !== 'betting' && b !== 'discard' && b !== 'declare' && b !== 'handEnd') return '핸드 진행 중이나 핸드 결과 화면에서 쓸 수 있습니다.';
      if (!active(owner)) return '게임에 참여하고 있지 않습니다.';
      const t = targetOf(ctx, params);
      if (!t || !active(t)) return '빌려줄 상대를 고르세요.';
      if (owner.chips < 5 * bbOf(state)) return `빌려줄 칩(${5 * bbOf(state)})이 부족합니다.`;
      return respondBusy(state);
    },
    detail: (ctx, p) => `— ${nameOf(ctx.state, p.targetId ?? '')}에게 제안`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      ctx.ops.startRespond({ kind: 'offer', augment: 'loanShark', ownerId: ctx.owner.id, participants: [t.id], params: { targetId: t.id } });
    },
    respond: {
      error: (_ctx, _r, _p, a) => yesNo(a.accept),
      fallback: () => ({ accept: false }),
      done(ctx, r) {
        const { state, owner } = ctx;
        const t = playerById(state, r.params.targetId)!;
        if (!r.answers[t.id]?.accept || !active(t) || !active(owner)) {
          addLog(state, `사채업자: ${t.name}이(가) 제안을 거절했습니다`);
          return false;
        }
        const bb = bbOf(state);
        const lent = transfer(state, owner, t, 5 * bb);
        if (t.chips > 0 && !t.wentAllIn) t.allIn = false;
        // 2핸드 뒤 상환 (핸드 사이에 빌렸으면 다음 핸드부터 센다)
        const due = state.handNumber + (basePhase(state) === 'handEnd' ? 3 : 2);
        state.tasks.push({ kind: 'sharkRepay', playerId: t.id, otherId: owner.id, dueHand: due, amount: 7 * bb });
        addLog(state, `사채업자: ${t.name}이(가) ${owner.name}에게서 ${lent}칩을 빌렸습니다 (핸드 #${due} 시작 전에 ${7 * bb}칩 상환)`);
        return false;
      },
    },
  },

  infoAuction: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'flop') return '플랍 공개 후 플랍 베팅 라운드에서만 선언할 수 있습니다.';
      if (state.boardRevealed >= state.board.length) return '남은 보드 카드가 없습니다.';
      if (state.players.some((p) => p.eitherOr || p.turnRiver)) return '턴 카드가 이미 다른 효과로 정해지는 중입니다.';
      return needLive(ctx) ?? respondBusy(state);
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const ids = bidders(state, false);
      if (!ids.length) {
        addLog(state, '정보 경매: 입찰할 수 있는 사람이 없습니다');
        return;
      }
      addLog(state, `정보 경매: 턴 카드를 미리 볼 권리를 비공개로 입찰합니다 (0 = 불참, 최소 ${bbOf(state)})`);
      ctx.ops.startRespond({ kind: 'collect', augment: 'infoAuction', ownerId: owner.id, participants: ids, params: {} });
    },
    respond: {
      error: (ctx, _r, p, a) => bidError(ctx.state, p, a.bid),
      fallback: () => ({ bid: 0 }),
      done(ctx, r) {
        const { state } = ctx;
        const top = topBidder(state, r);
        if (!top) {
          addLog(state, '정보 경매: 입찰자가 없어 유찰되었습니다');
          return false;
        }
        const paid = payToPot(state, top.p, top.bid);
        const i = state.boardRevealed;
        const card = state.board[i];
        // 본 카드가 그대로 나오도록 고정 (자석·되감기 등으로 바뀌지 않음)
        if (!state.fixedIdx.includes(i)) state.fixedIdx.push(i);
        addLog(state, `정보 경매: ${top.p.name}이(가) ${paid}칩에 낙찰 (낙찰금은 팟으로)`);
        if (maskFor(state, top.p).suits) note(state, top.p, 'info', `정보 경매: 다음 보드 카드는 ${rankName(rankOf(card))} (무늬는 안 보임)`, undefined);
        else note(state, top.p, 'info', `정보 경매: 다음 보드 카드는 ${cardToken(card)}`, [card]);
        return false;
      },
    },
  },

  cardAuction: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'flop') return '플랍 공개 후 플랍 베팅 라운드에서만 선언할 수 있습니다.';
      if (state.auctionCard) return '이번 핸드에는 이미 카드 경매가 열렸습니다.';
      if (!state.deck.length) return '덱에 남은 카드가 없습니다.';
      return needLive(ctx) ?? respondBusy(state);
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const card = state.deck.shift()!;
      state.auctionCard = card;
      logBoard(state, `카드 경매: ${cardToken(card)} — 비공개로 입찰하세요 (0 = 불참, 최소 ${bbOf(state)})`, '카드 경매: 덱에서 1장이 공개되었습니다 (보드를 볼 수 없음)', false);
      const ids = bidders(state, true);
      if (!ids.length) {
        state.used.push({ card, kind: 'shown' });
        addLog(state, '카드 경매: 입찰할 수 있는 사람이 없습니다');
        return;
      }
      ctx.ops.startRespond({ kind: 'collect', augment: 'cardAuction', ownerId: owner.id, participants: ids, params: { card } });
    },
    respond: {
      error(ctx, _r, p, a) {
        const err = bidError(ctx.state, p, a.bid);
        if (err) return err;
        if (a.bid && a.cardIndex !== undefined && !validHoleIndex(p, a.cardIndex)) return '바꿀 홀카드를 고르세요.';
        return null;
      },
      fallback: () => ({ bid: 0 }),
      done(ctx, r) {
        const { state } = ctx;
        const card = r.params.card!;
        const top = topBidder(state, r);
        if (!top) {
          state.used.push({ card, kind: 'shown' });
          addLog(state, '카드 경매: 입찰자가 없어 유찰되었습니다');
          return false;
        }
        const w = top.p;
        const paid = payToPot(state, w, top.bid);
        const ci = r.answers[w.id]?.cardIndex;
        const idx = validHoleIndex(w, ci) ? ci : state.rng.int(w.hole.length);
        const old = w.hole[idx];
        w.hole[idx] = card;
        w.discarded.push(old);
        state.used.push({ card: old, kind: 'discard' });
        addLog(state, `카드 경매: ${w.name}이(가) ${paid}칩에 낙찰 — 공개된 카드를 홀카드 1장과 바꿨습니다 (낙찰금은 팟으로)`);
        note(state, w, 'info', `카드 경매: ${cardToken(old)}을(를) 버리고 ${cardToken(card)}을(를) 받았습니다`, [old, card]);
        return false;
      },
    },
  },

  truthGame: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'river') return '리버 베팅 라운드에서만 쓸 수 있습니다.';
      if (state.toAct !== idxOf(state, owner.id) || !live(owner)) return '내 차례에만 쓸 수 있습니다.';
      if (owner.truthClaim !== null) return '이미 선언했습니다.';
      const c = params.choice;
      return isInt(c) && c >= 0 && c <= 7 ? null : '족보 종류를 고르세요.';
    },
    detail: (_ctx, p) => `— "내 패는 ${truthNames[p.choice ?? 0]} 이상"`,
    resolve(ctx, params) {
      ctx.owner.truthClaim = params.choice!;
    },
  },

  staredown: {
    check(ctx, params) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'river') return '리버 베팅 라운드에서만 쓸 수 있습니다.';
      const err = opponentInHand(ctx, params);
      if (err) return err;
      if (state.staredown) return '이번 핸드에는 이미 눈싸움이 있었습니다.';
      return targetable(targetOf(ctx, params)!) ?? respondBusy(state);
    },
    detail: (ctx, p) => `— ${nameOf(ctx.state, p.targetId ?? '')}와(과) 눈싸움`,
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const t = targetOf(ctx, params)!;
      addLog(state, `눈싸움: ${owner.name}와(과) ${t.name}이(가) 상대보다 "강함/약함"을 동시에 비공개로 선언합니다`);
      ctx.ops.startRespond({ kind: 'collect', augment: 'staredown', ownerId: owner.id, participants: [owner.id, t.id], params: { targetId: t.id } });
    },
    respond: {
      error: (_ctx, _r, _p, a) => (a.choice === 0 || a.choice === 1 ? null : '"강함" 또는 "약함"을 고르세요.'),
      fallback: (ctx) => ({ choice: ctx.state.rng.int(2) }),
      done(ctx, r) {
        const { state, owner } = ctx;
        const t = playerById(state, r.params.targetId)!;
        const claims: Record<string, number> = { [owner.id]: r.answers[owner.id]?.choice ?? 0, [t.id]: r.answers[t.id]?.choice ?? 0 };
        state.staredown = { a: owner.id, b: t.id, claims };
        for (const p of [owner, t]) addLog(state, `눈싸움: 내 선언은 "${claims[p.id] ? '강함' : '약함'}" (쇼다운 때 공개)`, { to: [p.id] });
        addLog(state, '눈싸움: 두 사람 모두 선언을 마쳤습니다 (둘 다 쇼다운에 가면 공개)');
        return false;
      },
    },
  },

  sealedContract: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'river') return '리버 베팅 라운드에서만 쓸 수 있습니다.';
      if (state.toAct !== idxOf(state, owner.id) || !live(owner)) return '내 차례(베팅·레이즈 직전)에만 쓸 수 있습니다.';
      if (owner.contract !== null) return '이미 계약했습니다.';
      return params.choice === 0 || params.choice === 1 ? null : '"전원 폴드" 또는 "한 명 이상 콜"을 고르세요.';
    },
    // 고른 내용은 비공개: 공개 로그에는 계약 사실만
    resolve(ctx, params) {
      const { state, owner } = ctx;
      owner.contract = params.choice!;
      addLog(state, `밀봉 계약: 내 예측은 "${params.choice ? '한 명 이상 콜' : '전원 폴드'}" (핸드가 끝나면 공개)`, { to: [owner.id] });
    },
  },

  nameIt: {
    check(ctx, params, atResolve) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'preShowdown') return '리버 베팅이 끝난 뒤 쇼다운 직전 선언 기회에만 쓸 수 있습니다.';
      const err = opponentInHand(ctx, params);
      if (err) return err;
      const t = targetOf(ctx, params)!;
      if (state.nameItWinner) return '이미 명추리가 성공했습니다.';
      if (!isCard(params.card)) return '부를 카드를 고르세요.';
      // 대상 지목 가능 여부는 선언 시점에만 (반응 대기 중 바뀐 정보로 거절하지 않음)
      return targetable(t) ?? (atResolve ? null : knownTargetError(state, owner, t));
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const t = targetOf(ctx, params)!;
      const card = params.card!;
      const known = knownCardsFor(state, owner, t).includes(card);
      if (!known && t.hole.includes(card)) {
        state.nameItWinner = owner.id;
        // 맞힌 카드는 모두에게 공개된다
        state.used.push({ card, kind: 'called' });
        addLog(state, `명추리 성공: ${owner.name}이(가) ${t.name}의 홀카드 ${cardToken(card)}을(를) 맞혔습니다 — 참여할 수 있는 팟을 모두 가져갑니다`);
        return;
      }
      const paid = transfer(state, owner, t, 2 * bbOf(state));
      // 틀린 카드는 다른 사람의 카드일 수 있으므로 공개하지 않는다
      addLog(state, `명추리 실패: ${owner.name}이(가) 부른 카드는 ${known ? '이미 알려진 카드라 인정되지 않습니다' : `${t.name}의 카드가 아닙니다`} — 폴드하고 ${t.name}에게 ${paid}칩을 냅니다`);
      addLog(state, `명추리: 내가 부른 카드 ${cardToken(card)}`, { to: [owner.id] });
      ctx.ops.fold(owner, false);
    },
  },

  // ═════════════════════════ 3차 풀: 좌석·증강 흐름 ═════════════════════════

  augShuffle: {
    check: (ctx) => betweenHandsCheck(ctx) ?? (ctx.state.players.filter(active).length < 2 ? '넘길 사람이 없습니다.' : null),
    resolve(ctx, _params, decl) {
      const { state } = ctx;
      // 면역으로 빠진 사람은 주고받지 않는다
      const ring = state.players.filter((p) => active(p) && !decl.immune.includes(p.id));
      const moved = shuffleAugments(state, ring);
      addLog(state, `증강 셔플: ${moved ? '모두 보유 증강 1개씩을 왼쪽 사람에게 넘겼습니다' : '넘길 수 있는 증강이 없습니다'}${immuneText(state, decl.immune, '주고받지 않음')}`);
    },
  },

  loan: {
    check(ctx) {
      const { state, owner } = ctx;
      if (state.phase === 'gameOver' || !active(owner)) return '게임에 참여하고 있지 않습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const bb = bbOf(state);
      owner.chips += 20 * bb;
      state.stats.bankChips += 20 * bb;
      const due = state.handNumber + (handInProgress(state) ? 5 : 6);
      state.tasks.push({ kind: 'loanRepay', playerId: owner.id, dueHand: due, amount: 25 * bb });
      addLog(state, `대출: ${owner.name}이(가) 은행에서 ${20 * bb}칩을 빌렸습니다 (핸드 #${due} 시작 전에 ${25 * bb}칩 상환)`);
    },
  },

  // 면제권: 블라인드 차례에 엔진이 자동으로 선언한다
  exemption: {
    check: (ctx) => (ctx.owner.inHand ? null : '핸드에 참여하지 않았습니다.'),
    detail: (_ctx, p) => `— ${p.blind === 'SB' ? '스몰' : '빅'} 블라인드 면제`,
    resolve(ctx, params) {
      ctx.owner.lastAction = `${params.blind} 면제`;
      addLog(ctx.state, `${ctx.owner.name}: ${params.blind} 면제`);
    },
    onCountered(ctx, params) {
      const { bb, sb } = currentBlinds(ctx.state);
      const paid = putChips(ctx.owner, params.blind === 'SB' ? sb : bb);
      ctx.owner.blindPosted += paid;
      ctx.state.round.startBets[ctx.owner.id] = ctx.owner.streetBet;
      ctx.owner.lastAction = `${params.blind} ${ctx.owner.streetBet}`;
    },
  },
};

// ───────────────────────── 패시브 효과 ─────────────────────────

function revealPassive(ctx: Ctx, detail: string): void {
  countUse(ctx.state, ctx.aug.id);
  announceNamed(ctx.state, ctx.owner, ctx.aug, '발동', detail);
}

export const PASSIVE: Partial<Record<AugmentId, PassiveEffect>> = {
  thirdHand: { holeCards: 3 },

  insurance: {
    onFold(ctx) {
      const { state, owner } = ctx;
      if (state.street === 'preflop') return;
      const paid = owner.contributed + owner.mulliganFee;
      const refund = Math.floor(paid * 0.25);
      if (refund <= 0) return;
      const fromBets = Math.min(refund, owner.contributed);
      owner.contributed -= fromBets;
      owner.streetBet = Math.max(0, owner.streetBet - fromBets);
      const fromDead = Math.min(refund - fromBets, state.deadMoney);
      state.deadMoney -= fromDead;
      owner.chips += fromBets + fromDead;
      revealPassive(ctx, `— 낸 칩 ${paid}의 25%인 ${fromBets + fromDead}칩을 팟에서 환급`);
    },
  },

  observer: {
    onHandEnd(ctx) {
      const { state, owner } = ctx;
      if (owner.out) return;
      const folded = state.players.filter((f) => f !== owner && f.inHand && f.folded && f.hole.length > 0);
      for (const f of folded) note(state, owner, 'observer', `관찰자: ${f.name}의 폴드한 홀카드 ${cardsText(f.hole)}`, [...f.hole], f.id);
      if (folded.length) countUse(state, 'observer');
    },
  },

  highRisk: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      if (!owner.inHand || owner.folded || !owner.wentAllIn) return;
      const w = result.won[owner.id] ?? 0;
      if (w > 0) {
        const bonus = Math.floor(w * 0.2);
        owner.chips += bonus;
        state.stats.bankChips += bonus;
        result.extras.push(`${owner.name}: 하이리스크 보너스 +${bonus} (은행)`);
        revealPassive(ctx, `— 올인 승리 보너스 ${bonus}칩 (은행 지급)`);
      } else {
        owner.skipPicks++;
        revealPassive(ctx, '— 올인 패배: 다음 증강 선택 기회 1번 상실');
      }
    },
  },

  attachment: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      if (!result.showdown || !live(owner) || owner.out || (result.won[owner.id] ?? 0) <= 0 || !owner.hole.length) return;
      owner.attachPending = true;
      addLog(state, '애착: 쇼다운에서 이겼습니다. 다음 핸드로 가져갈 홀카드 1장을 고르세요.', { to: [owner.id] });
    },
  },

  shepherd: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      if (!result.showdown || !owner.shepherdLied || !result.entries.some((e) => e.id === owner.id)) return;
      const others = result.entries.filter((e) => e.id !== owner.id).map((e) => playerById(state, e.id)!);
      const fine = Math.min(2 * currentBlinds(state).bb, owner.chips);
      const lie = owner.shepherdShown.filter((c) => !owner.hole.includes(c));
      if (others.length && fine > 0) {
        owner.chips -= fine;
        const share = Math.floor(fine / others.length);
        let rem = fine - share * others.length;
        for (const o of others) {
          o.chips += share + (rem > 0 ? 1 : 0);
          if (rem > 0) rem--;
        }
      }
      const text = `${owner.name}의 양치기 소년 거짓 공개(${cardsText(lie)})가 드러남 — 벌금 ${fine}칩을 ${others.map((o) => o.name).join(', ')}에게 나눠 줌`;
      result.extras.push(text);
      addLog(state, text);
    },
  },

  disinfo: {
    onInfoExposed(ctx, looker, kind) {
      const { state, owner, aug } = ctx;
      if (kind === 'thermometer' || (aug.usesLeft ?? 0) <= 0) return;
      aug.usesLeft = 0;
      countUse(state, 'disinfo');
      addLog(state, `역정보 발동: ${looker.name}의 정보형 증강에 가짜 결과를 보여 줬습니다.`, { to: [owner.id] });
      return 'fake';
    },
  },

  mirror: {
    onInfoExposed(ctx, looker, kind) {
      const { state, owner } = ctx;
      if (kind === 'thermometer') return;
      countUse(state, 'mirror');
      let info: string;
      let cards: Card[] | undefined;
      if (kind === 'clairvoyance') {
        if (!looker.hole.length) return;
        const c = pickOne(looker.hole, state.rng);
        cards = [c];
        info = `${looker.name}의 홀카드 중 1장은 ${cardToken(c)}`;
      } else if (kind === 'thermal') {
        info = `${looker.name}의 홀카드 — ${hiLoText(looker.hole)}`;
      } else {
        info = `${looker.name} — ${realMade(state, looker) ? '메이드 핸드입니다' : '메이드 핸드가 아닙니다'}`;
      }
      note(state, owner, 'mirror', `거울: ${looker.name}이(가) 정보형 증강으로 나를 확인했습니다. ${info}`, cards, looker.id);
    },
  },

  traceback: {
    onInfoExposed(ctx, looker, kind) {
      countUse(ctx.state, 'traceback');
      note(ctx.state, ctx.owner, 'traceback', `역추적: ${looker.name}이(가) 나에게 「${INFO_NAME[kind]}」을(를) 썼습니다.`, undefined, looker.id);
    },
  },

  locker: {
    onFold(ctx) {
      if (ctx.owner.hole.length) {
        ctx.owner.lockerPending = true;
        addLog(ctx.state, '보관함: 핸드가 끝나면 보관할 홀카드 1장을 고르세요.', { to: [ctx.owner.id] });
      }
    },
  },

  lateBloomer: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      if (!active(owner)) return;
      const won = result.won[owner.id] ?? 0;
      if (won <= 0) {
        if (result.showdown && result.entries.some((e) => e.id === owner.id)) owner.lateLosses++;
        return;
      }
      if (owner.lateLosses < 3) {
        owner.lateLosses = 0;
        return;
      }
      const bonus = Math.min(Math.floor(won * 0.5), 20 * currentBlinds(state).bb);
      const payers = state.players.filter((p) => p !== owner && active(p) && p.chips > 0);
      const share = payers.length ? Math.floor(bonus / payers.length) : 0;
      let got = 0;
      for (const p of payers) {
        const pay = Math.min(share, p.chips);
        p.chips -= pay;
        got += pay;
      }
      owner.chips += got;
      owner.lateLosses = 0;
      result.extras.push(`${owner.name}: 왕귀 +${got} (남은 플레이어가 나눠 냄)`);
      revealPassive(ctx, `— 3번 진 뒤 첫 승리: ${got}칩을 남은 플레이어에게서 받음`);
    },
  },

  totem: {
    onHandEnd(ctx, result) {
      const { state, owner, aug } = ctx;
      if (!result.showdown || owner.chips > 0 || !owner.wentAllIn || (aug.usesLeft ?? 0) <= 0) return;
      if (!result.entries.some((e) => e.id === owner.id)) return;
      const need = 10 * currentBlinds(state).bb;
      let got = 0;
      const winners = Object.entries(result.won)
        .filter(([id, w]) => id !== owner.id && w > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => playerById(state, id)!);
      for (const w of winners) {
        const take = Math.min(need - got, w.chips);
        w.chips -= take;
        got += take;
        if (got >= need) break;
      }
      if (got <= 0) return;
      owner.chips += got;
      aug.usesLeft = 0;
      result.extras.push(`${owner.name}: 불사의 토템 — 탈락하지 않고 ${got}칩을 남김`);
      revealPassive(ctx, `— 승자의 몫에서 ${got}칩을 남겨 받고 계속합니다`);
    },
  },

  // 진실 게임: 콜한 상대(쇼다운 참가자) 각각과 3BB 정산
  truthGame: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      const claim = owner.truthClaim;
      const me = result.entries.find((e) => e.id === owner.id);
      if (claim === null || !result.showdown || !me) return;
      const others = result.entries.filter((e) => e.id !== owner.id).map((e) => playerById(state, e.id)!);
      if (!others.length) return;
      const cat = Math.min(Category.Quads, me.score[0]);
      const truth = cat >= claim;
      const amt = 3 * bbOf(state);
      let total = 0;
      for (const o of others) total += truth ? transfer(state, o, owner, amt) : transfer(state, owner, o, amt);
      const text = `${owner.name}: 진실 게임 "${truthNames[claim]} 이상" — ${truth ? `진실, ${total}칩을 받음` : `거짓, ${total}칩을 냄`}`;
      result.extras.push(text);
      addLog(state, text);
    },
  },

  // 눈싸움: 둘 다 쇼다운에 가면 공개, 한 명만 정직했다면 2BB
  staredown: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      const sd = state.staredown;
      if (!sd || sd.a !== owner.id || !result.showdown) return;
      const a = playerById(state, sd.a)!;
      const b = playerById(state, sd.b)!;
      if (!result.entries.some((e) => e.id === a.id) || !result.entries.some((e) => e.id === b.id)) return;
      const board = evalBoard(state);
      const cmp = compareContenders(contenderFor(state, a, handEvalFor(state, a, board)), contenderFor(state, b, handEvalFor(state, b, board)), { inverted: invertedNow(state), board }).result;
      const honest = (p: PlayerState, sign: number) => (sd.claims[p.id] === 1 ? sign > 0 : sign < 0);
      const ha = honest(a, cmp);
      const hb = honest(b, -cmp);
      const word = (p: PlayerState) => (sd.claims[p.id] ? '강함' : '약함');
      let tail = '둘 다 정직하거나 둘 다 정직하지 않아 정산 없음';
      if (ha !== hb) {
        const [w, l] = ha ? [a, b] : [b, a];
        const paid = transfer(state, l, w, 2 * bbOf(state));
        tail = `${w.name}만 정직 — ${l.name}이(가) ${paid}칩을 냄`;
      }
      const text = `눈싸움 공개: ${a.name} "${word(a)}", ${b.name} "${word(b)}" — ${tail}`;
      result.extras.push(text);
      addLog(state, text);
    },
  },

  // 밀봉 계약: 핸드가 끝나면 공개, 맞히면 은행에서 3BB
  sealedContract: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      const c = owner.contract;
      if (c === null || !owner.inHand || owner.folded) return;
      const outcome = result.showdown ? 1 : (result.won[owner.id] ?? 0) > 0 ? 0 : null;
      if (outcome === null) return;
      const hit = outcome === c;
      const bonus = hit ? 3 * bbOf(state) : 0;
      owner.chips += bonus;
      state.stats.bankChips += bonus;
      const text = `${owner.name}: 밀봉 계약 "${c ? '한 명 이상 콜' : '전원 폴드'}" — ${hit ? `적중, 은행에서 ${bonus}칩` : '빗나감'}`;
      result.extras.push(text);
      addLog(state, text);
    },
  },

  comeBack: {
    onBust(ctx) {
      const { state, owner, aug } = ctx;
      if ((aug.usesLeft ?? 0) <= 0) return false;
      aug.usesLeft = 0;
      owner.out = true;
      owner.outAtHand = state.handNumber;
      owner.sittingOut = false;
      // 3핸드가 지난 뒤 원래 자리로
      owner.dormant = state.handNumber + 4;
      state.tasks.push({ kind: 'revive', playerId: owner.id, dueHand: owner.dormant, amount: 10 * bbOf(state) });
      revealPassive(ctx, `— 탈락 대신 부활 대기 (핸드 #${owner.dormant}에 돌아옴)`);
      return true;
    },
  },

  runaway: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      if (!active(owner)) return;
      const total = result.pots.reduce((s, p) => s + p.amount, 0);
      const won = (result.won[owner.id] ?? 0) > 0 && total >= 5 * bbOf(state);
      owner.streak = won ? owner.streak + 1 : 0;
      if (won && owner.streak >= 3) addLog(state, `폭주기관차: ${owner.name} ${owner.streak}연승`);
    },
    onPickRound(ctx) {
      const { state, owner } = ctx;
      if (owner.streak < 3 || !owner.pickOptions) return;
      owner.pickExtra = owner.streak >= 5 ? 2 : 1;
      revealPassive(ctx, `— ${owner.streak}연승: 이번 증강 선택에서 ${owner.pickExtra + 1}개를 가져갑니다`);
      owner.streak = 0;
    },
  },

  lurk: {
    onAcquire(ctx, got) {
      const { state, owner } = ctx;
      if (got.id === 'lurk') {
        const others = owner.augments.filter((a) => a.id !== 'lurk');
        if (!others.length) {
          owner.lurkWaiting = true;
          addLog(state, '잠복: 숨길 증강이 없어 다음에 얻는 증강을 숨깁니다', { to: [owner.id] });
          return;
        }
        const pick = pickOne(others, state.rng);
        pick.hidden = true;
        owner.lurkChoose = true;
        addLog(state, `잠복: ${AUGMENTS[pick.id].name}을(를) 숨겼습니다 (다음 핸드 시작 전까지 바꿀 수 있음)`, { to: [owner.id] });
        return;
      }
      if (owner.lurkWaiting) {
        owner.lurkWaiting = false;
        got.hidden = true;
        addLog(state, `잠복: ${AUGMENTS[got.id].name}을(를) 숨겼습니다`, { to: [owner.id] });
      }
    },
  },

  hunter: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      if (!active(owner) || (result.won[owner.id] ?? 0) <= 0) return;
      const victims = (result.busted ?? []).filter((id) => id !== owner.id);
      for (const v of victims) {
        const list = rechargeable(owner, 2);
        if (!list.length) return;
        const a = pickOne(list, state.rng);
        a.usesLeft = 1;
        revealPassive(ctx, `— ${nameOf(state, v)}을(를) 탈락시킴`);
        addLog(state, `사냥꾼: ${AUGMENTS[a.id].name}을(를) 1회 충전했습니다`, { to: [owner.id] });
      }
    },
  },

  vest: {
    blockForcedFold(ctx) {
      if ((ctx.aug.usesLeft ?? 0) <= 0) return false;
      ctx.aug.usesLeft = 0;
      revealPassive(ctx, '— 강제 폴드를 막았습니다');
      return true;
    },
  },
};

/** 이 플레이어가 받는 홀카드 수 */
export function holeCardCount(p: PlayerState): number {
  return Math.max(2, ...p.augments.map((a) => PASSIVE[a.id]?.holeCards ?? 2));
}

// ───────────────────────── 예약 작업 (사채·대출 상환, 부활) ─────────────────────────

export const TASKS: Record<ScheduledTask['kind'], (state: GameState, t: ScheduledTask) => void> = {
  sharkRepay(state, t) {
    const borrower = playerById(state, t.playerId);
    const lender = playerById(state, t.otherId);
    if (!borrower || !active(borrower)) return;
    if (!lender || !active(lender)) {
      addLog(state, `사채업자: 빌려준 사람이 자리에 없어 ${borrower.name}의 빚이 사라졌습니다`);
      return;
    }
    const paid = transfer(state, borrower, lender, t.amount);
    countUse(state, 'loanShark');
    addLog(state, `사채업자: ${borrower.name}이(가) ${lender.name}에게 ${paid}칩을 갚았습니다${paid < t.amount ? ' (모자라 있는 만큼)' : ''}`);
  },
  loanRepay(state, t) {
    const p = playerById(state, t.playerId);
    if (!p || !active(p)) return;
    const paid = transfer(state, p, null, t.amount);
    countUse(state, 'loan');
    if (paid >= t.amount) {
      addLog(state, `대출: ${p.name}이(가) 은행에 ${paid}칩을 갚았습니다`);
      return;
    }
    // 모자라면 있는 만큼 내고 보유 증강 1개 몰수
    const lost = p.augments.length ? pickOne(p.augments, state.rng) : null;
    if (lost) p.augments = p.augments.filter((a) => a !== lost);
    addLog(state, `대출: ${p.name}이(가) ${paid}칩만 갚아${lost ? ' 보유 증강 1개를 몰수당했습니다' : ''}`);
    if (lost) note(state, p, 'augment', `대출: ${AUGMENTS[lost.id].name}을(를) 몰수당했습니다`);
  },
  revive(state, t) {
    const p = playerById(state, t.playerId);
    if (!p || p.dormant === null || p.kicked) return;
    // 돌아올 때의 10BB는 남은 플레이어가 똑같이 나눠 낸다
    const payers = state.players.filter((x) => active(x) && x !== p);
    const share = payers.length ? Math.floor(t.amount / payers.length) : 0;
    let got = 0;
    for (const x of payers) got += transfer(state, x, p, share);
    p.out = false;
    p.dormant = null;
    p.outAtHand = null;
    p.place = null;
    addLog(state, `3일 안에 오리라: ${p.name}이(가) 원래 자리로 돌아왔습니다 (${got}칩, 남은 플레이어가 ${share}칩씩)`);
  },
};

/** 선언 기회 판단용 대상 후보 (지목형 창 증강: 공동 환승·명추리·기생) */
function windowSamples(state: GameState, p: PlayerState, id: AugmentId): ActiveParams[] {
  if (id === 'seal') return [{ boardIndex: [0, 1, 2, 3, 4].find((i) => !state.effects.sealed.includes(i)) }];
  if (id === 'lastFork') return [{ cardIndex: 0 }];
  if (!AUGMENTS[id].target) return [{}];
  return state.players.filter((t) => t !== p).map((t) => {
    // 명추리: 이미 아는 카드가 아닌 아무 카드 (판단용)
    const known = id === 'nameIt' ? new Set(knownCardsFor(state, p, t)) : null;
    return { targetId: t.id, ...(known ? { card: fullDeck().find((c) => !known.has(c)) } : {}) };
  });
}

/** 선언 기회에 이 증강으로 지목할 수 있는 대상 */
export function windowTargets(state: GameState, ops: EngineOps, p: PlayerState, id: AugmentId): string[] {
  const a = findAug(p, id);
  if (!a || !AUGMENTS[id].target) return [];
  return windowSamples(state, p, id)
    .filter((params) => !ACTIVE[id]?.check({ state, ops, owner: p, aug: a }, params, false))
    .map((params) => params.targetId!);
}

/** 정해진 선언 기회에 쓸 수 있는 증강 (되감기·봉인·밥상 뒤집기 등) */
export function windowOptions(state: GameState, ops: EngineOps, p: PlayerState): AugmentId[] {
  const out: AugmentId[] = [];
  if (taxError(state, p)) return out;
  for (const a of p.augments) {
    const def = AUGMENTS[a.id];
    if (def.trigger !== 'window') continue;
    if (def.uses?.per === 'hand' ? a.usedThisHand : (a.usesLeft ?? 0) <= 0) continue;
    const ctx = { state, ops, owner: p, aug: a };
    if (windowSamples(state, p, a.id).some((params) => !ACTIVE[a.id]?.check(ctx, params, false))) out.push(a.id);
  }
  return out;
}

export { findAug };
