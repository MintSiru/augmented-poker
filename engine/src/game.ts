// 게임 진행 엔진: 핸드 진행, 베팅 검증, 증강 선언·반응 대기·적용, 쇼다운.
// 네트워크/화면 코드를 참조하지 않는 순수 모듈. 증강 효과는 effects.ts 레지스트리를 통해 부른다.

import { Card, cardToken, fullDeck, rankName, rankOf } from './cards.js';
import { AUGMENTS, AugmentId, isAugmentId, rollAugmentOffer } from './augments.js';
import { evaluatePlayerHand, VARIANT_LABEL, AppliedVariant } from './evaluator.js';
import { computePots, splitPot } from './pots.js';
import { cryptoRng, pickOne, Rng, shuffle } from './rng.js';
import {
  active,
  addLog,
  announceAnonymous,
  announceNamed,
  augLabel,
  basePhase,
  blindsAt,
  canAct,
  cardsText,
  countUse,
  currentBlinds,
  evalBoard,
  findAug,
  idxOf,
  live,
  nextIdx,
  note,
  playerById,
  payTax,
  putChips,
  revealAugment,
  rulesFor,
  seatOrderFromDealer,
  taxError,
} from './core.js';
import { ACTIVE, Ctx, EngineOps, holeCardCount, PASSIVE, windowOptions } from './effects.js';
import { decidePot, type Contender } from './showdown.js';
import type {
  ActionResult,
  ActiveParams,
  BetAction,
  Declaration,
  GameAction,
  GameState,
  HandResult,
  Joiner,
  OwnedAugment,
  Pending,
  Phase,
  PlayerState,
  ShowdownEntry,
  BlindSchedule,
  LevelMode,
} from './types.js';

export { blindsAt, bigBlindAt, niceRound, STANDARD_MULTIPLIERS, currentBlinds, findAug } from './core.js';

export const MAX_PLAYERS = 8;
/** 증강 선언 후 효과 적용 전 반응 대기 시간 (카운터 스펠 보유 여부와 무관하게 항상 같다) */
export const REACTION_MS = 3000;

export interface NewPlayer {
  id: string;
  name: string;
  isBot: boolean;
}

export interface CreateGameOptions {
  startingChips?: number;
  /** 시작 빅블라인드 (기본 20, 스몰블라인드는 절반) */
  bigBlind?: number;
  blindSchedule?: BlindSchedule;
  /** 블라인드 상승 주기 (기본 자동: 레벨 시작 시 남은 인원 × 2핸드) */
  levelMode?: LevelMode;
  /** 고정 주기의 레벨당 핸드 수 */
  fixedLevelHands?: number;
  rng?: Rng;
  debug?: boolean;
  dealerSeat?: number;
  /** 테스트 편의: 지정하면 고정 주기 N핸드 */
  handsPerLevel?: number;
  /** false 면 첫 증강 선택 없이 '핸드 종료' 상태로 만들어 두고, 호출 측이 startNextHand 로 첫 핸드를 시작한다 */
  initialPick?: boolean;
}

export function playerRules(p: PlayerState) {
  return rulesFor(p);
}

// ───────────────────────── 생성 ─────────────────────────

function newPlayer(np: NewPlayer, seat: number, chips: number): PlayerState {
  return {
    id: np.id,
    name: np.name,
    isBot: np.isBot,
    seat,
    chips,
    out: false,
    outAtHand: null,
    place: null,
    sittingOut: false,
    augments: [],
    skipPicks: 0,
    pickOptions: null,
    notes: [],
    inHand: false,
    hole: [],
    folded: false,
    allIn: false,
    wentAllIn: false,
    streetBet: 0,
    streetShort: 0,
    contributed: 0,
    acted: false,
    actedLevel: 0,
    actedPreflop: false,
    mulliganFee: 0,
    lastAction: null,
    shown: false,
    foreseen: [],
    discarded: [],
    pendingDiscard: null,
    forcedCall: false,
    shepherdShown: [],
    shepherdLied: false,
    keptCard: null,
    attachPending: false,
    kicked: false,
    logFrom: 0,
  };
}

export function createGame(players: NewPlayer[], opts: CreateGameOptions = {}): GameState {
  if (players.length < 2 || players.length > MAX_PLAYERS) throw new Error('플레이어는 2~8명이어야 합니다.');
  if (new Set(players.map((p) => p.id)).size !== players.length) throw new Error('플레이어 id 중복');
  const rng = opts.rng ?? cryptoRng;
  const startingChips = opts.startingChips ?? 1000;
  const fixed = opts.handsPerLevel ?? opts.fixedLevelHands;
  const state: GameState = {
    options: {
      startingChips,
      bigBlind: opts.bigBlind ?? 20,
      blindSchedule: opts.blindSchedule ?? 'standard',
      levelMode: opts.handsPerLevel !== undefined ? 'fixed' : (opts.levelMode ?? 'auto'),
      fixedLevelHands: Math.max(1, fixed ?? 10),
      debug: !!opts.debug,
    },
    rng,
    players: players.map((np, seat) => newPlayer(np, seat, startingChips)),
    phase: 'augmentSelect',
    handNumber: 1,
    levelIndex: 0,
    levelStartHand: 1,
    levelHands: 0,
    pickRounds: 0,
    joiners: [],
    retired: [],
    dealerIdx: opts.dealerSeat ?? rng.int(players.length),
    sbIdx: -1,
    bbIdx: -1,
    street: 'preflop',
    board: [],
    burns: [],
    boardRevealed: 0,
    deck: [],
    used: [],
    effects: { glass: false, blackout: false, fogSeers: [], fogLifted: false, flips: 0, rewinds: 0, sealed: [] },
    blackoutNext: false,
    blackoutBy: null,
    currentBet: 0,
    minRaise: 0,
    toAct: null,
    betSetter: null,
    betActionSeq: 0,
    lastAggression: null,
    deadMoney: 0,
    declareQueue: [],
    reaction: null,
    declSeq: 0,
    decisionSeq: 0,
    result: null,
    log: [],
    logSeq: 0,
    winnerId: null,
    nextDeal: null,
    forceLevelUp: false,
    taxers: [],
    stats: { picks: {}, uses: {}, bankChips: 0, bankTaxed: 0, joinChips: 0, kickedChips: 0 },
  };
  state.levelHands = levelHandsFor(state);
  const { sb, bb } = currentBlinds(state);
  const cycle = state.options.levelMode === 'auto' ? `자동: 남은 인원 × 2핸드, 지금 ${state.levelHands}핸드` : `${state.levelHands}핸드마다`;
  const how = state.options.blindSchedule === 'x1.5' ? '1.5배씩' : '기본 표';
  addLog(state, `게임 시작! 참가자 ${players.length}명, 시작 칩 ${startingChips}, 블라인드 ${sb}/${bb} (${cycle} ${how}로 상승)`);
  if (opts.initialPick === false) {
    state.handNumber = 0;
    state.phase = 'handEnd';
    return state;
  }
  startPickRound(state);
  return state;
}

/** 이 레벨의 핸드 수: 자동은 (레벨 시작 시 남은 인원 × 2), 고정은 설정값 */
function levelHandsFor(state: GameState): number {
  if (state.options.levelMode === 'fixed') return state.options.fixedLevelHands;
  return Math.max(2, state.players.filter(active).length * 2);
}

/** 블라인드 상승 주기 변경 (게임 중에도 가능, 다음 레벨부터 적용) */
export function setLevelPlan(state: GameState, mode: LevelMode, fixedHands: number): void {
  state.options.levelMode = mode;
  state.options.fixedLevelHands = Math.max(1, Math.floor(fixedHands));
}

// ───────────────────────── 엔진 기능 (효과 함수용) ─────────────────────────

function opsFor(state: GameState): EngineOps {
  return {
    fold: (p, forced) => doFold(state, p, forced),
    afterBet: (idx) => {
      state.betActionSeq++;
      afterBetAction(state, idx);
    },
  };
}

function ctxFor(state: GameState, owner: PlayerState, aug: OwnedAugment): Ctx {
  return { state, ops: opsFor(state), owner, aug };
}

function runHandEndHooks(state: GameState, result: HandResult): void {
  for (const i of seatOrderFromDealer(state)) {
    const p = state.players[i];
    for (const a of [...p.augments]) PASSIVE[a.id]?.onHandEnd?.(ctxFor(state, p, a), result);
  }
}

// ───────────────────────── 증강 선택 ─────────────────────────

function startPickRound(state: GameState): void {
  resetHandState(state);
  state.phase = 'augmentSelect';
  state.pickRounds++;
  const level = state.levelIndex + 1;
  // 아직 앉지 않은 중도 참여자도 이번 선택 기회를 받는다
  for (const j of state.joiners) {
    j.picksLeft++;
    j.picksTotal++;
    if (!j.player.pickOptions) rollJoinerOffer(state, j);
  }
  for (const p of state.players) {
    p.pickOptions = null;
    if (!active(p)) continue;
    if (p.skipPicks > 0) {
      p.skipPicks--;
      addLog(state, '하이리스크 패배로 이번 증강 선택 기회를 잃었습니다.', { to: [p.id] });
      continue;
    }
    const offer = rollAugmentOffer(level, p.augments.map((a) => a.id), state.rng);
    if (offer.length) p.pickOptions = offer;
  }
  if (state.players.some((p) => p.pickOptions)) {
    addLog(state, `증강 선택 (레벨 ${level})`);
    state.decisionSeq++;
  } else {
    beginHand(state);
  }
}

export function grantAugment(state: GameState, p: PlayerState, id: AugmentId, wildRank?: number): OwnedAugment {
  if (findAug(p, id)) throw new Error('이미 보유한 증강입니다.');
  const def = AUGMENTS[id];
  const aug: OwnedAugment = {
    id,
    usesLeft: def.uses?.per === 'game' ? def.uses.count : null,
    usedThisHand: false,
    revealed: false,
    publicId: null,
    acquiredHand: state.handNumber,
  };
  if (id === 'favoritism') aug.wildRank = wildRank ?? 2 + state.rng.int(13);
  if (id === 'exemption') aug.armed = false;
  if (id === 'disguise') aug.fakeId = null;
  if (id === 'shepherd') aug.fakeUsed = false;
  p.augments.push(aug);
  state.stats.picks[id] = (state.stats.picks[id] ?? 0) + 1;
  return aug;
}

// ───────────────────────── 중도 참여 ─────────────────────────

function rollJoinerOffer(state: GameState, j: Joiner): void {
  j.player.pickOptions = null;
  while (j.picksLeft > 0) {
    const offer = rollAugmentOffer(state.levelIndex + 1, j.player.augments.map((a) => a.id), state.rng);
    if (offer.length) {
      j.player.pickOptions = offer;
      j.pickSeq++;
      return;
    }
    j.picksLeft = 0; // 더 고를 수 있는 증강이 없다
  }
}

export function getJoiner(state: GameState, id: string): Joiner | undefined {
  return state.joiners.find((j) => j.player.id === id);
}

/**
 * 중도 참여 신청: 관전 상태로 공개 정보만 보면서, 다른 플레이어들이 지금까지 받은 증강 선택 횟수만큼
 * 연속으로 증강을 고른다. 다 고른 뒤 다음 핸드가 시작될 때 자리에 앉는다 (진행 중인 핸드에는 끼어들지 않음).
 */
export function addJoiner(state: GameState, np: NewPlayer): ActionResult {
  if (state.phase === 'gameOver') return { ok: false, error: '게임이 끝났습니다.' };
  if (playerById(state, np.id) || getJoiner(state, np.id) || state.retired.some((p) => p.id === np.id)) {
    return { ok: false, error: '이미 참여한 플레이어입니다.' };
  }
  const p = newPlayer(np, -1, 0);
  p.logFrom = state.logSeq + 1;
  const j: Joiner = { player: p, picksLeft: state.pickRounds, picksTotal: state.pickRounds, pickSeq: 0 };
  state.joiners.push(j);
  addLog(state, `${p.name}님이 참여했습니다 (다음 핸드부터)`);
  rollJoinerOffer(state, j);
  state.decisionSeq++;
  return { ok: true };
}

/** 앉기 전에 나간 중도 참여자 제거 */
export function removeJoiner(state: GameState, id: string): boolean {
  const j = getJoiner(state, id);
  if (!j) return false;
  state.joiners = state.joiners.filter((x) => x !== j);
  addLog(state, `${j.player.name}님이 참여를 취소했습니다`);
  return true;
}

/** 중도 참여자의 증강 선택 (선택 하나마다 서버가 30초 제한 시간을 둔다) */
function applyJoinerPick(state: GameState, j: Joiner, augment: AugmentId): string | null {
  const p = j.player;
  if (!p.pickOptions) return '선택할 증강이 없습니다.';
  if (!p.pickOptions.includes(augment)) return '선택지에 없는 증강입니다.';
  const aug = grantAugment(state, p, augment);
  j.picksLeft--;
  const extra = aug.wildRank ? ` — 와일드 숫자: ${rankName(aug.wildRank)} (나에게만 보임)` : '';
  addLog(state, `증강 획득: ${augLabel(augment, aug.wildRank)}${extra} (${j.picksTotal - j.picksLeft}/${j.picksTotal})`, { to: [p.id] });
  rollJoinerOffer(state, j);
  state.decisionSeq++;
  return null;
}

/** 선택 대기 중인 중도 참여자와 각자의 선택 번호 (서버 타이머용) */
export function joinerPending(state: GameState): { id: string; seq: number }[] {
  return state.joiners.filter((j) => j.player.pickOptions).map((j) => ({ id: j.player.id, seq: j.pickSeq }));
}

/** 중도 참여자의 선택 제한 시간 종료: 무작위 선택 */
export function joinerTimeout(state: GameState, id: string): void {
  const j = getJoiner(state, id);
  if (j?.player.pickOptions) applyJoinerPick(state, j, pickOne(j.player.pickOptions, state.rng));
}

/** 좌석 배열을 바꾼 뒤에도 딜러 버튼 위치(좌석 번호)를 유지한다 */
function reseat(state: GameState, mutate: () => void): void {
  const dealerSeat = state.players[state.dealerIdx]?.seat ?? 0;
  mutate();
  state.players.sort((a, b) => a.seat - b.seat);
  let idx = -1;
  state.players.forEach((p, i) => {
    if (p.seat <= dealerSeat) idx = i;
  });
  state.dealerIdx = idx >= 0 ? idx : state.players.length - 1;
}

/**
 * 핸드와 핸드 사이에만 호출: 추방된 플레이어를 자리에서 빼고(남은 칩은 사라짐),
 * 증강 선택을 마친 중도 참여자를 앉힌다. 남은 사람이 1명 이하가 되면 게임을 끝내고 false.
 */
function betweenHands(state: GameState): boolean {
  const kicked = state.players.filter((p) => p.kicked);
  const ready = state.joiners.filter((j) => j.picksLeft <= 0 && !j.player.pickOptions);
  if (kicked.length || ready.length) {
    reseat(state, () => {
      for (const p of kicked) {
        state.stats.kickedChips += p.chips;
        p.chips = 0;
      }
      state.players = state.players.filter((p) => !p.kicked);
      for (const j of ready) {
        const alive = state.players.filter(active);
        const used = new Set(state.players.map((p) => p.seat));
        let seat = Array.from({ length: MAX_PLAYERS }, (_, i) => i).find((i) => !used.has(i));
        if (seat === undefined) {
          // 빈 좌석이 없으면 탈락자의 자리를 넘겨받는다 (탈락자는 계속 관전)
          const gone = state.players.find((p) => p.out);
          if (!gone || alive.length >= MAX_PLAYERS) continue;
          seat = gone.seat;
          state.players = state.players.filter((p) => p !== gone);
          state.retired.push(gone);
        }
        const avg = alive.length ? Math.floor(alive.reduce((s, p) => s + p.chips, 0) / alive.length) : state.options.startingChips;
        const chips = Math.max(1, Math.min(state.options.startingChips, avg));
        const p = j.player;
        p.seat = seat;
        p.chips = chips;
        state.stats.joinChips += chips;
        state.players.push(p);
        state.joiners = state.joiners.filter((x) => x !== j);
        addLog(state, `${p.name}님이 자리에 앉았습니다 (칩 ${chips})`);
      }
    });
  }
  const remaining = state.players.filter(active);
  if (remaining.length <= 1) {
    endGame(state, remaining[0] ?? null);
    return false;
  }
  return true;
}

function endGame(state: GameState, winner: PlayerState | null): void {
  for (const p of state.players) {
    if (!p.kicked) continue;
    state.stats.kickedChips += p.chips;
    p.chips = 0;
  }
  if (winner) {
    winner.place = 1;
    state.winnerId = winner.id;
    addLog(state, `🏆 ${winner.name} 우승!`);
  }
  for (const p of state.players) p.attachPending = false;
  state.toAct = null;
  state.phase = 'gameOver';
  state.decisionSeq++;
}

/**
 * 추방: 즉시 표시하고, 진행 중인 핸드에 참여 중이면 폴드 처리(낸 칩은 팟에 남음)한다.
 * 핸드가 끝나면 자리에서 제거되고 남은 칩은 사라진다. 선언했던 지속 효과(죽음과 세금, 다음 핸드 암전)는 즉시 끝난다.
 */
export function kickPlayer(state: GameState, id: string): ActionResult {
  if (state.phase === 'gameOver') return { ok: false, error: '게임이 끝났습니다.' };
  const j = getJoiner(state, id);
  if (j) {
    state.joiners = state.joiners.filter((x) => x !== j);
    addLog(state, `${j.player.name}님이 추방되었습니다`);
    state.decisionSeq++;
    return { ok: true };
  }
  const p = playerById(state, id);
  if (!p) return { ok: false, error: '플레이어를 찾을 수 없습니다.' };
  if (p.out) return { ok: false, error: '이미 탈락한 플레이어입니다.' };
  if (p.kicked) return { ok: false, error: '이미 추방되었습니다.' };
  p.kicked = true;
  p.sittingOut = true;
  p.pickOptions = null;
  p.attachPending = false;
  addLog(state, `${p.name}님이 추방되었습니다`);
  if (state.taxers.includes(p.id)) {
    state.taxers = state.taxers.filter((x) => x !== p.id);
    addLog(state, `${p.name}의 죽음과 세금 효과가 끝났습니다`);
  }
  if (state.blackoutNext && state.blackoutBy === p.id) {
    state.blackoutNext = false;
    state.blackoutBy = null;
    addLog(state, `${p.name}이(가) 선언한 다음 핸드 암전이 취소되었습니다`);
  }
  if (live(p)) {
    // 일반 폴드와 달리 보험 등 폴드 시 발동하는 효과는 적용하지 않는다 (낸 칩은 모두 팟에 남김)
    p.folded = true;
    p.forcedCall = false;
    p.lastAction = '추방';
    for (const c of p.hole) state.used.push({ card: c, kind: 'fold' });
    // 반응 대기 중이면 대기가 끝난 뒤 흐름이 이어진다
    if (state.phase === 'betting' || state.phase === 'discard' || state.phase === 'declare') continueAfterReaction(state);
  }
  if (state.phase === 'augmentSelect' && !state.players.some((x) => x.pickOptions)) beginHand(state);
  state.decisionSeq++;
  return { ok: true };
}

function applyPick(state: GameState, p: PlayerState, augment: AugmentId): string | null {
  if (state.phase !== 'augmentSelect') return '지금은 증강 선택 단계가 아닙니다.';
  if (!p.pickOptions) return '선택할 증강이 없습니다.';
  if (!p.pickOptions.includes(augment)) return '선택지에 없는 증강입니다.';
  const aug = grantAugment(state, p, augment);
  p.pickOptions = null;
  const extra = aug.wildRank ? ` — 와일드 숫자: ${rankName(aug.wildRank)} (나에게만 보임)` : '';
  addLog(state, `증강 획득: ${augLabel(augment, aug.wildRank)}${extra}`, { to: [p.id] });
  if (!state.players.some((x) => x.pickOptions)) beginHand(state);
  return null;
}

// ───────────────────────── 핸드 시작 ─────────────────────────

function resetHandState(state: GameState): void {
  for (const p of state.players) {
    p.inHand = false;
    p.hole = [];
    p.folded = false;
    p.allIn = false;
    p.wentAllIn = false;
    p.streetBet = 0;
    p.streetShort = 0;
    p.contributed = 0;
    p.acted = false;
    p.actedLevel = 0;
    p.actedPreflop = false;
    p.mulliganFee = 0;
    p.lastAction = null;
    p.shown = false;
    p.foreseen = [];
    p.discarded = [];
    p.pendingDiscard = null;
    p.forcedCall = false;
    p.shepherdShown = [];
    p.shepherdLied = false;
    for (const a of p.augments) a.usedThisHand = false;
  }
  state.board = [];
  state.burns = [];
  state.boardRevealed = 0;
  state.deck = [];
  state.used = [];
  state.effects = { glass: false, blackout: false, fogSeers: [], fogLifted: false, flips: 0, rewinds: 0, sealed: [] };
  state.deadMoney = 0;
  state.declareQueue = [];
  state.currentBet = 0;
  state.toAct = null;
  state.betSetter = null;
  state.lastAggression = null;
  state.result = null;
  state.street = 'preflop';
}

/** 핸드 시작 시 필요한 카드 수: 보드 5 + 번 3 + 홀카드 + 멀리건·되감기 예비 */
export function cardsNeeded(state: GameState): number {
  let need = 5 + 3;
  for (const p of state.players) {
    if (p.out) continue;
    need += holeCardCount(p);
    if (findAug(p, 'mulligan')) need += 1;
    if ((findAug(p, 'rewind')?.usesLeft ?? 0) > 0) need += 1;
  }
  return need;
}

function dealCards(state: GameState): void {
  const need = cardsNeeded(state);
  if (need > 52) throw new Error(`카드가 부족합니다 (필요 ${need}장)`);
  const deal = state.nextDeal;
  state.nextDeal = null;
  // 애착으로 가져온 카드는 이번 핸드 덱에서 제외
  const kept = new Map<string, Card>();
  for (const p of state.players) {
    if (!p.out && p.keptCard) kept.set(p.id, p.keptCard);
    p.keptCard = null;
  }
  const keptSet = new Set(kept.values());
  const pool = shuffle(fullDeck().filter((c) => !keptSet.has(c)), state.rng);
  const take = (fixed: Card[] | undefined, n: number): Card[] => {
    const out: Card[] = [];
    for (const c of fixed ?? []) {
      if (out.length >= n) break;
      const i = pool.indexOf(c);
      if (i >= 0) out.push(pool.splice(i, 1)[0]);
    }
    return out;
  };
  const fixedBoard = take(deal?.board, 5);
  const fixedBurns = take(deal?.burns, 3);
  const fixedDeck = take(deal?.deck, 52);
  const fixedHands = new Map<string, Card[]>();
  for (const p of state.players) {
    if (p.out) continue;
    const n = holeCardCount(p) - (kept.has(p.id) ? 1 : 0);
    fixedHands.set(p.id, take(deal?.hands?.[p.id], n));
  }
  // 보드 5장과 번 카드 3장은 핸드 시작 시 미리 떼어 둔다 (예지로 본 순서 그대로 나오도록)
  state.board = [...fixedBoard, ...pool.splice(0, 5 - fixedBoard.length)];
  state.burns = [...fixedBurns, ...pool.splice(0, 3 - fixedBurns.length)];
  for (const i of seatOrderFromDealer(state)) {
    const p = state.players[i];
    if (p.out) continue;
    const k = kept.get(p.id);
    const fixed = fixedHands.get(p.id)!;
    const n = holeCardCount(p) - (k ? 1 : 0) - fixed.length;
    p.hole = [...(k ? [k] : []), ...fixed, ...pool.splice(0, n)];
    p.inHand = true;
  }
  state.deck = [...fixedDeck, ...pool];
}

function beginHand(state: GameState): void {
  if (!betweenHands(state)) return;
  resetHandState(state);
  state.phase = 'betting';
  state.effects.blackout = state.blackoutNext;
  state.blackoutNext = false;
  state.blackoutBy = null;
  const alive = state.players.filter((p) => !p.out);
  if (state.handNumber > 1 || state.players[state.dealerIdx].out) {
    state.dealerIdx = nextIdx(state, state.dealerIdx, (p) => !p.out);
  }
  dealCards(state);
  const { sb, bb } = currentBlinds(state);
  if (alive.length === 2) {
    state.sbIdx = state.dealerIdx;
    state.bbIdx = nextIdx(state, state.dealerIdx, (p) => !p.out);
  } else {
    state.sbIdx = nextIdx(state, state.dealerIdx, (p) => !p.out);
    state.bbIdx = nextIdx(state, state.sbIdx, (p) => !p.out);
  }
  addLog(state, `── 핸드 #${state.handNumber} ── 딜러 ${state.players[state.dealerIdx].name}, 블라인드 ${sb}/${bb}`);
  if (state.effects.blackout) addLog(state, '암전: 이번 핸드는 모두 자기 홀카드를 보지 못한 채 진행합니다');
  for (const p of state.players) {
    if (!p.inHand) continue;
    if (state.effects.blackout) addLog(state, `내 홀카드: ${p.hole.length}장 (암전 — 볼 수 없음)`, { to: [p.id] });
    else addLog(state, `내 홀카드: ${cardsText(p.hole)}`, { to: [p.id] });
  }
  // 블라인드 (면제권을 켜 둔 사람은 블라인드 대신 면제권 선언 → 반응 대기)
  postBlind(state, state.sbIdx, sb, 'SB');
  postBlind(state, state.bbIdx, bb, 'BB');
  state.currentBet = bb;
  state.minRaise = bb;
  state.betSetter = { idx: state.bbIdx, raise: false };
  if ((state.phase as Phase) === 'reaction') {
    state.toAct = nextIdx(state, state.bbIdx, (p) => needsToAct(state, p));
    if (state.toAct < 0) state.toAct = null;
    return;
  }
  startBettingRound(state, state.bbIdx);
}

function postBlind(state: GameState, idx: number, amount: number, label: 'SB' | 'BB'): void {
  const p = state.players[idx];
  const ex = findAug(p, 'exemption');
  if (ex && ex.armed && (ex.usesLeft ?? 0) > 0) {
    const tax = taxError(state, p);
    if (tax) {
      addLog(state, `${tax} (면제권 미발동)`, { to: [p.id] });
      putChips(p, amount);
      p.lastAction = `${label} ${p.streetBet}`;
      return;
    }
    declare(state, p, ex, { blind: label });
    if (ex.usesLeft === 0) ex.armed = false;
    return;
  }
  putChips(p, amount);
  p.lastAction = `${label} ${p.streetBet}`;
}

// ───────────────────────── 베팅 ─────────────────────────

/** 이번 스트리트에 아직 맞춰야 하는 금액 (무임승차로 면제된 금액 제외) */
function owed(state: GameState, p: PlayerState): number {
  return Math.max(0, state.currentBet - p.streetBet - p.streetShort);
}

function needsToAct(state: GameState, p: PlayerState): boolean {
  return canAct(p) && !(p.acted && owed(state, p) === 0);
}

function canRaise(state: GameState, p: PlayerState): boolean {
  return !p.acted || state.currentBet - p.actedLevel >= state.minRaise;
}

function othersCanRespond(state: GameState, p: PlayerState): boolean {
  return state.players.some((o) => o !== p && canAct(o));
}

function roundComplete(state: GameState): boolean {
  const actors = state.players.filter(canAct);
  if (actors.length === 0) return true;
  if (actors.length === 1 && owed(state, actors[0]) === 0) return true;
  return actors.every((p) => !needsToAct(state, p));
}

function startBettingRound(state: GameState, firstFrom: number): void {
  state.phase = 'betting';
  if (roundComplete(state)) {
    closeRound(state);
    return;
  }
  state.toAct = nextIdx(state, firstFrom, (p) => needsToAct(state, p));
  state.decisionSeq++;
}

function returnUncalled(state: GameState): void {
  const inHand = state.players.filter((p) => p.inHand);
  if (inHand.length < 2) return;
  const sorted = [...inHand].sort((a, b) => b.contributed - a.contributed);
  const top = sorted[0];
  if (top.folded) return;
  const excess = top.contributed - sorted[1].contributed;
  if (excess > 0) {
    top.contributed -= excess;
    top.streetBet = Math.max(0, top.streetBet - excess);
    top.chips += excess;
    if (top.chips > 0) top.allIn = false;
    addLog(state, `${top.name}에게 콜되지 않은 ${excess}칩 반환`);
  }
}

function logBoardStreet(state: GameState, label: string, cards: Card[], fogged: boolean): void {
  const fog = state.effects.fogSeers;
  if (fogged && fog.length) {
    addLog(state, `${label}: (짙은 안개 — 쇼다운 때 공개)`, { except: fog });
    addLog(state, `${label}: ${cardsText(cards)} (안개: 나만 보임)`, { to: fog });
  } else {
    addLog(state, `${label}: ${cardsText(cards)}`);
  }
}

function closeRound(state: GameState): void {
  returnUncalled(state);
  for (const p of state.players) {
    p.streetBet = 0;
    p.streetShort = 0;
    p.acted = false;
    p.actedLevel = 0;
    p.forcedCall = false;
  }
  state.currentBet = 0;
  state.minRaise = currentBlinds(state).bb;
  state.toAct = null;
  state.betSetter = null;
  switch (state.street) {
    case 'preflop':
      state.street = 'flop';
      state.used.push({ card: state.burns[0], kind: 'burn' });
      state.boardRevealed = 3;
      logBoardStreet(state, '플랍', state.board.slice(0, 3), true);
      if (startDiscardPhase(state)) return;
      break;
    case 'flop':
      state.street = 'turn';
      state.used.push({ card: state.burns[1], kind: 'burn' });
      state.boardRevealed = 4;
      logBoardStreet(state, '턴', [state.board[3]], false);
      if (startDeclareWindow(state)) return;
      break;
    case 'turn':
      state.street = 'river';
      state.used.push({ card: state.burns[2], kind: 'burn' });
      state.boardRevealed = 5;
      logBoardStreet(state, '리버', [state.board[4]], false);
      if (startDeclareWindow(state)) return;
      break;
    case 'river':
      showdown(state);
      return;
  }
  startBettingRound(state, state.dealerIdx);
}

function afterBetAction(state: GameState, lastIdx: number): void {
  const remaining = state.players.filter(live);
  if (remaining.length === 1) {
    endHandUncontested(state, remaining[0]);
    return;
  }
  if (roundComplete(state)) {
    closeRound(state);
    return;
  }
  state.toAct = nextIdx(state, lastIdx, (p) => needsToAct(state, p));
  state.decisionSeq++;
}

function doFold(state: GameState, p: PlayerState, forced: boolean): void {
  if (p.folded) return;
  p.folded = true;
  p.forcedCall = false;
  p.lastAction = forced ? '강제 폴드' : '폴드';
  addLog(state, `${p.name}: ${forced ? '강제 폴드' : '폴드'}`);
  for (const c of p.hole) state.used.push({ card: c, kind: 'fold' });
  for (const a of [...p.augments]) PASSIVE[a.id]?.onFold?.(ctxFor(state, p, a), forced);
}

function applyBet(state: GameState, idx: number, a: BetAction): string | null {
  if (state.phase === 'reaction') return '증강 반응 대기 중입니다. 잠시 후 행동하세요.';
  if (state.phase !== 'betting') return '지금은 베팅 단계가 아닙니다.';
  if (state.toAct !== idx) return '당신의 차례가 아닙니다.';
  const p = state.players[idx];
  const toCall = owed(state, p);
  if (p.forcedCall && (a.type === 'fold' || a.type === 'raise')) return '강제 집행 대상이라 콜해야 합니다.';
  switch (a.type) {
    case 'fold':
      doFold(state, p, false);
      break;
    case 'check':
      if (toCall > 0) return `체크할 수 없습니다. 콜 금액은 ${Math.min(toCall, p.chips)}입니다.`;
      p.lastAction = '체크';
      addLog(state, `${p.name}: 체크`);
      break;
    case 'call': {
      if (toCall === 0) return '콜할 금액이 없습니다. 체크하세요.';
      if (a.freeRide) return declareFreeRide(state, p);
      putChips(p, toCall);
      p.lastAction = p.allIn ? `올인 ${p.streetBet}` : `콜 ${p.streetBet}`;
      addLog(state, `${p.name}: ${p.allIn ? '올인 콜' : '콜'} (${p.streetBet})`);
      break;
    }
    case 'raise':
    case 'allin': {
      const level = p.streetBet + p.streetShort;
      const maxTo = level + p.chips;
      const target = a.type === 'allin' ? maxTo : a.amount;
      if (typeof target !== 'number' || !Number.isInteger(target) || target <= 0) return '금액이 올바르지 않습니다.';
      if (target > maxTo) return '보유 칩보다 많이 걸 수 없습니다.';
      if (target <= state.currentBet || !othersCanRespond(state, p) || p.forcedCall) {
        if (target !== maxTo && target > state.currentBet && !p.forcedCall) return '상대가 모두 올인해 레이즈할 수 없습니다. 콜하세요.';
        if (target !== maxTo) return `레이즈 금액은 ${state.currentBet + state.minRaise} 이상이어야 합니다.`;
        if (toCall === 0) return '콜할 금액이 없습니다. 체크하세요.';
        if (p.forcedCall && p.chips > toCall) return '강제 집행 대상이라 콜만 할 수 있습니다.';
        putChips(p, toCall);
        p.lastAction = p.allIn ? `올인 ${p.streetBet}` : `콜 ${p.streetBet}`;
        addLog(state, `${p.name}: ${p.allIn ? '올인 콜' : '콜'} (${p.streetBet})`);
        break;
      }
      if (!canRaise(state, p)) return '완전한 레이즈가 없었으므로 다시 레이즈할 수 없습니다 (콜 또는 폴드).';
      const minTo = state.currentBet + state.minRaise;
      if (target < minTo && target !== maxTo) return `최소 ${minTo}까지 레이즈해야 합니다.`;
      const opening = state.currentBet === 0;
      const raiseSize = target - state.currentBet;
      putChips(p, target - level);
      if (raiseSize >= state.minRaise) state.minRaise = raiseSize;
      state.currentBet = target;
      state.betSetter = { idx, raise: !opening };
      const verb = opening ? '베팅' : '레이즈';
      p.lastAction = p.allIn ? `올인 ${target}` : `${verb} ${target}`;
      addLog(state, `${p.name}: ${p.allIn ? `올인 ${verb}` : verb} ${target}`);
      state.betActionSeq++;
      state.lastAggression = { idx, seq: state.betActionSeq, street: state.street };
      p.acted = true;
      p.actedLevel = state.currentBet;
      p.forcedCall = false;
      if (state.street === 'preflop') p.actedPreflop = true;
      afterBetAction(state, idx);
      return null;
    }
    default:
      return '알 수 없는 행동입니다.';
  }
  state.betActionSeq++;
  p.acted = true;
  p.actedLevel = state.currentBet;
  p.forcedCall = false;
  if (state.street === 'preflop') p.actedPreflop = true;
  afterBetAction(state, idx);
  return null;
}

function declareFreeRide(state: GameState, p: PlayerState): string | null {
  const aug = findAug(p, 'freeRide');
  if (!aug) return '무임승차 증강이 없습니다.';
  if ((aug.usesLeft ?? 0) <= 0) return '무임승차 남은 횟수가 없습니다.';
  const err = ACTIVE.freeRide!.check(ctxFor(state, p, aug), {}, false) ?? taxError(state, p);
  if (err) return err;
  declare(state, p, aug, {});
  return null;
}

// ───────────────────────── 세 번째 손 ─────────────────────────

function startDiscardPhase(state: GameState): boolean {
  const holders = state.players.filter((p) => live(p) && p.hole.length === 3);
  if (!holders.length) return false;
  // 암전 중(유리 테이블이 아니면)에는 자기 카드를 못 보므로 무작위로 버린다
  if (state.effects.blackout && !state.effects.glass) {
    for (const p of holders) p.pendingDiscard = state.rng.int(3);
    resolveDiscards(state);
    return true;
  }
  state.phase = 'discard';
  state.decisionSeq++;
  return true;
}

function applyDiscard(state: GameState, p: PlayerState, cardIndex: number): string | null {
  if (state.phase !== 'discard') return '지금은 카드를 버리는 단계가 아닙니다.';
  if (!live(p) || p.hole.length !== 3) return '버릴 카드가 없습니다.';
  if (p.pendingDiscard !== null) return '이미 선택했습니다.';
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex > 2) return '카드를 올바르게 선택하세요.';
  p.pendingDiscard = cardIndex;
  if (!discardPending(state).length) resolveDiscards(state);
  return null;
}

function discardPending(state: GameState): PlayerState[] {
  return state.players.filter((x) => live(x) && x.hole.length === 3 && x.pendingDiscard === null);
}

/** 모두 결정했거나 시간이 끝난 뒤 한 번에 처리 */
function resolveDiscards(state: GameState): void {
  for (const i of seatOrderFromDealer(state)) {
    const p = state.players[i];
    if (!live(p) || p.hole.length !== 3) continue;
    const idx = p.pendingDiscard ?? state.rng.int(3);
    const [card] = p.hole.splice(idx, 1);
    p.discarded.push(card);
    state.used.push({ card, kind: 'discard' });
    p.pendingDiscard = null;
    if (state.effects.blackout && !state.effects.glass) note(state, p, 'discard', '세 번째 손: 암전 중이라 무작위 1장을 버렸습니다.');
    else note(state, p, 'discard', `세 번째 손: ${cardToken(card)}을(를) 버렸습니다. 남은 홀카드 ${cardsText(p.hole)}`, [card]);
    const th = findAug(p, 'thirdHand');
    if (th) {
      countUse(state, 'thirdHand');
      announceNamed(state, p, th, '발동', '— 카드 1장을 버림');
    }
  }
  startBettingRound(state, state.dealerIdx);
}

// ───────────────────────── 선언 기회 (턴·리버 공개 직후) ─────────────────────────

function startDeclareWindow(state: GameState): boolean {
  state.phase = 'declare';
  const ops = opsFor(state);
  const queue = seatOrderFromDealer(state).filter((i) => {
    const p = state.players[i];
    return live(p) && windowOptions(state, ops, p).length > 0;
  });
  if (!queue.length) {
    state.phase = 'betting';
    return false;
  }
  state.declareQueue = queue;
  state.decisionSeq++;
  return true;
}

export function declareOptions(state: GameState, p: PlayerState): AugmentId[] {
  if (state.phase !== 'declare' || state.players[state.declareQueue[0]] !== p) return [];
  return windowOptions(state, opsFor(state), p);
}

function applyDeclare(state: GameState, idx: number, augment: AugmentId | null, boardIndex?: number): string | null {
  if (state.phase !== 'declare' || state.declareQueue[0] !== idx) return '지금은 선언할 차례가 아닙니다.';
  const p = state.players[idx];
  if (augment === null) {
    state.declareQueue.shift();
    advanceDeclare(state);
    return null;
  }
  if (!isAugmentId(augment) || !declareOptions(state, p).includes(augment)) return '지금 선언할 수 없는 증강입니다.';
  const aug = findAug(p, augment)!;
  const params: ActiveParams = augment === 'seal' ? { boardIndex } : {};
  const err = ACTIVE[augment]!.check(ctxFor(state, p, aug), params, false) ?? taxError(state, p);
  if (err) return err;
  declare(state, p, aug, params);
  return null;
}

function advanceDeclare(state: GameState): void {
  const ops = opsFor(state);
  while (state.declareQueue.length) {
    const p = state.players[state.declareQueue[0]];
    if (live(p) && windowOptions(state, ops, p).length) break;
    state.declareQueue.shift();
  }
  if (state.declareQueue.length) {
    state.decisionSeq++;
    return;
  }
  startBettingRound(state, state.dealerIdx);
}

// ───────────────────────── 증강 선언과 반응 대기 ─────────────────────────

/**
 * 액티브·공개형 증강 선언: 사용 횟수를 소모하고 알린 뒤 반응 대기열에 넣는다.
 * 효과는 3초 반응 대기(REACTION_MS)가 끝난 뒤 resolveReaction 에서 적용된다.
 */
function declare(state: GameState, p: PlayerState, aug: OwnedAugment, params: ActiveParams): void {
  const def = AUGMENTS[aug.id];
  const effect = ACTIVE[aug.id]!;
  const ctx = ctxFor(state, p, aug);
  if (def.uses?.per === 'game') aug.usesLeft = (aug.usesLeft ?? 0) - 1;
  if (def.uses?.per === 'hand') aug.usedThisHand = true;
  effect.consume?.(ctx, params);
  countUse(state, aug.id);
  // 죽음과 세금: 액티브·공개형 증강을 쓸 때마다 (공포탄 포함) 은행에 납부
  const taxPaid = payTax(state, p);
  const anonymous = def.disclosure === 'anonymous';
  const detail = effect.detail?.(ctx, params) ?? '';
  let publicName: string | null = null;
  if (anonymous) {
    announceAnonymous(state, p);
    addLog(state, `${p.name} ▸ ${augLabel(aug.id)} 사용${detail ? ` ${detail}` : ''} (상대에게는 "비공개 증강")`, { to: [p.id] });
  } else {
    publicName = AUGMENTS[revealAugment(state, p, aug)].name;
    announceNamed(state, p, aug, '선언', detail);
  }
  const decl: Declaration = {
    id: ++state.declSeq,
    ownerId: p.id,
    augment: aug.id,
    params: { ...params },
    anonymous,
    publicName,
    countered: false,
    counteredBy: null,
    taxPaid,
  };
  if (!state.reaction) {
    state.reaction = { queue: [decl], resume: state.phase };
    state.phase = 'reaction';
    state.decisionSeq++;
  } else {
    state.reaction.queue.push(decl);
  }
}

/** 카운터 스펠: 반응 대기 중인 다른 사람의 선언을 무효화 (대기 시간은 그대로 3초) */
function applyCounter(state: GameState, p: PlayerState): string | null {
  if (state.phase !== 'reaction' || !state.reaction) return '지금은 무효화할 증강이 없습니다.';
  const cs = findAug(p, 'counterSpell');
  if (!cs || (cs.usesLeft ?? 0) <= 0) return '카운터 스펠이 없습니다.';
  const head = state.reaction.queue[0];
  if (head.ownerId === p.id) return '자기 증강은 무효화할 수 없습니다.';
  if (head.countered) return '이미 무효화되었습니다.';
  const tax = taxError(state, p);
  if (tax) return tax;
  payTax(state, p);
  cs.usesLeft = 0;
  countUse(state, 'counterSpell');
  head.countered = true;
  head.counteredBy = p.id;
  const owner = playerById(state, head.ownerId)!;
  const label = head.anonymous ? '비공개 증강' : `「${head.publicName}」`;
  announceNamed(state, p, cs, '발동', `— ${owner.name}의 ${label}을(를) 무효화`);
  return null;
}

/** 반응 대기가 끝난 선언 하나를 처리한다 (서버 타이머가 3초 뒤 applyTimeouts 로 부름) */
export function resolveReaction(state: GameState): void {
  const r = state.reaction;
  if (state.phase !== 'reaction' || !r || !r.queue.length) return;
  const decl = r.queue.shift()!;
  state.phase = r.resume;
  const owner = playerById(state, decl.ownerId);
  const aug = owner ? findAug(owner, decl.augment) : undefined;
  if (owner && aug) {
    const effect = ACTIVE[decl.augment]!;
    const ctx = ctxFor(state, owner, aug);
    if (decl.countered) {
      addLog(state, `${owner.name}의 ${decl.anonymous ? '비공개 증강' : `「${decl.publicName}」`}이(가) 무효화되었습니다 (사용 횟수 소모)`);
      effect.onCountered?.(ctx, decl.params);
    } else {
      const err = owner.out ? '탈락' : owner.kicked ? '추방됨' : effect.check(ctx, decl.params, true);
      if (err) {
        // 상황이 바뀌어 효과가 성립하지 않으면 사용 횟수를 돌려준다
        const def = AUGMENTS[decl.augment];
        if (def.uses?.per === 'game') aug.usesLeft = (aug.usesLeft ?? 0) + 1;
        if (def.uses?.per === 'hand') aug.usedThisHand = false;
        if (decl.taxPaid) {
          owner.chips += decl.taxPaid;
          state.stats.bankTaxed -= decl.taxPaid;
          if (owner.chips > 0 && !owner.wentAllIn) owner.allIn = false;
        }
        addLog(state, `${augLabel(decl.augment)} 효과가 적용되지 않았습니다: ${err} (횟수·세금 반환)`, { to: [owner.id] });
      } else {
        effect.resolve(ctx, decl.params, decl);
      }
    }
  }
  if (r.queue.length && state.phase !== 'gameOver') {
    r.resume = state.phase;
    state.phase = 'reaction';
    state.decisionSeq++;
    return;
  }
  state.reaction = null;
  continueAfterReaction(state);
}

/** 반응 대기 후 원래 단계의 흐름을 이어 간다 (효과로 상황이 바뀌었을 수 있음) */
function continueAfterReaction(state: GameState): void {
  const liveCount = state.players.filter(live).length;
  switch (state.phase) {
    case 'betting':
      if (liveCount <= 1) return endHandUncontested(state, state.players.find(live)!);
      if (roundComplete(state)) return closeRound(state);
      if (state.toAct === null || !needsToAct(state, state.players[state.toAct])) {
        state.toAct = nextIdx(state, state.toAct ?? state.dealerIdx, (p) => needsToAct(state, p));
      }
      state.decisionSeq++;
      return;
    case 'discard':
      if (liveCount <= 1) return endHandUncontested(state, state.players.find(live)!);
      if (!discardPending(state).length) return resolveDiscards(state);
      state.decisionSeq++;
      return;
    case 'declare':
      if (liveCount <= 1) return endHandUncontested(state, state.players.find(live)!);
      return advanceDeclare(state);
    default:
      state.decisionSeq++;
  }
}

/** 반응 대기 중 카운터 스펠을 쓸 수 있는 사람 (봇 판단용, 화면에는 본인 것만 보임) */
export function counterCandidates(state: GameState): string[] {
  const head = state.reaction?.queue[0];
  if (state.phase !== 'reaction' || !head || head.countered) return [];
  return state.players
    .filter((p) => active(p) && p.id !== head.ownerId && (findAug(p, 'counterSpell')?.usesLeft ?? 0) > 0)
    .map((p) => p.id);
}

// ───────────────────────── 쇼다운 ─────────────────────────

const VARIANT_AUG: Record<AppliedVariant, AugmentId> = {
  fourFlush: 'fourFlush',
  gapStraight: 'gapStraight',
  wrapStraight: 'wrapStraight',
  wild: 'favoritism',
};

export function tableEffectNotes(state: GameState): string[] {
  const e = state.effects;
  const out: string[] = [];
  if (e.flips % 2 === 1) out.push('족보 역전 (가장 낮은 패가 승리)');
  else if (e.flips > 0) out.push('족보 역전 상쇄 (원래 순위)');
  if (e.sealed.length) out.push(`봉인: ${cardsText(e.sealed.map((i) => state.board[i]))}`);
  if (e.fogSeers.length) out.push('짙은 안개');
  if (e.glass) out.push('유리 테이블');
  if (e.blackout) out.push('암전');
  if (e.rewinds) out.push(`되감기 ${e.rewinds}회`);
  return out;
}

function showdown(state: GameState): void {
  state.effects.fogLifted = true;
  const order = seatOrderFromDealer(state);
  const board = evalBoard(state);
  const inverted = state.effects.flips % 2 === 1;
  const entries: ShowdownEntry[] = [];
  const contenders = new Map<string, Contender>();
  for (const i of order) {
    const p = state.players[i];
    if (!live(p)) continue;
    p.shown = true;
    const ev = evaluatePlayerHand(p.hole, board, rulesFor(p));
    entries.push({ id: p.id, cards: [...p.hole], handName: ev.value.name, bestCards: ev.value.cards, score: ev.value.score, applied: ev.applied, tiebreak: [] });
    contenders.set(p.id, {
      id: p.id,
      score: ev.value.score,
      bestCards: ev.value.cards,
      kickerMaster: !!findAug(p, 'kickerMaster'),
      absoluteKicker: !!findAug(p, 'absoluteKicker'),
    });
  }
  const table = tableEffectNotes(state);
  addLog(state, `쇼다운${table.length ? ` — ${table.join(', ')}` : ''}`);
  if (state.effects.fogSeers.length) addLog(state, `안개가 걷힘 — 플랍: ${cardsText(state.board.slice(0, 3))}`);
  for (const e of entries) {
    const p = playerById(state, e.id)!;
    const variants = e.applied.map((v) => VARIANT_LABEL[v]);
    addLog(state, `${p.name}: ${cardsText(e.cards)} — ${e.handName}${variants.length ? ` (${variants.join(', ')})` : ''}`);
    for (const v of e.applied) {
      const aug = findAug(p, VARIANT_AUG[v]);
      if (aug) {
        countUse(state, aug.id);
        announceNamed(state, p, aug, '발동', '— 족보에 적용');
      }
    }
  }
  const pots = computePots(
    state.players.filter((p) => p.inHand).map((p) => ({ id: p.id, contributed: p.contributed, folded: p.folded })),
    state.deadMoney,
  );
  const won: Record<string, number> = {};
  const potResults = pots.map((pot, k) => {
    const decision = decidePot(
      pot.eligible.map((id) => contenders.get(id)!).filter(Boolean),
      { inverted, board },
    );
    for (const [id, tags] of Object.entries(decision.decidedBy)) {
      const entry = entries.find((x) => x.id === id)!;
      const p = playerById(state, id)!;
      for (const t of tags) {
        if (!entry.tiebreak.includes(t)) {
          entry.tiebreak.push(t);
          const aug = findAug(p, t);
          if (aug) {
            countUse(state, t);
            announceNamed(state, p, aug, '발동', '— 동점 상황에서 승리');
          }
        }
      }
    }
    const ordered = order.map((i) => state.players[i].id).filter((id) => decision.winners.includes(id));
    for (const [id, amt] of splitPot(pot.amount, ordered)) {
      won[id] = (won[id] ?? 0) + amt;
      playerById(state, id)!.chips += amt;
    }
    const label = pots.length > 1 ? (k === 0 ? '메인팟' : `사이드팟 ${k}`) : '팟';
    addLog(state, `${ordered.map((id) => playerById(state, id)!.name).join(', ')} ${label} ${pot.amount}칩 획득${ordered.length > 1 ? ' (분할)' : ''}`);
    return { amount: pot.amount, eligible: pot.eligible, winners: ordered };
  });
  finishHand(state, {
    hand: state.handNumber,
    showdown: true,
    board: [...state.board],
    sealed: [...state.effects.sealed],
    entries,
    pots: potResults,
    won,
    table,
    extras: [],
  });
}

function endHandUncontested(state: GameState, winner: PlayerState): void {
  state.reaction = null;
  returnUncalled(state);
  const total = state.players.reduce((s, p) => s + p.contributed, 0) + state.deadMoney;
  winner.chips += total;
  addLog(state, `${winner.name} 팟 ${total}칩 획득 (나머지 모두 폴드)`);
  finishHand(state, {
    hand: state.handNumber,
    showdown: false,
    board: state.board.slice(0, state.boardRevealed),
    sealed: [...state.effects.sealed],
    entries: [],
    pots: [{ amount: total, eligible: [winner.id], winners: [winner.id] }],
    won: { [winner.id]: total },
    table: tableEffectNotes(state),
    extras: [],
  });
}

function finishHand(state: GameState, result: HandResult): void {
  state.toAct = null;
  state.declareQueue = [];
  runHandEndHooks(state, result);
  state.result = result;
  const aliveBefore = state.players.filter(active).length;
  const busted = state.players
    .filter((p) => active(p) && p.chips <= 0)
    .sort((a, b) => b.contributed + b.mulliganFee - (a.contributed + a.mulliganFee));
  busted.forEach((p, k) => {
    p.out = true;
    p.outAtHand = state.handNumber;
    p.place = aliveBefore - (busted.length - 1) + k;
    p.sittingOut = false;
    p.attachPending = false;
    addLog(state, `${p.name} 탈락 (${p.place}위)`);
  });
  const remaining = state.players.filter(active);
  if (remaining.length <= 1) {
    endGame(state, remaining[0] ?? null);
    return;
  }
  state.phase = 'handEnd';
  state.decisionSeq++;
}

function applyAttach(state: GameState, p: PlayerState, cardIndex: number): string | null {
  if (state.phase !== 'handEnd' || !p.attachPending) return '지금은 가져갈 카드를 고를 수 없습니다.';
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= p.hole.length) return '카드를 올바르게 고르세요.';
  p.keptCard = p.hole[cardIndex];
  p.attachPending = false;
  countUse(state, 'attachment');
  note(state, p, 'info', `애착: ${cardToken(p.keptCard)}을(를) 다음 핸드로 가져갑니다.`, [p.keptCard]);
  return null;
}

/** 핸드 종료 화면 이후 다음 핸드로 (서버가 잠시 기다렸다가 호출) */
export function startNextHand(state: GameState): ActionResult {
  if (state.phase !== 'handEnd') return { ok: false, error: '핸드가 끝나지 않았습니다.' };
  // 애착 선택을 안 했으면 높은 카드를 가져간다
  for (const p of state.players) {
    if (p.attachPending) {
      const best = [...p.hole].sort((a, b) => rankOf(b) - rankOf(a))[0];
      applyAttach(state, p, p.hole.indexOf(best));
    }
  }
  if (!betweenHands(state)) return { ok: true };
  state.handNumber++;
  const due = state.handNumber >= state.levelStartHand + state.levelHands;
  if (due || state.forceLevelUp) {
    state.forceLevelUp = false;
    state.levelIndex++;
    state.levelStartHand = state.handNumber;
    // 자동 주기는 이 레벨이 시작될 때 남은 인원(중도 참여자 포함)으로 다시 계산한다
    state.levelHands = levelHandsFor(state);
    const { sb, bb } = currentBlinds(state);
    addLog(state, `블라인드 상승! 레벨 ${state.levelIndex + 1}: ${sb}/${bb} (${state.levelHands}핸드)`);
    startPickRound(state);
  } else {
    beginHand(state);
  }
  return { ok: true };
}

// ───────────────────────── 증강 사용 (버튼·토글) ─────────────────────────

function applyUseAugment(state: GameState, p: PlayerState, a: Extract<GameAction, { type: 'useAugment' }>): string | null {
  if (state.phase === 'gameOver') return '게임이 끝났습니다.';
  if (p.out) return '탈락한 플레이어는 증강을 쓸 수 없습니다.';
  if (!isAugmentId(a.augment)) return '알 수 없는 증강입니다.';
  const aug = findAug(p, a.augment);
  if (!aug) return '보유하지 않은 증강입니다.';
  const def = AUGMENTS[aug.id];
  // 토글형: 비공개로 켜고 끈다 (알림 없음)
  if (aug.id === 'exemption') {
    const on = typeof a.on === 'boolean' ? a.on : !aug.armed;
    if (on && (aug.usesLeft ?? 0) <= 0) return '남은 사용 횟수가 없습니다.';
    aug.armed = on;
    addLog(state, `면제권 자동 사용: ${on ? '켜짐' : '꺼짐'}`, { to: [p.id] });
    return null;
  }
  if (aug.id === 'disguise') {
    if ((aug.usesLeft ?? 0) <= 0) return '이미 사용한 위장입니다.';
    const fake = a.fakeId ?? null;
    if (fake !== null && (!isAugmentId(fake) || fake === 'disguise')) return '가짜 증강을 올바르게 선택하세요.';
    aug.fakeId = fake;
    addLog(state, fake ? `위장 준비: 다음에 이름이 공개되는 증강은 ${augLabel(fake)}(으)로 보입니다.` : '위장 준비 해제', { to: [p.id] });
    return null;
  }
  switch (def.trigger) {
    case 'passive':
      return '자동으로 발동하는 증강입니다.';
    case 'window':
      return '턴·리버 공개 직후 선언 기회가 오면 쓸 수 있습니다.';
    case 'call':
      return '콜할 때 무임승차 버튼으로 쓸 수 있습니다.';
    case 'reaction':
      return '다른 사람의 증강 반응 대기 중에 쓸 수 있습니다.';
  }
  if (def.uses?.per === 'game' && (aug.usesLeft ?? 0) <= 0) return '남은 사용 횟수가 없습니다.';
  if (def.uses?.per === 'hand' && aug.usedThisHand) return '이번 핸드에 이미 사용했습니다.';
  const effect = ACTIVE[aug.id];
  if (!effect) return '사용할 수 없는 증강입니다.';
  const params: ActiveParams = {};
  if (typeof a.targetId === 'string') params.targetId = a.targetId;
  if (typeof a.cardIndex === 'number') params.cardIndex = a.cardIndex;
  if (typeof a.card === 'string') params.card = a.card;
  const err = effect.check(ctxFor(state, p, aug), params, false) ?? taxError(state, p);
  if (err) return err;
  declare(state, p, aug, params);
  return null;
}

/** 지금 버튼으로 선언할 수 있는가 (화면 안내용; 최종 검증은 applyAction) */
export function canUseNow(state: GameState, p: PlayerState, aug: OwnedAugment, params: ActiveParams = {}): string | null {
  if (state.phase === 'gameOver' || p.out) return '게임에 참여하고 있지 않습니다.';
  const def = AUGMENTS[aug.id];
  if (def.uses?.per === 'game' && (aug.usesLeft ?? 0) <= 0) return '남은 사용 횟수가 없습니다.';
  if (def.uses?.per === 'hand' && aug.usedThisHand) return '이번 핸드에 이미 사용했습니다.';
  const effect = ACTIVE[aug.id];
  if (!effect || def.trigger !== 'button') return def.timing;
  return effect.check(ctxFor(state, p, aug), params, false) ?? taxError(state, p);
}

// ───────────────────────── 공개 API ─────────────────────────

export function applyAction(state: GameState, playerId: string, action: GameAction): ActionResult {
  const joiner = getJoiner(state, playerId);
  if (joiner) {
    // 자리에 앉기 전에는 증강 선택만 할 수 있다
    if (!action || typeof action !== 'object' || action.type !== 'pick') return { ok: false, error: '다음 핸드부터 참여합니다.' };
    const err = isAugmentId(action.augment) ? applyJoinerPick(state, joiner, action.augment) : '알 수 없는 증강입니다.';
    return err ? { ok: false, error: err } : { ok: true };
  }
  const idx = idxOf(state, playerId);
  if (idx < 0) return { ok: false, error: '플레이어를 찾을 수 없습니다.' };
  const p = state.players[idx];
  if (p.kicked) return { ok: false, error: '추방된 플레이어입니다.' };
  if (!action || typeof action !== 'object' || typeof (action as { type?: unknown }).type !== 'string') {
    return { ok: false, error: '잘못된 요청입니다.' };
  }
  let err: string | null;
  switch (action.type) {
    case 'fold':
    case 'check':
    case 'call':
    case 'raise':
    case 'allin':
      if (p.out) return { ok: false, error: '탈락했습니다.' };
      err = applyBet(state, idx, action);
      break;
    case 'pick':
      err = isAugmentId(action.augment) ? applyPick(state, p, action.augment) : '알 수 없는 증강입니다.';
      break;
    case 'discard':
      err = applyDiscard(state, p, action.cardIndex);
      break;
    case 'declare':
      err = applyDeclare(state, idx, action.augment ?? null, action.boardIndex);
      break;
    case 'counter':
      err = applyCounter(state, p);
      break;
    case 'attach':
      err = applyAttach(state, p, action.cardIndex);
      break;
    case 'useAugment':
      err = applyUseAugment(state, p, action);
      break;
    default:
      err = '알 수 없는 행동입니다.';
  }
  return err ? { ok: false, error: err } : { ok: true };
}

export function getPending(state: GameState): Pending {
  const seq = state.decisionSeq;
  switch (state.phase) {
    case 'augmentSelect':
      return { seq, kind: 'pick', playerIds: state.players.filter((p) => p.pickOptions).map((p) => p.id) };
    case 'betting':
      return { seq, kind: 'turn', playerIds: state.toAct !== null ? [state.players[state.toAct].id] : [] };
    case 'discard':
      return { seq, kind: 'discard', playerIds: discardPending(state).map((p) => p.id) };
    case 'declare':
      return { seq, kind: 'declare', playerIds: state.declareQueue.length ? [state.players[state.declareQueue[0]].id] : [] };
    case 'reaction':
      return { seq, kind: 'reaction', playerIds: [] };
    case 'handEnd':
      return { seq, kind: 'handEnd', playerIds: state.players.filter((p) => p.attachPending).map((p) => p.id) };
    default:
      return { seq, kind: 'none', playerIds: [] };
  }
}

/** 시간 초과/자리 비움 시 대신 할 기본 행동 */
export function defaultActionFor(state: GameState, playerId: string): GameAction | null {
  const pending = getPending(state);
  if (!pending.playerIds.includes(playerId)) return null;
  const p = playerById(state, playerId)!;
  switch (pending.kind) {
    case 'pick':
      return { type: 'pick', augment: pickOne(p.pickOptions!, state.rng) };
    case 'turn':
      if (owed(state, p) === 0) return { type: 'check' };
      return p.forcedCall ? { type: 'call' } : { type: 'fold' };
    case 'discard':
      return { type: 'discard', cardIndex: state.rng.int(3) };
    case 'declare':
      return { type: 'declare', augment: null };
    case 'handEnd': {
      const best = [...p.hole].sort((a, b) => rankOf(b) - rankOf(a))[0];
      return { type: 'attach', cardIndex: Math.max(0, p.hole.indexOf(best)) };
    }
    default:
      return null;
  }
}

/** 현재 대기 중인 결정에 기본 행동을 적용 (제한 시간 종료). 반응 대기는 선언 하나를 처리 */
export function applyTimeouts(state: GameState): string[] {
  const pending = getPending(state);
  if (pending.kind === 'reaction') {
    resolveReaction(state);
    return [];
  }
  const affected: string[] = [];
  for (const id of pending.playerIds) {
    const act = defaultActionFor(state, id);
    if (!act) continue;
    if (pending.kind === 'turn') addLog(state, `${playerById(state, id)!.name}: 시간 초과`);
    if (applyAction(state, id, act).ok) affected.push(id);
  }
  return affected;
}

export interface LegalActions {
  fold: boolean;
  check: boolean;
  call: boolean;
  callAmount: number;
  raise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
  allIn: boolean;
  allInAmount: number;
  opening: boolean;
  /** 무임승차 콜 가능 (콜 금액의 절반) */
  freeRide: boolean;
  freeRideAmount: number;
  /** 강제 집행 대상 (폴드 불가) */
  forced: boolean;
}

export function legalActions(state: GameState, playerId: string): LegalActions | null {
  const idx = idxOf(state, playerId);
  if (state.phase !== 'betting' || state.toAct !== idx || idx < 0) return null;
  const p = state.players[idx];
  const toCall = owed(state, p);
  const level = p.streetBet + p.streetShort;
  const maxTo = level + p.chips;
  const raise = !p.forcedCall && canRaise(state, p) && othersCanRespond(state, p) && p.chips > toCall;
  const fr = findAug(p, 'freeRide');
  const freeRide = !!fr && (fr.usesLeft ?? 0) > 0 && !ACTIVE.freeRide!.check(ctxFor(state, p, fr), {}, false) && !taxError(state, p);
  return {
    fold: !p.forcedCall,
    check: toCall === 0,
    call: toCall > 0,
    callAmount: Math.min(toCall, p.chips),
    raise,
    minRaiseTo: Math.min(state.currentBet + state.minRaise, maxTo),
    maxRaiseTo: maxTo,
    allIn: p.chips > 0 && (raise || p.chips <= toCall),
    allInAmount: maxTo,
    opening: state.currentBet === 0,
    freeRide,
    freeRideAmount: Math.min(Math.ceil(toCall / 2), p.chips),
    forced: p.forcedCall,
  };
}

export function setSittingOut(state: GameState, playerId: string, value: boolean): void {
  const p = playerById(state, playerId);
  if (!p || p.out || p.kicked) return;
  if (p.sittingOut !== value) {
    p.sittingOut = value;
    addLog(state, value ? `${p.name}: 자리 비움 (블라인드만 내고 자동 폴드)` : `${p.name}: 자리 복귀`);
  }
}

export function getPlayer(state: GameState, playerId: string): PlayerState | undefined {
  return playerById(state, playerId);
}

export { basePhase };
