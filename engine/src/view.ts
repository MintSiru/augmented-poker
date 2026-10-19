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
  declareTargets,
  findAug,
  legalActions,
  LegalActions,
  playerRules,
} from './game.js';
import {
  boardBlind,
  boardInfoHidden,
  glassShows,
  holeVisible,
  invertedNow,
  live,
  lockError,
  maskFor,
  boardView,
  publicCards,
  taxFor,
  turnCutFor,
  VARIANT_AUG,
  visibleBoard,
  type MaskRules,
} from './core.js';
import { fullDeck } from './cards.js';
import { immunityCandidates } from './game.js';
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
  /** 짝수/홀수 동맹: 고른 쪽 */
  parity: 'even' | 'odd' | null;
  /** 1차 / 2차 / 3차 풀 */
  pool: 1 | 2 | 3;
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
  /** 추방됨 (핸드가 끝나면 자리에서 사라짐) */
  kicked: boolean;
  /** 칩·베팅 금액이 대략값(BB 단위 반올림)인가 (안경 없어서 잘 안보여) */
  approx: boolean;
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
  /** 두 번째 보드의 족보 */
  alt: { label: string; handName: string }[];
}

export interface HandResultView {
  hand: number;
  showdown: boolean;
  board: Card[];
  sealed: number[];
  entries: ShowdownEntryView[];
  pots: { amount: number; winners: string[]; label: string; units: { label: string; amount: number; winners: string[] }[] | null }[];
  /** 두 번째 보드 (더블 보드·두 번의 운명) */
  board2: Card[] | null;
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
  /** 나에게만: 면역으로 이 공개형 효과에서 빠질 수 있는가 */
  canImmune: boolean;
  /** 이 뒤에 대기 중인 선언 수 */
  queued: number;
}

export type WaitingKind = 'turn' | 'pick' | 'discard' | 'declare' | 'reaction' | 'respond' | 'handEnd' | 'gameOver' | 'none';

/** 제안·입찰 창. 제안 내용·입찰가·비공개 선언은 결과가 나올 때까지 당사자에게만 */
export interface RespondView {
  augment: AugmentId;
  name: string;
  ownerId: string;
  ownerName: string;
  /** 응답할 사람 (공개) */
  participants: string[];
  /** 내가 지금 응답해야 하는가 */
  needMe: boolean;
  /** 응답 방식: 수락/거절, 입찰, 홀카드 고르기, 입찰+홀카드, 강함/약함 */
  input: 'accept' | 'bid' | 'card' | 'bidCard' | 'strongWeak' | null;
  /** 나에게 보여 줄 안내 (제안 내용 포함) */
  text: string;
  /** 골라 봐: 선언자 본인에게만, 보여 줄 카드 */
  card: Card | null;
  /** 내 응답 (나에게만) */
  myAnswer: { accept: boolean | null; bid: number | null; choice: number | null; cardIndex: number | null } | null;
  minBid: number;
  maxBid: number;
}

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
  /** 언더독: 이번 핸드 포함 남은 핸드 수 (0 = 없음) */
  underdogHands: number;
  bomb: boolean;
  /** 실명 다트 대상 이름 (공개 정보) */
  blindDarted: string[];
  /** 서킷브레이커로 다시 시작한 라운드 (레이즈 1회 제한) */
  raiseCap: number | null;
  /** 이번 라운드 레이즈 수 */
  roundRaises: number;
  /** 자물쇠가 걸린 라운드 */
  locked: boolean;
  highLow: boolean;
  lastStand: boolean;
  capitalism: boolean;
  /** 자석이 지정한 무늬 */
  magnetSuit: string | null;
  twoFates: boolean;
  /** 스트리트별 누적 공개 장수 (거꾸로 강을 거슬러면 1-2-5) */
  revealPlan: number[];
}

export interface PlayerView {
  phase: Phase;
  handNumber: number;
  level: number;
  blinds: { sb: number; bb: number };
  /** 이번 레벨의 핸드 수 */
  handsPerLevel: number;
  handsUntilLevelUp: number;
  /** 블라인드 설정 (공개 정보) */
  blindSchedule: 'standard' | 'x1.5';
  levelMode: 'auto' | 'fixed';
  /** 남은 인원 (탈락·추방 제외, 자리에 앉은 사람) */
  alive: number;
  /** 중도 참여 대기자 (이름만) */
  joiners: { id: string; name: string }[];
  street: Street;
  /** 공개된 보드 (짙은 안개·실명 다트로 가려진 카드는 null, 무늬를 가리면 'A?' 처럼 숫자만) */
  board: (Card | null)[];
  /** 두 번째 보드 (더블 보드·두 번의 운명), 가림 규칙은 첫 보드와 같다 */
  board2: (Card | null)[] | null;
  /** 미리 공개된 예약 카드 (미리 온 결말·동결) */
  reserved: { index: number; card: Card; label: string }[];
  /** 나에게 걸린 가림 규칙 */
  masks: MaskRules;
  /** 팟·현재 베팅이 대략값인가 */
  potApprox: boolean;
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
  respond: RespondView | null;
  /** 카드 경매로 공개된 카드 (가림 규칙 적용) */
  auctionCard: Card | null;
  you: {
    id: string;
    /** 자리에 앉아 있는가 (중도 참여 대기자·자리를 비켜 준 탈락자는 false) */
    seated: boolean;
    /** 중도 참여 대기 중: 증강 선택 진행 상황 */
    joining: { picksDone: number; picksTotal: number } | null;
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
    declare: { options: AugmentInfo[]; targets: Partial<Record<AugmentId, string[]>> } | null;
    /** 애착: 다음 핸드로 가져갈 카드 선택 */
    attach: { cards: Card[] } | null;
    counting: CountingView | null;
    /** 액티브·공개형 증강을 쓸 때 낼 세금 (죽음과 세금) */
    tax: number;
    /** 실명 다트로 보드를 못 보는 중 */
    boardBlind: boolean;
    /** 메이드 인 헤븐으로 줄어든 내 행동 시간 (초) */
    turnCut: number;
    /** 2차 증강의 본인 전용 정보 */
    extra: {
      /** 왕귀: 쇼다운에서 진 횟수 (보유 시) */
      lateLosses: number | null;
      /** 내기할래?: 이번 핸드 예측 (0~7) */
      betPrediction: number | null;
      /** 데스티니 드로우: 다음 핸드에 받을 카드 */
      destinyCard: Card | null;
      /** 데스티니 드로우에서 고를 수 없는 카드 (내가 이미 가져가는 카드) */
      destinyBlocked: Card[];
      /** 보관함: 이번 프리플랍에 바꿀 수 있는 카드 / 핸드 종료 후 보관할 카드 선택 */
      lockerReady: Card | null;
      lockerChoose: Card[] | null;
      /** 양자택일: 턴 후보와 고른 쪽 */
      eitherOr: { cards: Card[]; pick: number | null } | null;
      /** 쇼맨십: 공개 여부 선택 */
      showChoose: boolean;
      ironWall: boolean;
      blackjackOn: boolean;
      /** 턴과 리버 사이: 미리 본 두 카드와 순서 */
      turnRiver: { cards: Card[]; swap: boolean | null } | null;
      /** 무승부로 하지 않을래?: 제안할 수 있는 상대 */
      drawPrompt: { winnerName: string } | null;
      /** 밀봉 계약: 내 예측 (0 = 전원 폴드, 1 = 한 명 이상 콜) */
      contract: number | null;
    };
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

/** 버튼 사용 가능 여부를 판단할 기본 인자 (실제 값은 화면에서 고른다) */
function sampleParams(state: GameState, me: PlayerState, id: AugmentId, targets: string[]): Record<string, unknown> {
  const d = AUGMENTS[id];
  if (d.target) return { targetId: targets[0], cardIndex: 0 };
  switch (id) {
    case 'radar':
      return { boardIndex: visibleBoard(state, me).findIndex((c) => !!c) };
    case 'destinyDraw':
      return { card: fullDeck().find((c) => c !== me.keptCard && c !== me.lockerStored) };
    case 'bet':
    case 'magnet':
    case 'truthGame':
    case 'sealedContract':
      return { choice: 0 };
    case 'freeze':
      return { boardIndex: 0 };
    case 'swapBoard':
      return { cardIndex: 0, boardIndex: 0 };
    case 'rumor':
      return { augment: 'observer' };
    default:
      return { cardIndex: 0 };
  }
}

function targetsFor(state: GameState, me: PlayerState, id: AugmentId): string[] {
  const def = AUGMENTS[id];
  if (!def.target || !ACTIVE[id]) return [];
  const aug = findAug(me, id)!;
  return state.players.filter((t) => t !== me && !canUseNow(state, me, aug, { targetId: t.id, cardIndex: 0 })).map((t) => t.id);
}

/** 보는 사람(viewerId)에게 허용된 정보만으로 만든 뷰 */
export function getPlayerView(state: GameState, viewerId: string): PlayerView {
  const seatedMe = state.players.find((p) => p.id === viewerId);
  const joiner = state.joiners.find((j) => j.player.id === viewerId);
  const me = seatedMe ?? joiner?.player ?? state.retired.find((p) => p.id === viewerId);
  if (!me) throw new Error('unknown player');
  // 자리에 앉지 않은 사람(중도 참여 대기자 등)은 테이블의 공개 정보만 본다
  const seated = !!seatedMe;
  const { sb, bb } = currentBlinds(state);
  const hpl = state.levelHands;
  const mask = maskFor(state, me);
  // 무늬 가림: 서버에서 숫자만 남긴 카드 코드('A?')로 바꿔 보낸다 (정확한 카드는 보내지 않음)
  const blurCard = (c: Card) => (mask.suits ? `${c[0]}?` : c);
  const board = visibleBoard(state, me).map((c) => (c ? blurCard(c) : c));
  const realPot = state.players.reduce((s, p) => s + p.contributed, 0) + state.deadMoney;
  // 금액 대략값: BB 단위로 반올림한 값만 보낸다
  const approx = (n: number) => (mask.amounts ? Math.round(n / bb) * bb : n);
  const approxText = (t: string | null) => (t && mask.amounts ? blurAmounts(t, bb) : t);
  const pot = approx(realPot);
  const e = state.effects;
  const nameById = (id: string) => state.players.find((p) => p.id === id)?.name ?? '?';

  const players: PublicPlayerView[] = state.players.map((p, i) => ({
    id: p.id,
    name: p.name,
    isBot: p.isBot,
    seat: p.seat,
    chips: p === me ? p.chips : approx(p.chips),
    streetBet: p === me ? p.streetBet : approx(p.streetBet),
    inHand: p.inHand,
    hasCards: p.inHand && !p.folded && p.hole.length > 0,
    folded: p.folded,
    allIn: p.allIn,
    out: p.out,
    place: p.place,
    sittingOut: p.sittingOut,
    kicked: p.kicked,
    approx: mask.amounts && p !== me,
    isDealer: state.dealerIdx === i && p.inHand,
    isSB: state.sbIdx === i && p.inHand,
    isBB: state.bbIdx === i && p.inHand,
    isTurn: state.phase === 'betting' && state.toAct === i,
    lastAction: p === me ? p.lastAction : approxText(p.lastAction),
    augmentCount: p.augments.length,
    revealedAugments: p.augments
      .filter((a) => a.revealed && a.publicId)
      .map((a) => {
        const d = AUGMENTS[p === me ? a.id : a.publicId!];
        return { name: p === me ? d.name : publicAugName(p, a.id), stars: d.stars, description: d.description };
      }),
    // 홀카드는 볼 수 있는 경우에만 (쇼다운·유리 테이블, 본인은 암전이 아닐 때)
    shownCards: p.inHand && (p.shown || glassShows(state, p)) && holeVisible(state, p, me) ? [...p.hole] : null,
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
          alt: (x.alt ?? []).map((a) => ({ ...a })),
        };
      }),
      pots: r.pots.map((pt, k) => ({
        amount: pt.amount,
        winners: pt.winners.map(nameById),
        label: r.pots.length > 1 ? (k === 0 ? '메인팟' : `사이드팟 ${k}`) : '팟',
        units: pt.units ? pt.units.map((u) => ({ label: u.label, amount: u.amount, winners: u.winners.map(nameById) })) : null,
      })),
      board2: r.board2 ? [...r.board2] : null,
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
    // 소문처럼 선언자까지 숨기는 선언은 본인 외에는 누가 썼는지 보이지 않는다
    const hideWho = head.secret && !mine;
    reaction = {
      declarerId: hideWho ? '' : head.ownerId,
      declarerName: hideWho ? '누군가' : nameById(head.ownerId),
      label: mine ? AUGMENTS[head.augment].name : head.anonymous ? '비공개 증강' : head.publicName ?? '증강',
      anonymous: head.anonymous,
      mine,
      countered: head.countered,
      counteredBy: head.counteredBy ? nameById(head.counteredBy) : null,
      canCounter: seated && counterCandidates(state).includes(me.id),
      canImmune: seated && immunityCandidates(state).includes(me.id),
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
    respond: 'respond',
    handEnd: 'handEnd',
    gameOver: 'gameOver',
  };
  const waiting: PlayerView['waiting'] = {
    kind: waitKind[state.phase] ?? 'none',
    playerId: state.phase === 'betting' && state.toAct !== null ? state.players[state.toAct].id : null,
    count: state.phase === 'augmentSelect' ? state.players.filter((p) => p.pickOptions).length : 0,
  };

  const myHole = seated && me.inHand && holeVisible(state, me, me) ? [...me.hole] : [];
  // 실명 다트 대상에게는 보드로 계산되는 정보(현재 족보 등)도 보내지 않는다
  const blind = boardBlind(state, me) || boardInfoHidden(state, me);
  const hand = seated && me.inHand && !me.folded && !blind ? myHand(state, me, myHole, board) : null;

  const myAugments: MyAugmentView[] = me.augments.map((a) => {
    const d = AUGMENTS[a.id];
    const targets = seated ? targetsFor(state, me, a.id) : [];
    const why = !seated
      ? '자리에 앉은 뒤에 쓸 수 있습니다.'
      : d.trigger === 'button'
        ? canUseNow(state, me, a, sampleParams(state, me, a.id, targets))
        : null;
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
      parity: a.parity ?? null,
      pool: d.pool ?? 1,
      usableNow: seated && d.trigger === 'button' && !why,
      hint: why ?? d.timing,
    };
  });

  // 가림 규칙: 이번 핸드 로그의 보드 카드는 숫자만, 금액은 대략값으로 바꿔 보낸다
  const boardSet = new Set(mask.suits ? state.board.filter((c) => !me.hole.includes(c)) : []);
  const maskLog = (x: { seq: number; hand: number; text: string }) => {
    if (x.hand !== state.handNumber) return x.text;
    let t = x.text;
    if (boardSet.size) t = t.replace(/\[([2-9TJQKA][shdc])\]/g, (m, c: string) => (boardSet.has(c) ? `[${c[0]}?]` : m));
    if (mask.amounts && state.effects.glassesSeq && x.seq >= state.effects.glassesSeq) t = blurAmounts(t, bb);
    return t;
  };
  const log = state.log
    .filter((x) => x.seq >= me.logFrom && (!x.to || x.to.includes(viewerId)) && !(x.except && x.except.includes(viewerId)))
    .slice(-150)
    .map((x) => ({ seq: x.seq, hand: x.hand, text: maskLog(x) }));

  const declOpts = seated ? declareOptions(state, me) : [];
  const counting =
    seated && !blind && findAug(me, 'counting') && me.inHand && !me.out
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
    handsUntilLevelUp: state.levelStartHand + hpl - state.handNumber,
    blindSchedule: state.options.blindSchedule,
    levelMode: state.options.levelMode,
    alive: state.players.filter((p) => !p.out && !p.kicked).length,
    joiners: state.joiners.map((j) => ({ id: j.player.id, name: j.player.name })),
    street: state.street,
    board,
    sealed: [...e.sealed],
    pot,
    currentBet: approx(state.currentBet),
    masks: mask,
    potApprox: mask.amounts,
    board2: state.board2 ? boardView(state, state.board2, me).map((c) => (c ? blurCard(c) : c)) : null,
    reserved: mask.board ? [] : state.reservedPublic.map((r) => ({ index: r.index, card: blurCard(r.card), label: r.label })),
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
      flips: e.flips + (e.underdog ? 1 : 0),
      inverted: invertedNow(state),
      rewinds: e.rewinds,
      taxers: state.taxers.map(nameById),
      notes: tableNotes(state),
      underdogHands: (e.underdog ? 1 : 0) + state.underdogLeft,
      bomb: e.bomb,
      blindDarted: e.fogLifted ? [] : e.blindDarted.map(nameById),
      raiseCap: state.phase === 'betting' || state.phase === 'reaction' ? state.round.raiseCap : null,
      roundRaises: state.round.raises,
      locked: !!lockError(state),
      highLow: e.highLow,
      lastStand: e.lastStand,
      capitalism: e.capitalism,
      magnetSuit: e.magnet?.suit ?? null,
      twoFates: e.twoFates,
      revealPlan: [...state.revealPlan],
    },
    reaction,
    respond: respondView(state, me, bb),
    auctionCard: state.auctionCard && !mask.board ? blurCard(state.auctionCard) : null,
    you: {
      id: me.id,
      seated,
      joining: joiner ? { picksDone: joiner.picksTotal - joiner.picksLeft, picksTotal: joiner.picksTotal } : null,
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
      legal: seated ? legalActions(state, me.id) : null,
      pick: me.pickOptions ? me.pickOptions.map(info) : null,
      pickDone: seated && state.phase === 'augmentSelect' && !me.pickOptions,
      discard:
        seated && state.phase === 'discard' && live(me) && me.hole.length === 3
          ? { pending: me.pendingDiscard === null, chosen: me.pendingDiscard }
          : null,
      declare: declOpts.length ? { options: declOpts.map(info), targets: Object.fromEntries(declOpts.map((id) => [id, declareTargets(state, me, id)])) } : null,
      attach: seated && me.attachPending && state.phase === 'handEnd' ? { cards: [...me.hole] } : null,
      counting,
      tax: taxFor(state, me),
      boardBlind: boardBlind(state, me),
      turnCut: turnCutFor(state, me.id),
      extra: {
        lateLosses: findAug(me, 'lateBloomer') ? me.lateLosses : null,
        betPrediction: me.betPrediction,
        destinyCard: me.destinyCard,
        destinyBlocked: [me.keptCard, me.lockerStored].filter((c): c is Card => !!c),
        lockerReady: seated && me.lockerReady && live(me) && state.street === 'preflop' ? me.lockerReady : null,
        lockerChoose: seated && me.lockerPending && state.phase === 'handEnd' ? [...me.hole] : null,
        eitherOr: me.eitherOr ? { cards: [...me.eitherOr.cards], pick: me.eitherOr.pick } : null,
        showChoose: seated && me.showPending && state.phase === 'handEnd',
        ironWall: me.ironWall,
        blackjackOn: me.blackjackOn,
        turnRiver: me.turnRiver ? { cards: [...me.turnRiver.cards], swap: me.turnRiver.swap } : null,
        drawPrompt: me.drawPrompt && state.phase === 'handEnd' ? { winnerName: nameById(me.drawPrompt.winnerId) } : null,
        contract: me.contract,
      },
    },
    result,
    log,
    winnerId: state.winnerId,
  };
}

function respondView(state: GameState, me: PlayerState, bb: number): RespondView | null {
  const r = state.respond;
  if (state.phase !== 'respond' || !r) return null;
  const name = (id: string | undefined) => state.players.find((p) => p.id === id)?.name ?? '?';
  const owner = name(r.ownerId);
  const isOwner = me.id === r.ownerId;
  const target = r.params.targetId;
  const mine = r.answers[me.id];
  const needMe = r.participants.includes(me.id) && !mine;
  let input: RespondView['input'] = null;
  let text: string;
  switch (r.augment) {
    case 'pickMe':
      input = 'accept';
      text =
        me.id === target
          ? `${owner}이(가) 제안: ${3 * bb}칩(3BB)을 내면 ${owner}이(가) 고른 홀카드 1장을 보여 줍니다.`
          : isOwner
            ? `${name(target)}의 응답을 기다리는 중`
            : `${owner}이(가) ${name(target)}에게 제안 중`;
      break;
    case 'jointTransfer':
      if (r.stage === 'pick') {
        input = 'card';
        text = r.participants.includes(me.id) ? '건넬 홀카드 1장을 고르세요 (두 사람이 동시에 맞바꿈)' : `${owner}와(과) ${name(target)}이(가) 바꿀 카드를 고르는 중`;
      } else {
        input = 'accept';
        text = me.id === target ? `${owner}이(가) 홀카드 1장씩 맞바꾸자고 제안합니다.` : `${owner}이(가) ${name(target)}에게 교환 제안 중`;
      }
      break;
    case 'loanShark':
      input = 'accept';
      text = me.id === target ? `${owner}이(가) ${5 * bb}칩(5BB)을 빌려주겠다고 제안합니다. 2핸드 뒤 ${7 * bb}칩(7BB)을 자동으로 갚습니다.` : `${owner}이(가) ${name(target)}에게 제안 중`;
      break;
    case 'infoAuction':
      input = 'bid';
      text = r.participants.includes(me.id) ? `정보 경매: 턴 카드를 미리 볼 권리 (0 = 불참, 최소 ${bb})` : '정보 경매 입찰 중';
      break;
    case 'cardAuction':
      input = 'bidCard';
      text = r.participants.includes(me.id) ? `카드 경매: 낙찰되면 공개된 카드를 고른 홀카드와 바꿉니다 (0 = 불참, 최소 ${bb})` : '카드 경매 입찰 중';
      break;
    case 'staredown': {
      input = 'strongWeak';
      const other = me.id === r.ownerId ? name(target) : owner;
      text = r.participants.includes(me.id) ? `눈싸움: 내 패가 ${other}보다 강한가요? (비공개, 둘 다 쇼다운에 가면 공개)` : `${owner}와(과) ${name(target)}의 눈싸움`;
      break;
    }
    default:
      text = `${AUGMENTS[r.augment].name} 응답 대기 중`;
  }
  return {
    augment: r.augment,
    name: AUGMENTS[r.augment].name,
    ownerId: r.ownerId,
    ownerName: owner,
    participants: [...r.participants],
    needMe,
    input: needMe ? input : null,
    text,
    card: isOwner && r.augment === 'pickMe' && holeVisible(state, me, me) ? (r.params.card ?? null) : null,
    myAnswer: mine ? { accept: mine.accept ?? null, bid: mine.bid ?? null, choice: mine.choice ?? null, cardIndex: mine.cardIndex ?? null } : null,
    minBid: bb,
    maxBid: me.chips,
  };
}

/** 금액(숫자)을 "약 N BB" 로 바꾼다. 카드 토큰([As])은 건드리지 않는다 */
function blurAmounts(text: string, bb: number): string {
  return text
    .split(/(\[[^\]]*\])/)
    .map((part) => (part.startsWith('[') ? part : part.replace(/\d[\d,]*/g, (n) => `약 ${Math.round(Number(n.replace(/,/g, '')) / bb)}BB`)))
    .join('');
}

/** 테이블에 표시할 현재 효과 (모두에게 공개된 정보만) */
function tableNotes(state: GameState): string[] {
  const e = state.effects;
  const out: string[] = [];
  if (state.phase !== 'augmentSelect') {
    if (invertedNow(state)) out.push(e.underdog && e.flips === 0 ? '언더독: 낮은 패가 승리' : '족보 역전: 낮은 패가 승리');
    else if (e.underdog) out.push('언더독 + 밥상 뒤집기: 역전 상쇄');
    if (e.bomb) out.push('폭탄 팟');
    if (e.blindDarted.length && !e.fogLifted) out.push(`실명 다트: ${e.blindDarted.map((id) => state.players.find((p) => p.id === id)?.name ?? '?').join(', ')}`);
    if (state.round.raiseCap !== null && (state.phase === 'betting' || state.phase === 'reaction')) out.push('서킷브레이커: 레이즈 1회 제한');
    if (state.round.locked) out.push('자물쇠: 증강 사용 불가');
    if (e.highLow) out.push('하이로우');
    if (e.lastStand) out.push('배수진: 폴드·레이즈 금지');
    if (e.capitalism) out.push('자본주의');
    if (e.magnet) out.push(`자석: ${({ s: '♠', h: '♥', d: '♦', c: '♣' } as Record<string, string>)[e.magnet.suit]}${e.magnet.used ? ' (사용됨)' : ''}`);
    if (state.board2) out.push(e.twoFates ? '두 번의 운명' : '더블 보드');
    if (state.revealPlan[0] !== 3) out.push('거꾸로 강을 거슬러 (1-1-3)');
    const truthNames = ['하이카드', '원페어', '투페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드 이상'];
    for (const p of state.players) {
      if (p.truthClaim !== null && live(p)) out.push(`진실 게임: ${p.name} "${truthNames[p.truthClaim]} 이상"`);
      if (p.contract !== null && live(p)) out.push(`밀봉 계약: ${p.name}`);
    }
    if (state.staredown) out.push(`눈싸움: ${state.players.find((p) => p.id === state.staredown!.a)?.name} vs ${state.players.find((p) => p.id === state.staredown!.b)?.name}`);
    if (state.nameItWinner) out.push(`명추리 성공: ${state.players.find((p) => p.id === state.nameItWinner)?.name}`);
    if (e.glass) out.push('유리 테이블');
    if (e.blackout) out.push('암전');
    if (e.fogSeers.length && !e.fogLifted) out.push('짙은 안개');
    if (e.sealed.length) out.push(`봉인 ${e.sealed.length}장`);
    if (e.rewinds) out.push(`되감기 ${e.rewinds}회`);
  }
  if (state.blackoutNext) out.push('다음 핸드 암전');
  if (state.bombNext) out.push('다음 핸드 폭탄 팟');
  if (state.nextHand.reverse) out.push('다음 핸드 거꾸로 강을 거슬러');
  if (state.nextHand.prophecy) out.push('다음 핸드 미리 온 결말');
  if (state.nextHand.freezeCard) out.push(`다음 핸드 동결 [${state.nextHand.freezeCard}]`);
  if (state.underdogLeft > 0) out.push(`언더독 ${state.underdogLeft}핸드 남음`);
  for (const t of state.tasks) {
    const who = state.players.find((p) => p.id === t.playerId)?.name ?? '?';
    if (t.kind === 'sharkRepay') out.push(`사채: ${who} → ${state.players.find((p) => p.id === t.otherId)?.name ?? '?'} 핸드 #${t.dueHand} 전 상환`);
  }
  return out;
}

export function augmentCatalog(): AugmentInfo[] {
  return (Object.keys(AUGMENTS) as AugmentId[]).map(info);
}
