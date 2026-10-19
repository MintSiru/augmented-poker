// 증강 효과 함수 레지스트리.
// - ACTIVE: 선언형 증강. check(시점·대상 검증) → 3초 반응 대기 → resolve(효과 적용). 카운터되면 onCountered.
// - PASSIVE: 엔진이 정해진 시점에 부르는 훅 (홀카드 수, 폴드, 핸드 종료, 정보 노출, 강제 폴드 방어).
// 족보 변형(원형·4장 플러시·징검다리·편애)은 core.rulesFor, 동점 처리(키커 장인·절대 키커)는 showdown.ts 에서 처리한다.
// 새 증강은 augments.ts 에 정의를 추가하고 여기에 효과를 등록하면 된다.

import { Card, cardToken, fullDeck, isCard, rankOf } from './cards.js';
import { AUGMENTS, AugmentId, isActiveAugment } from './augments.js';
import { isMadeHand } from './evaluator.js';
import { pickOne } from './rng.js';
import {
  addLog,
  announceNamed,
  basePhase,
  cardsText,
  countUse,
  currentBlinds,
  evalBoard,
  findAug,
  handInProgress,
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
import type { ActiveParams, Declaration, GameState, HandResult, OwnedAugment, PlayerState } from './types.js';

/** 효과 함수가 게임 흐름을 건드릴 때 쓰는 엔진 기능 (game.ts 가 제공) */
export interface EngineOps {
  /** 폴드 처리 (보험 등 폴드 훅 포함). 흐름 진행은 하지 않는다 */
  fold(p: PlayerState, forced: boolean): void;
  /** 베팅 행동 뒤 흐름 진행 (무임승차 콜) */
  afterBet(idx: number): void;
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
  /** 본인에게만 보이는 선언 세부 (로그) */
  detail?(ctx: Ctx, params: ActiveParams): string;
}

export type InfoKind = 'clairvoyance' | 'thermal' | 'liedetector';

export interface PassiveEffect {
  /** 받는 홀카드 수 */
  holeCards?: number;
  onFold?(ctx: Ctx, forced: boolean): void;
  onHandEnd?(ctx: Ctx, result: HandResult): void;
  /** 정보형 증강에 노출될 때. 'fake' 를 돌려주면 보는 사람에게 가짜 결과를 보여 준다 */
  onInfoExposed?(ctx: Ctx, looker: PlayerState, kind: InfoKind): 'fake' | void;
  /** 다른 사람 증강의 강제 폴드를 막으면 true */
  blockForcedFold?(ctx: Ctx): boolean;
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

function realMade(state: GameState, p: PlayerState): boolean {
  return isMadeHand(p.hole, evalBoard(state), rulesFor(p));
}

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
      const err = needLive(ctx);
      if (err) return err;
      const { state, owner } = ctx;
      if (state.boardRevealed < 3 || state.boardRevealed > 4) return '플랍 이후, 리버가 나오기 전에만 쓸 수 있습니다.';
      if (owner.foreseen.includes(state.boardRevealed)) return '이미 다음 카드를 보았습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const bi = state.boardRevealed;
      const card = state.board[bi];
      owner.foreseen.push(bi);
      note(state, owner, 'foresight', `예지: 다음 보드 카드(${bi === 3 ? '턴' : '리버'})는 ${cardToken(card)}`, [card]);
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
      const stars = t.augments.map((x) => AUGMENTS[x.id].stars).sort((x, y) => y - x);
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
      const blind = state.effects.blackout && !state.effects.glass;
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
      const blind = state.effects.blackout && !state.effects.glass;
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
      if (basePhase(state) !== 'declare' || (state.street !== 'turn' && state.street !== 'river')) return '턴·리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (!state.deck.length) return '덱에 남은 카드가 없습니다.';
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
      addLog(state, `되감기: ${state.street === 'turn' ? '턴' : '리버'} ${cardToken(old)} 버림 → 새 카드 ${cardToken(fresh)}`);
    },
  },

  seal: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.street !== 'river') return '리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      const bi = params.boardIndex;
      if (typeof bi !== 'number' || !Number.isInteger(bi) || bi < 0 || bi > 4) return '봉인할 보드 카드를 고르세요.';
      if (state.effects.sealed.includes(bi)) return '이미 봉인된 카드입니다.';
      if (state.effects.sealed.length >= 2) return '한 핸드에 보드 카드는 2장까지만 봉인할 수 있습니다.';
      return null;
    },
    resolve(ctx, params) {
      const { state } = ctx;
      const bi = params.boardIndex!;
      state.effects.sealed.push(bi);
      const card = state.board[bi];
      const fog = state.effects.fogSeers;
      if (bi < 3 && fog.length && !state.effects.fogLifted) {
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
    resolve(ctx) {
      ctx.state.blackoutNext = true;
      addLog(ctx.state, '암전: 다음 핸드는 모두 자기 홀카드를 보지 못한 채 진행합니다');
    },
  },

  glassTable: {
    check: (ctx) => (handInProgress(ctx.state) ? null : '핸드가 진행 중일 때만 쓸 수 있습니다.'),
    resolve(ctx) {
      ctx.state.effects.glass = true;
      addLog(ctx.state, '유리 테이블: 이번 핸드는 모든 홀카드를 공개한 채 진행합니다');
    },
  },

  russianRoulette: {
    check(ctx) {
      if (!handInProgress(ctx.state)) return '핸드가 진행 중일 때만 쓸 수 있습니다.';
      if (ctx.state.players.filter(live).length < 3) return '폴드하지 않은 사람이 3명 이상일 때만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, ops } = ctx;
      const victim = pickOne(state.players.filter(live), state.rng);
      addLog(state, `러시안 룰렛: ${victim.name}에게 당첨!`);
      for (const a of victim.augments) {
        const hook = PASSIVE[a.id]?.blockForcedFold;
        if (hook && hook({ ...ctx, owner: victim, aug: a })) return;
      }
      ops.fold(victim, true);
    },
  },

  flipTable: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.street !== 'river') return '리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx) {
      const e = ctx.state.effects;
      e.flips++;
      addLog(ctx.state, e.flips % 2 ? '밥상 뒤집기: 이번 핸드는 족보가 역전되어 가장 낮은 패가 승리합니다' : '밥상 뒤집기: 족보 역전이 상쇄되어 원래 순위로 돌아갑니다');
    },
  },

  heavyFog: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.boardRevealed > 0) return '플랍이 깔리기 전(프리플랍)에만 선언할 수 있습니다.';
      if (!live(ctx.owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx) {
      const fog = ctx.state.effects.fogSeers;
      if (!fog.includes(ctx.owner.id)) fog.push(ctx.owner.id);
      addLog(ctx.state, `짙은 안개: 이번 플랍은 ${ctx.owner.name}만 보고, 다른 사람에게는 쇼다운 때 공개됩니다`);
    },
  },

  deathTax: {
    check: (ctx) => (ctx.state.taxers.includes(ctx.owner.id) ? '이미 선언했습니다.' : null),
    resolve(ctx) {
      const { state, owner } = ctx;
      state.taxers.push(owner.id);
      addLog(state, `죽음과 세금: 이제부터 게임이 끝날 때까지 ${owner.name}을(를) 뺀 모두가 액티브·공개형 증강을 쓸 때마다 은행에 1BB를 냅니다 (선언자 ${state.taxers.length}명)`);
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
      putChips(ctx.owner, params.blind === 'SB' ? sb : bb);
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
    onInfoExposed(ctx, looker) {
      const { state, owner, aug } = ctx;
      if ((aug.usesLeft ?? 0) <= 0) return;
      aug.usesLeft = 0;
      countUse(state, 'disinfo');
      addLog(state, `역정보 발동: ${looker.name}의 정보형 증강에 가짜 결과를 보여 줬습니다.`, { to: [owner.id] });
      return 'fake';
    },
  },

  mirror: {
    onInfoExposed(ctx, looker, kind) {
      const { state, owner } = ctx;
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

/** 정해진 선언 기회에 쓸 수 있는 증강 (되감기·봉인·밥상 뒤집기) */
export function windowOptions(state: GameState, ops: EngineOps, p: PlayerState): AugmentId[] {
  const out: AugmentId[] = [];
  if (taxError(state, p)) return out;
  for (const a of p.augments) {
    const def = AUGMENTS[a.id];
    if (def.trigger !== 'window' || (a.usesLeft ?? 0) <= 0) continue;
    // 봉인은 카드 선택 전이므로 아무 칸이나 가능한지만 본다
    const params: ActiveParams = a.id === 'seal' ? { boardIndex: [0, 1, 2, 3, 4].find((i) => !state.effects.sealed.includes(i)) } : {};
    if (!ACTIVE[a.id]?.check({ state, ops, owner: p, aug: a }, params, false)) out.push(a.id);
  }
  return out;
}

export { findAug };
