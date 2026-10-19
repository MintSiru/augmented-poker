// 플레이어 뷰: 특정 플레이어 입장에서 볼 수 있는 정보만 담는다.
// 서버는 GameState 를 절대 그대로 보내지 않고, 이 함수의 결과만 각 클라이언트에 보낸다.
// 새 필드를 추가할 때는 "다른 사람의 비공개 정보가 섞이지 않는가"를 반드시 확인할 것 (engine/test/view.test.ts).

import type { Card } from './cards.js';
import { rankName, rankOf, suitOf } from './cards.js';
import { AUGMENTS, AugmentId, Disclosure, Stars, TargetKind, Trigger } from './augments.js';
import { CATEGORY_NAMES, evaluatePlayerHand, VARIANT_LABEL, type AppliedVariant } from './evaluator.js';
import {
  canUseNow,
  counterCandidates,
  currentBlinds,
  declareOptions,
  findAug,
  legalActions,
  LegalActions,
  playerRules,
} from './game.js';
import { holeVisible, live, publicCards, taxFor, visibleBoard } from './core.js';
import { countingInfo, CountingView } from './counting.js';
import { ACTIVE } from './effects.js';
import type { GameState, NoteKind, Phase, PlayerState, Street } from './types.js';

export interface AugmentInfo {
  id: AugmentId;
  name: string;
  stars: Stars;
  category: string;
  description: string;
}

export interface MyAugmentView extends AugmentInfo {
  trigger: Trigger;
  disclosure: Disclosure;
  public: boolean;
  maxUses: number | null;
  usesLeft: number | null;
  perHand: boolean;
  usedThisHand: boolean;
  target: TargetKind | null;
  /** 지금 지목할 수 있는 대상 */
  targets: string[];
  revealed: boolean;
  /** 공개된 경우 상대에게 보이는 이름 (위장 시 가짜) */
  publicName: string | null;
  wildRank: string | null;
  armed: boolean | null;
  fakeId: AugmentId | null;
  fakeUsed: boolean | null;
  /** 지금 버튼으로 쓸 수 있는가 (최종 검증은 서버) */
  usableNow: boolean;
  /** 못 쓰는 이유 또는 쓸 수 있는 시점 (툴팁) */
  hint: string;
}

export interface PublicAugmentView {
  name: string;
  stars: Stars;
  description: string;
}

export interface PublicPlayerView {
  id: string;
  name: string;
  isBot: boolean;
  seat: number;
  chips: number;
  streetBet: number;
  inHand: boolean;
  hasCards: boolean;
  folded: boolean;
  allIn: boolean;
  out: boolean;
  place: number | null;
  sittingOut: boolean;
  isDealer: boolean;
  isSB: boolean;
  isBB: boolean;
  isTurn: boolean;
  lastAction: string | null;
  augmentCount: number;
  revealedAugments: PublicAugmentView[];
  /** 공개된 홀카드 (쇼다운·유리 테이블) */
  shownCards: Card[] | null;
  /** 양치기 소년으로 공개한 카드 (진짜·가짜 구분 없음) */
  shepherdShown: Card[];
  connected: boolean;
  isHost: boolean;
}

export interface NoteView {
  hand: number;
  kind: NoteKind;
  text: string;
  cards: Card[] | null;
  targetId: string | null;
}

export interface MyHandView {
  name: string;
  category: number;
  categoryName: string;
  cards: Card[];
  core: Card[];
  wild: Card[];
  /** 이 족보를 만드는 데 쓰인 내 증강 */
  applied: string[];
  preflop: boolean;
  tags: string[];
  /** 족보 역전 중 (낮을수록 강함) */
  inverted: boolean;
}

export interface ShowdownEntryView {
  id: string;
  name: string;
  cards: Card[];
  handName: string;
  bestCards: Card[];
  /** 족보에 적용된 증강 (보는 사람 기준 공개 이름) */
  applied: string[];
  /** 변형 증강이 만든 족보 이름 (4장 플러시, 징검다리 스트레이트, 와일드카드 사용 등) */
  variants: string[];
  /** 동점 처리 증강으로 이긴 경우 */
  tiebreak: string[];
  won: number;
}

export interface HandResultView {
  hand: number;
  showdown: boolean;
  board: Card[];
  sealed: number[];
  entries: ShowdownEntryView[];
  pots: { amount: number; winners: string[]; label: string }[];
  won: Record<string, number>;
  table: string[];
  extras: string[];
}

export interface ReactionView {
  declarerId: string;
  declarerName: string;
  /** 선언된 증강 이름 (정보형·공포탄은 "비공개 증강") */
  label: string;
  anonymous: boolean;
  mine: boolean;
  countered: boolean;
  counteredBy: string | null;
  /** 나에게만: 카운터 스펠로 무효화할 수 있는가 */
  canCounter: boolean;
  /** 이 뒤에 대기 중인 선언 수 */
  queued: number;
}

export type WaitingKind = 'turn' | 'pick' | 'discard' | 'declare' | 'reaction' | 'handEnd' | 'gameOver' | 'none';

export interface TableView {
  glass: boolean;
  blackout: boolean;
  fog: boolean;
  /** 안개 때문에 내가 플랍을 못 보는가 */
  fogHidden: boolean;
  flips: number;
  inverted: boolean;
  rewinds: number;
  /** 죽음과 세금 선언자 이름 */
  taxers: string[];
  notes: string[];
}

export interface PlayerView {
  phase: Phase;
  handNumber: number;
  level: number;
  blinds: { sb: number; bb: number };
  handsPerLevel: number;
  handsUntilLevelUp: number;
  street: Street;
  /** 공개된 보드 (짙은 안개로 가려진 카드는 null) */
  board: (Card | null)[];
  sealed: number[];
  pot: number;
  currentBet: number;
  players: PublicPlayerView[];
  toActId: string | null;
  /** 방금 베팅·레이즈한 사람 (거짓말 탐지기 대상) */
  lastAggressorId: string | null;
  waiting: { kind: WaitingKind; playerId: string | null; count: number };
  table: TableView;
  reaction: ReactionView | null;
  you: {
    id: string;
    seat: number;
    chips: number;
    out: boolean;
    /** 내가 볼 수 있는 내 홀카드 (암전이면 빈 배열) */
    hole: Card[];
    /** 암전으로 못 보는 내 홀카드 수 */
    holeHidden: number;
    hand: MyHandView | null;
    augments: MyAugmentView[];
    notes: NoteView[];
    legal: LegalActions | null;
    pick: AugmentInfo[] | null;
    pickDone: boolean;
    discard: { pending: boolean; chosen: number | null } | null;
    /** 선언 기회 (되감기·봉인·밥상 뒤집기) */
    declare: { options: AugmentInfo[] } | null;
    /** 애착: 다음 핸드로 가져갈 카드 선택 */
    attach: { cards: Card[] } | null;
    counting: CountingView | null;
    /** 액티브·공개형 증강을 쓸 때 낼 세금 (죽음과 세금) */
    tax: number;
  };
  result: HandResultView | null;
  log: { seq: number; hand: number; text: string }[];
  winnerId: string | null;
}

function info(id: AugmentId): AugmentInfo {
  const d = AUGMENTS[id];
  return { id, name: d.name, stars: d.stars, category: d.category, description: d.description };
}

/** 다른 사람에게 보이는 증강 이름 (위장 반영, 편애 숫자는 넣지 않음) */
function publicAugName(p: PlayerState, id: AugmentId): string {
  const a = findAug(p, id);
  if (!a || !a.publicId) return AUGMENTS[id].name;
  return AUGMENTS[a.publicId].name;
}

const VARIANT_AUG: Record<AppliedVariant, AugmentId> = {
  fourFlush: 'fourFlush',
  gapStraight: 'gapStraight',
  wrapStraight: 'wrapStraight',
  wild: 'favoritism',
};

/** 내 홀카드(볼 수 있을 때) + 내가 볼 수 있는 보드(봉인 제외) + 내 증강만으로 계산한 내 족보 */
function myHand(state: GameState, me: PlayerState, hole: Card[], board: (Card | null)[]): MyHandView | null {
  if (!hole.length) return null;
  const vis = board.filter((c, i): c is Card => !!c && !state.effects.sealed.includes(i));
  const rules = playerRules(me);
  const ev = evaluatePlayerHand(hole, vis, rules);
  const v = ev.value;
  const tags: string[] = [];
  if (board.length === 0 && hole.length >= 2) {
    if (hole.every((c) => suitOf(c) === suitOf(hole[0]))) tags.push('수딧');
    const ranks = [...new Set(hole.map(rankOf))].sort((a, b) => a - b);
    const low = ranks.map((r) => (r === 14 ? 1 : r)).sort((a, b) => a - b);
    const connected = (rs: number[]) => rs.length === hole.length && rs.every((r, i) => i === 0 || r - rs[i - 1] === 1);
    if (connected(ranks) || connected(low)) tags.push('연결');
  }
  return {
    name: v.name,
    category: v.category,
    categoryName: CATEGORY_NAMES[v.category],
    cards: [...v.cards],
    core: [...v.core],
    wild: rules.wildRank ? v.cards.filter((c) => rankOf(c) === rules.wildRank) : [],
    applied: ev.applied.map((x) => AUGMENTS[VARIANT_AUG[x]].name),
    preflop: vis.length === 0,
    tags,
    inverted: state.effects.flips % 2 === 1,
  };
}

function targetsFor(state: GameState, me: PlayerState, id: AugmentId): string[] {
  const def = AUGMENTS[id];
  if (!def.target || !ACTIVE[id]) return [];
  const aug = findAug(me, id)!;
  return state.players.filter((t) => t !== me && !canUseNow(state, me, aug, { targetId: t.id })).map((t) => t.id);
}

/** 보는 사람(viewerId)에게 허용된 정보만으로 만든 뷰 */
export function getPlayerView(state: GameState, viewerId: string): PlayerView {
  const me = state.players.find((p) => p.id === viewerId);
  if (!me) throw new Error('unknown player');
  const { sb, bb } = currentBlinds(state);
  const hpl = state.options.handsPerLevel;
  const board = visibleBoard(state, me);
  const pot = state.players.reduce((s, p) => s + p.contributed, 0) + state.deadMoney;
  const e = state.effects;
  const nameById = (id: string) => state.players.find((p) => p.id === id)?.name ?? '?';

  const players: PublicPlayerView[] = state.players.map((p, i) => ({
    id: p.id,
    name: p.name,
    isBot: p.isBot,
    seat: p.seat,
    chips: p.chips,
    streetBet: p.streetBet,
    inHand: p.inHand,
    hasCards: p.inHand && !p.folded && p.hole.length > 0,
    folded: p.folded,
    allIn: p.allIn,
    out: p.out,
    place: p.place,
    sittingOut: p.sittingOut,
    isDealer: state.dealerIdx === i && p.inHand,
    isSB: state.sbIdx === i && p.inHand,
    isBB: state.bbIdx === i && p.inHand,
    isTurn: state.phase === 'betting' && state.toAct === i,
    lastAction: p.lastAction,
    augmentCount: p.augments.length,
    revealedAugments: p.augments
      .filter((a) => a.revealed && a.publicId)
      .map((a) => {
        const d = AUGMENTS[p === me ? a.id : a.publicId!];
        return { name: p === me ? d.name : publicAugName(p, a.id), stars: d.stars, description: d.description };
      }),
    // 홀카드는 볼 수 있는 경우에만 (쇼다운·유리 테이블, 본인은 암전이 아닐 때)
    shownCards: p.inHand && (p.shown || e.glass) && holeVisible(state, p, me) ? [...p.hole] : null,
    shepherdShown: [...p.shepherdShown],
    connected: true,
    isHost: false,
  }));

  // 결과 화면
  let result: HandResultView | null = null;
  if (state.result) {
    const r = state.result;
    result = {
      hand: r.hand,
      showdown: r.showdown,
      board: r.showdown ? [...r.board] : board.filter((c): c is Card => !!c),
      sealed: [...r.sealed],
      entries: r.entries.map((x) => {
        const owner = state.players.find((p) => p.id === x.id)!;
        const nameOfAug = (id: AugmentId) => (owner === me ? AUGMENTS[id].name : publicAugName(owner, id));
        return {
          id: x.id,
          name: owner.name,
          cards: [...x.cards],
          handName: x.handName,
          bestCards: [...x.bestCards],
          applied: x.applied.map((v) => nameOfAug(VARIANT_AUG[v])),
          variants: x.applied.map((v) => VARIANT_LABEL[v]),
          tiebreak: x.tiebreak.map(nameOfAug),
          won: r.won[x.id] ?? 0,
        };
      }),
      pots: r.pots.map((pt, k) => ({
        amount: pt.amount,
        winners: pt.winners.map(nameById),
        label: r.pots.length > 1 ? (k === 0 ? '메인팟' : `사이드팟 ${k}`) : '팟',
      })),
      won: { ...r.won },
      table: [...r.table],
      extras: [...r.extras],
    };
  }

  // 반응 대기 (정보형·공포탄은 선언자 본인 외에는 "비공개 증강")
  let reaction: ReactionView | null = null;
  const head = state.phase === 'reaction' ? state.reaction?.queue[0] : undefined;
  if (head) {
    const mine = head.ownerId === me.id;
    reaction = {
      declarerId: head.ownerId,
      declarerName: nameById(head.ownerId),
      label: mine ? AUGMENTS[head.augment].name : head.anonymous ? '비공개 증강' : head.publicName ?? '증강',
      anonymous: head.anonymous,
      mine,
      countered: head.countered,
      counteredBy: head.counteredBy ? nameById(head.counteredBy) : null,
      canCounter: counterCandidates(state).includes(me.id),
      queued: (state.reaction?.queue.length ?? 1) - 1,
    };
  }

  // 대기 상태 (선언 기회·세 번째 손처럼 증강 보유가 드러나는 대기는 이름을 숨긴다)
  const waitKind: Record<Phase, WaitingKind> = {
    betting: 'turn',
    augmentSelect: 'pick',
    discard: 'discard',
    declare: 'declare',
    reaction: 'reaction',
    handEnd: 'handEnd',
    gameOver: 'gameOver',
  };
  const waiting: PlayerView['waiting'] = {
    kind: waitKind[state.phase] ?? 'none',
    playerId: state.phase === 'betting' && state.toAct !== null ? state.players[state.toAct].id : null,
    count: state.phase === 'augmentSelect' ? state.players.filter((p) => p.pickOptions).length : 0,
  };

  const myHole = me.inHand && holeVisible(state, me, me) ? [...me.hole] : [];
  const hand = me.inHand && !me.folded ? myHand(state, me, myHole, board) : null;

  const myAugments: MyAugmentView[] = me.augments.map((a) => {
    const d = AUGMENTS[a.id];
    const targets = targetsFor(state, me, a.id);
    const why = d.trigger === 'button' ? canUseNow(state, me, a, d.target ? { targetId: targets[0] } : { cardIndex: 0 }) : null;
    return {
      ...info(a.id),
      trigger: d.trigger,
      disclosure: d.disclosure,
      public: !!d.public,
      maxUses: d.uses?.per === 'game' ? d.uses.count : null,
      usesLeft: a.usesLeft,
      perHand: d.uses?.per === 'hand',
      usedThisHand: a.usedThisHand,
      target: d.target ?? null,
      targets,
      revealed: a.revealed,
      publicName: a.revealed && a.publicId ? AUGMENTS[a.publicId].name : null,
      wildRank: a.wildRank ? rankName(a.wildRank) : null,
      armed: a.armed ?? null,
      fakeId: a.fakeId ?? null,
      fakeUsed: a.fakeUsed ?? null,
      usableNow: d.trigger === 'button' && !why,
      hint: why ?? d.timing,
    };
  });

  const log = state.log
    .filter((x) => (!x.to || x.to.includes(viewerId)) && !(x.except && x.except.includes(viewerId)))
    .slice(-150)
    .map((x) => ({ seq: x.seq, hand: x.hand, text: x.text }));

  const declOpts = declareOptions(state, me);
  const counting =
    findAug(me, 'counting') && me.inHand && !me.out
      ? countingInfo(
          myHole,
          board.filter((c): c is Card => !!c),
          state.used,
          publicCards(state).filter((c) => !me.hole.includes(c)),
          playerRules(me),
        )
      : null;

  return {
    phase: state.phase,
    handNumber: state.handNumber,
    level: state.levelIndex + 1,
    blinds: { sb, bb },
    handsPerLevel: hpl,
    handsUntilLevelUp: (state.levelIndex + 1) * hpl - state.handNumber + 1,
    street: state.street,
    board,
    sealed: [...e.sealed],
    pot,
    currentBet: state.currentBet,
    players,
    toActId: state.phase === 'betting' && state.toAct !== null ? state.players[state.toAct].id : null,
    lastAggressorId:
      state.lastAggression && state.lastAggression.seq === state.betActionSeq && state.lastAggression.street === state.street
        ? state.players[state.lastAggression.idx].id
        : null,
    waiting,
    table: {
      glass: e.glass,
      blackout: e.blackout,
      fog: e.fogSeers.length > 0 && !e.fogLifted,
      fogHidden: board.some((c) => c === null),
      flips: e.flips,
      inverted: e.flips % 2 === 1,
      rewinds: e.rewinds,
      taxers: state.taxers.map(nameById),
      notes: tableNotes(state),
    },
    reaction,
    you: {
      id: me.id,
      seat: me.seat,
      chips: me.chips,
      out: me.out,
      hole: myHole,
      holeHidden: me.inHand && !myHole.length ? me.hole.length : 0,
      hand,
      augments: myAugments,
      notes: me.notes
        .filter((n) => n.hand === state.handNumber || n.kind === 'inquiry')
        .map((n) => ({ hand: n.hand, kind: n.kind, text: n.text, cards: n.cards ? [...n.cards] : null, targetId: n.targetId ?? null })),
      legal: legalActions(state, me.id),
      pick: me.pickOptions ? me.pickOptions.map(info) : null,
      pickDone: state.phase === 'augmentSelect' && !me.pickOptions,
      discard:
        state.phase === 'discard' && live(me) && me.hole.length === 3
          ? { pending: me.pendingDiscard === null, chosen: me.pendingDiscard }
          : null,
      declare: declOpts.length ? { options: declOpts.map(info) } : null,
      attach: me.attachPending && state.phase === 'handEnd' ? { cards: [...me.hole] } : null,
      counting,
      tax: taxFor(state, me),
    },
    result,
    log,
    winnerId: state.winnerId,
  };
}

/** 테이블에 표시할 현재 효과 (모두에게 공개된 정보만) */
function tableNotes(state: GameState): string[] {
  const e = state.effects;
  const out: string[] = [];
  if (state.phase !== 'augmentSelect') {
    if (e.flips % 2 === 1) out.push('족보 역전: 낮은 패가 승리');
    if (e.glass) out.push('유리 테이블');
    if (e.blackout) out.push('암전');
    if (e.fogSeers.length && !e.fogLifted) out.push('짙은 안개');
    if (e.sealed.length) out.push(`봉인 ${e.sealed.length}장`);
    if (e.rewinds) out.push(`되감기 ${e.rewinds}회`);
  }
  if (state.blackoutNext) out.push('다음 핸드 암전');
  return out;
}

export function augmentCatalog(): AugmentInfo[] {
  return (Object.keys(AUGMENTS) as AugmentId[]).map(info);
}
