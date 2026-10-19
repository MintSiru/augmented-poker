// 게임 진행 엔진: 핸드 진행, 베팅 검증, 증강 선언·반응 대기·적용, 쇼다운.
// 네트워크/화면 코드를 참조하지 않는 순수 모듈. 증강 효과는 effects.ts 레지스트리를 통해 부른다.

import { Card, cardToken, fullDeck, rankName, rankOf } from './cards.js';
import { AUGMENTS, AugmentId, isAugmentId, rollAugmentOffer } from './augments.js';
import { evaluatePlayerHand, VARIANT_LABEL, Category, CATEGORY_NAMES } from './evaluator.js';
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
  VARIANT_AUG,
  boardBlindIds,
  invertedNow,
  turnCutFor,
  logBoard,
  flopCount,
  lockError,
  ownCardsHidden,
  seatOrderFromDealer,
  taxError,
} from './core.js';
import { ACTIVE, Ctx, EngineOps, holeCardCount, PASSIVE, TASKS, windowOptions, windowTargets } from './effects.js';
import { decidePot, type Contender, type PotDecision } from './showdown.js';
import { contenderFor, handEvalFor } from './standing.js';
import type {
  ActionResult,
  ActiveParams,
  BetAction,
  Declaration,
  GameAction,
  GameState,
  HandResult,
  Joiner,
  PotResult,
  PotUnit,
  OwnedAugment,
  RespondAnswer,
  RespondState,
  Pending,
  Phase,
  PlayerState,
  ShowdownEntry,
  BlindSchedule,
  LevelMode,
  RoundState,
  TableEffects,
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
    blindPosted: 0,
    blindsPaid: 0,
    ironWall: false,
    blackjackOn: false,
    betPrediction: null,
    destinyCard: null,
    lockerPending: false,
    lockerStored: null,
    lockerReady: null,
    eitherOr: null,
    lateLosses: 0,
    showPending: false,
    turnRiver: null,
    drawPrompt: null,
    truthClaim: null,
    contract: null,
  };
}

export function freshEffects(): TableEffects {
  return {
    glass: false,
    blackout: false,
    fogSeers: [],
    fogLifted: false,
    flips: 0,
    rewinds: 0,
    sealed: [],
    blindDarted: [],
    bomb: false,
    underdog: false,
    blackoutImmune: [],
    glassImmune: [],
    restarted: false,
    glasses: [],
    glassesImmune: [],
    glassesSeq: 0,
    highLow: false,
    lastStand: false,
    lastStandImmune: [],
    capitalism: false,
    magnet: null,
    twoFates: false,
  };
}

export const DEFAULT_REVEAL_PLAN: readonly number[] = [3, 4, 5];
export const REVERSE_REVEAL_PLAN: readonly number[] = [1, 2, 5];

function freshRound(state: GameState | null, firstFrom: number): RoundState {
  const startBets: Record<string, number> = {};
  for (const p of state?.players ?? []) startBets[p.id] = p.streetBet;
  return {
    raises: 0,
    actions: 0,
    startBets,
    startCurrentBet: state?.currentBet ?? 0,
    startMinRaise: state?.minRaise ?? 0,
    startSetter: state?.betSetter ? { ...state.betSetter } : null,
    firstFrom,
    raiseCap: null,
    locked: false,
    maxPut: null,
    capitalDone: false,
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
    board2: null,
    revealPlan: [...DEFAULT_REVEAL_PLAN],
    extraCards: 0,
    reservedPublic: [],
    fixedIdx: [],
    nextHand: { reverse: false, prophecy: false, freezeCard: null },
    windowStage: null,
    capitalChooser: null,
    respond: null,
    respondSeq: 0,
    auctionCard: null,
    staredown: null,
    nameItWinner: null,
    tasks: [],
    used: [],
    effects: freshEffects(),
    blackoutNext: false,
    blackoutBy: null,
    blackoutImmuneNext: [],
    bombNext: false,
    underdogLeft: 0,
    taxExempt: {},
    round: freshRound(null, 0),
    lastFolderId: null,
    heaven: [],
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
    stats: { picks: {}, uses: {}, bankChips: 0, bankTaxed: 0, bankPaid: 0, joinChips: 0, kickedChips: 0, heavenFolds: 0 },
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
    restartRound: () => restartRound(state),
    highCardDuel: () => highCardDuel(state),
    restartHand: (p) => restartHand(state, p),
    addBoardCard: (label) => addBoardCard(state, label),
    fold: (p, forced) => doFold(state, p, forced),
    afterBet: (idx) => {
      state.betActionSeq++;
      afterBetAction(state, idx);
    },
    startRespond: (spec) => startRespond(state, spec),
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

export function grantAugment(state: GameState, p: PlayerState, id: AugmentId, wildRank?: number, parity?: 'even' | 'odd'): OwnedAugment {
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
  if (id === 'parity') aug.parity = parity ?? (state.rng.int(2) ? 'even' : 'odd');
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
function applyJoinerPick(state: GameState, j: Joiner, augment: AugmentId, parity?: 'even' | 'odd'): string | null {
  const p = j.player;
  if (!p.pickOptions) return '선택할 증강이 없습니다.';
  if (!p.pickOptions.includes(augment)) return '선택지에 없는 증강입니다.';
  const aug = grantAugment(state, p, augment, undefined, parity);
  j.picksLeft--;
  const extra = pickExtra(aug);
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
  // 제안·입찰 응답을 기다리던 사람이면 기다리지 않는다
  if (state.phase === 'respond' && !respondPending(state).length) finishRespond(state);
  // 빌린 칩은 사라진다
  dropTasksOf(state, p.id);
  if (state.phase === 'augmentSelect' && !state.players.some((x) => x.pickOptions)) beginHand(state);
  state.decisionSeq++;
  return { ok: true };
}

function pickExtra(aug: OwnedAugment): string {
  if (aug.wildRank) return ` — 와일드 숫자: ${rankName(aug.wildRank)} (나에게만 보임)`;
  if (aug.parity) return ` — ${aug.parity === 'even' ? '짝수(2·4·6·8·10·Q)' : '홀수(3·5·7·9·J·K)'} 동맹`;
  return '';
}

const parityArg = (v: unknown) => (v === 'even' || v === 'odd' ? v : undefined);

function applyPick(state: GameState, p: PlayerState, augment: AugmentId, parity?: 'even' | 'odd'): string | null {
  if (state.phase !== 'augmentSelect') return '지금은 증강 선택 단계가 아닙니다.';
  if (!p.pickOptions) return '선택할 증강이 없습니다.';
  if (!p.pickOptions.includes(augment)) return '선택지에 없는 증강입니다.';
  const aug = grantAugment(state, p, augment, undefined, parity);
  p.pickOptions = null;
  const extra = pickExtra(aug);
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
    p.blindPosted = 0;
    p.ironWall = false;
    p.blackjackOn = false;
    p.betPrediction = null;
    p.eitherOr = null;
    p.showPending = false;
    p.turnRiver = null;
    p.drawPrompt = null;
    p.truthClaim = null;
    p.contract = null;
    for (const a of p.augments) a.usedThisHand = false;
  }
  state.board = [];
  state.board2 = null;
  state.revealPlan = [...DEFAULT_REVEAL_PLAN];
  state.extraCards = 0;
  state.reservedPublic = [];
  state.fixedIdx = [];
  state.windowStage = null;
  state.capitalChooser = null;
  state.respond = null;
  state.auctionCard = null;
  state.staredown = null;
  state.nameItWinner = null;
  state.burns = [];
  state.boardRevealed = 0;
  state.deck = [];
  state.used = [];
  state.effects = freshEffects();
  state.lastFolderId = null;
  state.round = freshRound(null, 0);
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
  const seated = state.players.filter(active);
  // 반드시 필요한 카드: 보드 5 + 번 3 + 홀카드. 교체용 카드(멀리건·되감기 등)는 쓸 때 덱에 남아 있는지 확인한다
  const mandatory = 5 + 3 + seated.reduce((n, p) => n + holeCardCount(p), 0);
  if (mandatory > 52) throw new Error(`카드가 부족합니다 (필요 ${mandatory}장)`);
  const deal = state.nextDeal;
  state.nextDeal = null;
  // 애착으로 가져온 카드, 보관함에 보관한 카드는 이번 핸드 덱에서 제외
  const kept = new Map<string, Card>();
  const reserved = new Set<Card>();
  for (const p of state.players) {
    if (p.keptCard) {
      reserved.add(p.keptCard);
      if (active(p)) kept.set(p.id, p.keptCard);
    }
    p.keptCard = null;
    p.lockerReady = null;
    if (p.lockerStored) {
      reserved.add(p.lockerStored);
      if (active(p)) {
        p.lockerReady = p.lockerStored;
        note(state, p, 'info', `보관함: 보관한 ${cardToken(p.lockerStored)}을(를) 이번 프리플랍에 홀카드 1장과 바꿀 수 있습니다.`, [p.lockerStored]);
      }
      p.lockerStored = null;
    }
  }
  const pool = shuffle(fullDeck().filter((c) => !reserved.has(c)), state.rng);
  const take = (fixed: Card[] | undefined, n: number): Card[] => {
    const out: Card[] = [];
    for (const c of fixed ?? []) {
      if (out.length >= n) break;
      const i = pool.indexOf(c);
      if (i >= 0) out.push(pool.splice(i, 1)[0]);
    }
    return out;
  };
  // 데스티니 드로우: 고른 카드를 먼저 떼어 둔다
  const destiny = new Map<string, Card>();
  for (const p of state.players) {
    const c = p.destinyCard;
    p.destinyCard = null;
    if (!c || !active(p)) continue;
    const i = pool.indexOf(c);
    if (i >= 0) destiny.set(p.id, pool.splice(i, 1)[0]);
    else note(state, p, 'info', `데스티니 드로우: ${cardToken(c)}을(를) 받을 수 없어 무작위로 받습니다.`);
  }
  const fixedBoard = take(deal?.board, 5);
  const fixedBurns = take(deal?.burns, 3);
  const fixedDeck = take(deal?.deck, 52);
  const own = (p: PlayerState) => [...(kept.has(p.id) ? [kept.get(p.id)!] : []), ...(destiny.has(p.id) ? [destiny.get(p.id)!] : [])];
  const fixedHands = new Map<string, Card[]>();
  for (const p of seated) fixedHands.set(p.id, take(deal?.hands?.[p.id], Math.max(0, holeCardCount(p) - own(p).length)));
  // 보드 5장과 번 카드 3장은 핸드 시작 시 미리 떼어 둔다 (예지로 본 순서 그대로 나오도록)
  // 예약 카드: 동결(다음 플랍에 포함), 미리 온 결말(리버)
  const slots: (Card | null)[] = [null, null, null, null, null];
  const nh = state.nextHand;
  if (nh.freezeCard) {
    const i = pool.indexOf(nh.freezeCard);
    const at = state.rng.int(3);
    if (i >= 0) {
      slots[at] = pool.splice(i, 1)[0];
      state.reservedPublic.push({ index: at, card: slots[at]!, label: '동결: 이번 플랍에 포함' });
      state.fixedIdx.push(at);
      addLog(state, `동결: ${cardToken(slots[at]!)}이(가) 이번 플랍에 포함됩니다`);
    }
  }
  if (nh.prophecy) {
    const c = pool.splice(state.rng.int(pool.length), 1)[0];
    slots[4] = c;
    state.reservedPublic.push({ index: 4, card: c, label: '미리 온 결말: 리버' });
    state.fixedIdx.push(4);
    addLog(state, `미리 온 결말: 이번 핸드의 리버는 ${cardToken(c)}로 예약되었습니다`);
  }
  state.nextHand = { ...nh, prophecy: false, freezeCard: null };
  const fill = [...fixedBoard];
  state.board = slots.map((c) => c ?? fill.shift() ?? pool.shift()!);
  state.burns = [...fixedBurns, ...pool.splice(0, 3 - fixedBurns.length)];
  for (const i of seatOrderFromDealer(state)) {
    const p = state.players[i];
    if (!active(p)) continue;
    const fixed = [...own(p), ...fixedHands.get(p.id)!];
    p.hole = [...fixed, ...pool.splice(0, Math.max(0, holeCardCount(p) - fixed.length))];
    p.inHand = true;
  }
  state.deck = [...fixedDeck, ...pool];
}

function beginHand(state: GameState): void {
  if (!betweenHands(state)) return;
  resetHandState(state);
  state.phase = 'betting';
  state.effects.blackout = state.blackoutNext;
  state.effects.blackoutImmune = state.blackoutNext ? [...state.blackoutImmuneNext] : [];
  state.blackoutNext = false;
  state.blackoutBy = null;
  state.blackoutImmuneNext = [];
  state.effects.bomb = state.bombNext;
  state.bombNext = false;
  if (state.nextHand.reverse) {
    state.revealPlan = [...REVERSE_REVEAL_PLAN];
    state.nextHand.reverse = false;
  }
  if (state.underdogLeft > 0) {
    state.effects.underdog = true;
    state.underdogLeft--;
  }
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
  logHandStart(state);
  postBlindsAndStart(state);
}

function logHandStart(state: GameState): void {
  const { bb } = currentBlinds(state);
  if (state.effects.blackout) addLog(state, '암전: 이번 핸드는 모두 자기 홀카드를 보지 못한 채 진행합니다');
  if (state.effects.underdog) addLog(state, `언더독: 이번 핸드는 족보 순위가 뒤바뀝니다 (이후 ${state.underdogLeft}핸드 더)`);
  if (state.effects.bomb) addLog(state, `폭탄 팟: 전원 ${3 * bb}칩을 내고 바로 플랍을 공개합니다`);
  if (state.revealPlan[0] !== 3) addLog(state, '거꾸로 강을 거슬러: 이번 핸드는 보드가 1장 → 1장 → 3장 순서로 공개됩니다');
  for (const p of state.players) {
    if (!p.inHand) continue;
    if (ownCardsHidden(state, p)) addLog(state, `내 홀카드: ${p.hole.length}장 (암전 — 볼 수 없음)`, { to: [p.id] });
    else addLog(state, `내 홀카드: ${cardsText(p.hole)}`, { to: [p.id] });
  }
}

/** 블라인드(폭탄 팟이면 전원 3BB)를 받고 첫 베팅 라운드를 시작한다 */
function postBlindsAndStart(state: GameState): void {
  const { sb, bb } = currentBlinds(state);
  if (state.effects.bomb) {
    for (const p of state.players) {
      if (!p.inHand || p.folded) continue;
      const paid = putChips(p, 3 * bb - p.blindPosted);
      p.blindPosted += paid;
      p.lastAction = p.allIn ? `앤티 ${p.contributed} (올인)` : `앤티 ${p.contributed}`;
    }
    state.sbIdx = -1;
    state.bbIdx = -1;
    state.currentBet = 0;
    state.minRaise = bb;
    state.betSetter = null;
    // 프리플랍 베팅 없이 바로 플랍
    closeRound(state);
    return;
  }
  // 블라인드 (면제권을 켜 둔 사람은 블라인드 대신 면제권 선언 → 반응 대기)
  if (state.effects.restarted) {
    state.currentBet = bb;
  } else {
    postBlind(state, state.sbIdx, sb, 'SB');
    postBlind(state, state.bbIdx, bb, 'BB');
    state.currentBet = bb;
  }
  state.minRaise = bb;
  state.betSetter = { idx: state.bbIdx, raise: false };
  if ((state.phase as Phase) === 'reaction') {
    state.toAct = nextIdx(state, state.bbIdx, (p) => needsToAct(state, p));
    if (state.toAct < 0) state.toAct = null;
    state.round = freshRound(state, state.bbIdx);
    return;
  }
  startBettingRound(state, state.bbIdx);
}

function postBlind(state: GameState, idx: number, amount: number, label: 'SB' | 'BB'): void {
  const p = state.players[idx];
  // 모범납세자: 블라인드를 4번 낼 때마다 다음 블라인드 1번 면제 (아무도 내지 않음)
  const mt = findAug(p, 'modelTaxpayer');
  if (mt && p.blindsPaid >= 4) {
    p.blindsPaid = 0;
    p.lastAction = `${label} 면제`;
    countUse(state, 'modelTaxpayer');
    announceNamed(state, p, mt, '발동', `— ${label} 면제 (블라인드 4번 납부)`);
    return;
  }
  const ex = findAug(p, 'exemption');
  if (ex && ex.armed && (ex.usesLeft ?? 0) > 0) {
    const tax = taxError(state, p);
    if (tax) {
      addLog(state, `${tax} (면제권 미발동)`, { to: [p.id] });
      payBlind(p, amount, label);
      return;
    }
    declare(state, p, ex, { blind: label });
    if (ex.usesLeft === 0) ex.armed = false;
    return;
  }
  payBlind(p, amount, label);
}

export function payBlind(p: PlayerState, amount: number, label: 'SB' | 'BB'): void {
  const paid = putChips(p, amount);
  p.blindPosted += paid;
  if (paid > 0 && findAug(p, 'modelTaxpayer')) p.blindsPaid++;
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

/** 배수진: 이번 핸드 폴드 불가 (면역이면 폴드 가능) */
function noFold(state: GameState, p: PlayerState): boolean {
  return state.effects.lastStand && !state.effects.lastStandImmune.includes(p.id);
}

function canRaise(state: GameState, p: PlayerState): boolean {
  if (state.round.raiseCap === 0) return false; // 서킷브레이커 후 레이즈 1회 제한
  if (state.effects.lastStand) return false; // 배수진: 체크·콜만
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
  state.round = freshRound(state, firstFrom);
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
  const hidden = fogged && state.effects.fogSeers.length ? `${label}: (짙은 안개 — 쇼다운 때 공개)` : `${label}: (실명 다트 — 보드를 볼 수 없음)`;
  logBoard(state, `${label}: ${cardsText(cards)}`, hidden, fogged);
}

/** 이 스트리트까지 공개될 누적 장수 (추가된 보드 카드만큼 뒤로 밀린다, 최대 7장) */
function revealTarget(state: GameState, streetIdx: number): number {
  return Math.min(state.board.length, state.revealPlan[streetIdx] + state.extraCards);
}

/**
 * 보드를 count 장까지 공개한다. 자석이 걸려 있으면 턴·리버에서 지정한 무늬가 아닌 카드가 처음 나올 때 다시 뽑는다.
 * 두 번째 보드(더블 보드·두 번의 운명)도 같은 장수만큼 함께 공개된다.
 */
function revealTo(state: GameState, count: number, label: string, magnetOn: boolean): void {
  const from = state.boardRevealed;
  const mg = state.effects.magnet;
  if (magnetOn && mg && !mg.used) {
    for (let i = from; i < count && !mg.used; i++) {
      if (state.fixedIdx.includes(i) || state.board[i][1] === mg.suit || !state.deck.length) continue;
      const old = state.board[i];
      const fresh = state.deck.shift()!;
      state.board[i] = fresh;
      state.used.push({ card: old, kind: 'shown' });
      mg.used = true;
      logBoard(state, `자석: ${cardToken(old)}은(는) 지정한 무늬가 아니어서 버리고 다시 뽑습니다`, '자석: 지정한 무늬가 아닌 카드를 버리고 다시 뽑습니다', false);
    }
  }
  state.boardRevealed = count;
  const fogged = from < flopCount(state);
  const fresh = state.board.slice(from, count);
  if (state.board2) {
    logBoard(state, `${label}: ${cardsText(fresh)} / 두 번째 보드 ${cardsText(state.board2.slice(from, count))}`, `${label}: (보드를 볼 수 없음)`, fogged);
  } else logBoardStreet(state, label, fresh, fogged);
}

/** 자본주의: 플랍·턴 라운드가 끝날 때 가장 크게 베팅한 사람이 보드 1장 추가 여부를 정한다 */
function capitalPending(state: GameState): boolean {
  const r = state.round;
  if (!state.effects.capitalism || r.capitalDone || !r.maxPut) return false;
  if (state.street !== 'flop' && state.street !== 'turn') return false;
  if (state.board.length >= 7 || !state.deck.length) return false;
  r.capitalDone = true;
  const idx = idxOf(state, r.maxPut.id);
  if (idx < 0 || !live(state.players[idx])) return false;
  state.capitalChooser = r.maxPut.id;
  state.windowStage = state.street;
  state.phase = 'declare';
  state.declareQueue = [idx];
  state.toAct = null;
  state.decisionSeq++;
  return true;
}

/** 보드 카드 1장 추가 (자본주의·플러스 원): 다음 카드보다 먼저 공개한다 */
export function addBoardCard(state: GameState, label: string): void {
  const at = state.boardRevealed;
  const card = state.deck.shift()!;
  state.board.splice(at, 0, card);
  if (state.board2) state.board2.splice(at, 0, state.deck.shift() ?? card);
  // 미리 정해진 뒤쪽 카드들의 위치가 한 칸씩 밀린다
  const shift = (i: number) => (i >= at ? i + 1 : i);
  state.fixedIdx = state.fixedIdx.map(shift);
  state.reservedPublic = state.reservedPublic.map((r) => ({ ...r, index: shift(r.index) }));
  for (const p of state.players) {
    p.foreseen = p.foreseen.map(shift);
    if (p.turnRiver) p.turnRiver.idx = p.turnRiver.idx.map(shift);
  }
  if (at < 5 || state.board.length > 6) state.extraCards++;
  revealTo(state, at + 1, label, false);
}

function closeRound(state: GameState): void {
  if (capitalPending(state)) return;
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
      // 보관함: 바꾸지 않은 보관 카드는 사라진다
      for (const p of state.players) {
        if (!p.lockerReady) continue;
        p.lockerReady = null;
        addLog(state, '보관함: 보관한 카드를 쓰지 않아 사라졌습니다.', { to: [p.id] });
      }
      revealTo(state, revealTarget(state, 0), '플랍', false);
      if (startDiscardPhase(state)) return;
      if (startDeclareWindow(state, 'flop')) return;
      break;
    case 'flop':
      applyTurnRiver(state);
      applyEitherOr(state);
      state.street = 'turn';
      state.used.push({ card: state.burns[1], kind: 'burn' });
      revealTo(state, revealTarget(state, 1), '턴', true);
      if (startDeclareWindow(state, 'turn')) return;
      break;
    case 'turn':
      state.street = 'river';
      state.used.push({ card: state.burns[2], kind: 'burn' });
      revealTo(state, revealTarget(state, 2), '리버', true);
      if (startDeclareWindow(state, 'river')) return;
      break;
    case 'river':
      // 쇼다운 직전 선언 기회 (명추리·기생)
      if (startDeclareWindow(state, 'preShowdown')) return;
      showdown(state);
      return;
  }
  startBettingRound(state, state.dealerIdx);
}

/** 턴과 리버 사이: 미리 본 두 카드의 공개 순서를 바꾸기로 했으면 바꾼다 */
function applyTurnRiver(state: GameState): void {
  for (const p of state.players) {
    const tr = p.turnRiver;
    if (!tr) continue;
    if (tr.swap) {
      const [a, b] = tr.idx;
      [state.board[a], state.board[b]] = [state.board[b], state.board[a]];
    }
    addLog(state, `턴과 리버 사이: ${tr.swap ? '순서를 바꿨습니다' : '순서를 그대로 둡니다'}`, { to: [p.id] });
    p.turnRiver = { ...tr, swap: tr.swap ?? false };
  }
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
  state.lastFolderId = p.id;
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
  if (a.type === 'fold' && noFold(state, p)) return '배수진: 이번 핸드는 폴드할 수 없습니다.';
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
      if (state.round.raiseCap === 0) return '서킷브레이커: 이번 라운드는 레이즈를 1번만 허용합니다 (콜 또는 폴드).';
      if (state.effects.lastStand) return '배수진: 이번 핸드는 체크·콜만 할 수 있습니다.';
      if (!canRaise(state, p)) return '완전한 레이즈가 없었으므로 다시 레이즈할 수 없습니다 (콜 또는 폴드).';
      const minTo = state.currentBet + state.minRaise;
      if (target < minTo && target !== maxTo) return `최소 ${minTo}까지 레이즈해야 합니다.`;
      const opening = state.currentBet === 0;
      const raiseSize = target - state.currentBet;
      putChips(p, target - level);
      if (raiseSize >= state.minRaise) state.minRaise = raiseSize;
      state.currentBet = target;
      state.betSetter = { idx, raise: !opening };
      if (!state.round.maxPut || target > state.round.maxPut.amount) state.round.maxPut = { id: p.id, amount: target };
      if (!opening) {
        state.round.raises++;
        if (state.round.raiseCap !== null) state.round.raiseCap = Math.max(0, state.round.raiseCap - 1);
      }
      state.round.actions++;
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
  state.round.actions++;
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
  const err = lockError(state) ?? ACTIVE.freeRide!.check(ctxFor(state, p, aug), {}, false) ?? taxError(state, p);
  if (err) return err;
  declare(state, p, aug, {});
  return null;
}

// ───────────────────────── 세 번째 손 ─────────────────────────

function startDiscardPhase(state: GameState): boolean {
  const holders = state.players.filter((p) => live(p) && p.hole.length === 3);
  if (!holders.length) return false;
  // 암전 중(유리 테이블·면역이 아니면)에는 자기 카드를 못 보므로 무작위로 버린다
  for (const p of holders) if (ownCardsHidden(state, p)) p.pendingDiscard = state.rng.int(3);
  if (holders.every((p) => p.pendingDiscard !== null)) {
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
    if (ownCardsHidden(state, p)) note(state, p, 'discard', '세 번째 손: 암전 중이라 무작위 1장을 버렸습니다.');
    else note(state, p, 'discard', `세 번째 손: ${cardToken(card)}을(를) 버렸습니다. 남은 홀카드 ${cardsText(p.hole)}`, [card]);
    const th = findAug(p, 'thirdHand');
    if (th) {
      countUse(state, 'thirdHand');
      announceNamed(state, p, th, '발동', '— 카드 1장을 버림');
    }
  }
  // 플랍 직후 선언 기회 (양자택일 등)
  if (startDeclareWindow(state, 'flop')) return;
  startBettingRound(state, state.dealerIdx);
}

/** 양자택일: 턴이 공개되기 직전에 고른 후보를 턴 카드로 (고르지 않았으면 원래 카드) */
function applyEitherOr(state: GameState): void {
  for (const p of state.players) {
    const eo = p.eitherOr;
    if (!eo) continue;
    p.eitherOr = null;
    const pick = eo.pick ?? 0;
    state.board[state.boardRevealed] = eo.cards[pick];
    state.used.push({ card: eo.cards[1 - pick], kind: 'discard' });
    addLog(state, `양자택일: 턴 후보 중 ${eo.pick === null ? '처음 카드(선택하지 않음)' : `${pick + 1}번째 카드`}로 정했습니다.`, { to: [p.id] });
  }
}

// ───────────────────────── 선언 기회 (턴·리버 공개 직후) ─────────────────────────

function startDeclareWindow(state: GameState, stage: 'flop' | 'turn' | 'river' | 'preShowdown'): boolean {
  state.windowStage = stage;
  state.phase = 'declare';
  const ops = opsFor(state);
  const queue = seatOrderFromDealer(state).filter((i) => {
    const p = state.players[i];
    return live(p) && windowOptions(state, ops, p).length > 0;
  });
  if (!queue.length) {
    state.phase = 'betting';
    state.windowStage = null;
    return false;
  }
  state.declareQueue = queue;
  state.decisionSeq++;
  return true;
}

/** 선언 기회에 지목형 증강(공동 환승·명추리 등)으로 고를 수 있는 대상 */
export function declareTargets(state: GameState, p: PlayerState, id: AugmentId): string[] {
  return declareOptions(state, p).includes(id) ? windowTargets(state, opsFor(state), p, id) : [];
}

export function declareOptions(state: GameState, p: PlayerState): AugmentId[] {
  if (state.phase !== 'declare' || state.players[state.declareQueue[0]] !== p) return [];
  if (state.capitalChooser) return state.capitalChooser === p.id ? ['capitalism'] : [];
  return windowOptions(state, opsFor(state), p);
}

/** 선언 기회 (봉인: boardIndex, 마지막 갈림길·연금술: cardIndex, 기생·명추리·공동 환승: targetId 등) */
function applyDeclare(state: GameState, idx: number, a: Extract<GameAction, { type: 'declare' }>): string | null {
  if (state.phase !== 'declare' || state.declareQueue[0] !== idx) return '지금은 선언할 차례가 아닙니다.';
  const p = state.players[idx];
  const augment = a.augment ?? null;
  // 자본주의: 보드 카드를 1장 더 깔지 (증강 사용이 아니므로 반응 대기 없음)
  if (state.capitalChooser) {
    if (state.capitalChooser !== p.id) return '지금은 선언할 차례가 아닙니다.';
    state.capitalChooser = null;
    state.declareQueue = [];
    if (augment === 'capitalism') {
      addLog(state, `자본주의: ${p.name}이(가) 보드 카드를 1장 더 깝니다`);
      addBoardCard(state, '추가 보드');
    } else addLog(state, `자본주의: ${p.name}이(가) 보드를 늘리지 않습니다`);
    closeRound(state);
    return null;
  }
  if (augment === null) {
    state.declareQueue.shift();
    advanceDeclare(state);
    return null;
  }
  if (!isAugmentId(augment) || !declareOptions(state, p).includes(augment)) return '지금 선언할 수 없는 증강입니다.';
  const aug = findAug(p, augment)!;
  const params: ActiveParams = {};
  if (typeof a.boardIndex === 'number') params.boardIndex = a.boardIndex;
  if (typeof a.cardIndex === 'number') params.cardIndex = a.cardIndex;
  if (typeof a.targetId === 'string') params.targetId = a.targetId;
  if (typeof a.choice === 'number') params.choice = a.choice;
  if (typeof a.card === 'string') params.card = a.card;
  // 예전 형식: 마지막 갈림길은 boardIndex 칸으로 홀카드 번호를 받았다
  if (augment === 'lastFork' && params.cardIndex === undefined) params.cardIndex = a.boardIndex;
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
  const stage = state.windowStage;
  state.windowStage = null;
  if (stage === 'preShowdown') return showdown(state);
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
  const secret = def.disclosure === 'secret';
  // 죽음과 세금: 액티브·공개형 증강을 쓸 때마다 (공포탄 포함) 은행에 납부
  const taxPaid = payTax(state, p, secret);
  const anonymous = def.disclosure === 'anonymous' || secret;
  const detail = effect.detail?.(ctx, params) ?? '';
  let publicName: string | null = null;
  if (secret) {
    addLog(state, `${augLabel(aug.id)} 사용${detail ? ` ${detail}` : ''} (아무도 누가 썼는지 모름)`, { to: [p.id] });
  } else if (anonymous) {
    announceAnonymous(state, p);
    addLog(state, `${p.name} ▸ ${augLabel(aug.id)} 사용${detail ? ` ${detail}` : ''} (상대에게는 "비공개 증강")`, { to: [p.id] });
  } else {
    publicName = AUGMENTS[revealAugment(state, p, aug)].name;
    announceNamed(state, p, aug, '선언', detail);
  }
  // 세무서: 공개형 증강을 선언할 때마다 보유자에게 1BB
  if (def.public) payTaxOffice(state, p);
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
    immune: [],
    secret,
  };
  if (!state.reaction) {
    state.reaction = { queue: [decl], resume: state.phase };
    state.phase = 'reaction';
    state.decisionSeq++;
  } else {
    state.reaction.queue.push(decl);
  }
}

function payTaxOffice(state: GameState, payer: PlayerState): void {
  const { bb } = currentBlinds(state);
  for (const i of seatOrderFromDealer(state)) {
    const h = state.players[i];
    const office = findAug(h, 'taxOffice');
    if (!office || h === payer || !active(h)) continue;
    const pay = Math.min(bb, payer.chips);
    if (pay <= 0) break;
    payer.chips -= pay;
    h.chips += pay;
    if (payer.chips === 0 && live(payer)) {
      payer.allIn = true;
      payer.wentAllIn = true;
    }
    countUse(state, 'taxOffice');
    announceNamed(state, h, office, '발동', `— ${payer.name}이(가) 공개형 증강을 선언해 ${pay}칩을 받음`);
  }
}

/** 선언자 이름 (소문처럼 선언자를 숨기는 증강은 '누군가') */
function declarerLabel(state: GameState, d: Declaration): string {
  return d.secret ? '누군가' : (playerById(state, d.ownerId)?.name ?? '?');
}

function declLabel(d: Declaration): string {
  return d.anonymous ? '비공개 증강' : `「${d.publicName}」`;
}

/** 카운터 스펠: 반응 대기 중인 다른 사람의 선언을 무효화 (대기 시간은 그대로 3초) */
function applyCounter(state: GameState, p: PlayerState): string | null {
  if (state.phase !== 'reaction' || !state.reaction) return '지금은 무효화할 증강이 없습니다.';
  const cs = findAug(p, 'counterSpell');
  if (!cs || (cs.usesLeft ?? 0) <= 0) return '카운터 스펠이 없습니다.';
  const head = state.reaction.queue[0];
  if (head.ownerId === p.id) return '자기 증강은 무효화할 수 없습니다.';
  if (head.countered) return '이미 무효화되었습니다.';
  const lock = lockError(state);
  if (lock) return lock;
  const tax = taxError(state, p);
  if (tax) return tax;
  payTax(state, p);
  cs.usesLeft = 0;
  countUse(state, 'counterSpell');
  head.countered = true;
  head.counteredBy = p.id;
  announceNamed(state, p, cs, '발동', `— ${declarerLabel(state, head)}의 ${declLabel(head)}을(를) 무효화`);
  return null;
}

/** 면역: 반응 대기 중인 공개형 효과에서 나만 빠진다 (판 전체 규칙을 바꾸는 공개형은 불가) */
function immunityError(state: GameState, p: PlayerState): string | null {
  if (state.phase !== 'reaction' || !state.reaction) return '공개형 증강의 반응 대기 중에만 쓸 수 있습니다.';
  const im = findAug(p, 'immunity');
  if (!im || (im.usesLeft ?? 0) <= 0) return '면역이 없습니다.';
  if (!active(p)) return '게임에 참여하고 있지 않습니다.';
  const head = state.reaction.queue[0];
  const def = AUGMENTS[head.augment];
  if (!def.public) return '공개형 증강에만 쓸 수 있습니다.';
  if (def.tableWide) return `「${def.name}」처럼 판 전체 규칙을 바꾸는 공개형에는 쓸 수 없습니다.`;
  if (head.ownerId === p.id) return '자기 증강에는 쓸 수 없습니다.';
  if (head.immune.includes(p.id)) return '이미 빠졌습니다.';
  return lockError(state) ?? taxError(state, p);
}

function applyImmunity(state: GameState, p: PlayerState): string | null {
  const err = immunityError(state, p);
  if (err) return err;
  const im = findAug(p, 'immunity')!;
  const head = state.reaction!.queue[0];
  payTax(state, p);
  im.usesLeft = 0;
  countUse(state, 'immunity');
  head.immune.push(p.id);
  announceNamed(state, p, im, '발동', `— ${declarerLabel(state, head)}의 ${declLabel(head)} 효과에서 빠짐`);
  return null;
}

/** 반응 대기가 끝나지 않은 선언을 모두 취소한다 (핸드가 끝나거나 다시 시작될 때). 횟수와 세금은 돌려준다 */
function dropPendingDeclarations(state: GameState): void {
  const r = state.reaction;
  if (!r) return;
  for (const d of r.queue.splice(0)) {
    const owner = playerById(state, d.ownerId);
    const aug = owner ? findAug(owner, d.augment) : undefined;
    if (!owner || !aug) continue;
    const def = AUGMENTS[d.augment];
    if (def.uses?.per === 'game') aug.usesLeft = (aug.usesLeft ?? 0) + 1;
    if (def.uses?.per === 'hand') aug.usedThisHand = false;
    if (d.taxPaid) {
      owner.chips += d.taxPaid;
      state.stats.bankTaxed -= d.taxPaid;
    }
    addLog(state, `${augLabel(d.augment)} 선언이 취소되었습니다 (횟수·세금 반환)`, { to: [owner.id] });
  }
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
      addLog(state, `${declarerLabel(state, decl)}의 ${declLabel(decl)}이(가) 무효화되었습니다 (사용 횟수 소모)`);
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
  if (r.queue.length && state.phase !== 'gameOver' && state.phase !== 'handEnd') {
    r.resume = state.phase;
    state.phase = 'reaction';
    state.decisionSeq++;
    return;
  }
  if (r.queue.length) dropPendingDeclarations(state);
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
  if (state.phase !== 'reaction' || !head || head.countered || lockError(state)) return [];
  return state.players
    .filter((p) => active(p) && p.id !== head.ownerId && (findAug(p, 'counterSpell')?.usesLeft ?? 0) > 0)
    .map((p) => p.id);
}

/** 반응 대기 중 면역을 쓸 수 있는 사람 */
export function immunityCandidates(state: GameState): string[] {
  return state.players.filter((p) => findAug(p, 'immunity') && !immunityError(state, p)).map((p) => p.id);
}

// ───────────────────────── 제안·응답 ─────────────────────────

/** 제안·입찰 시작: 진행 중인 단계를 멈추고 응답을 모은다 (서버는 15초 제한, 턴 타이머는 일시정지) */
function startRespond(state: GameState, spec: Pick<RespondState, 'kind' | 'augment' | 'ownerId' | 'participants' | 'params'>): void {
  if (state.respond) return;
  state.respond = { ...spec, answers: {}, stage: 'offer', resume: state.phase, seq: ++state.respondSeq };
  state.phase = 'respond';
  state.decisionSeq++;
}

/** 아직 응답하지 않은 사람 (추방된 사람은 기다리지 않는다) */
function respondPending(state: GameState): PlayerState[] {
  const r = state.respond;
  if (state.phase !== 'respond' || !r) return [];
  return r.participants.map((id) => playerById(state, id)).filter((p): p is PlayerState => !!p && !p.kicked && !r.answers[p.id]);
}

function respondCtx(state: GameState, r: RespondState): Ctx {
  const owner = playerById(state, r.ownerId)!;
  // 증강이 옮겨 갔어도(증강 셔플 등) 진행 중인 제안은 끝까지 처리한다
  const aug = findAug(owner, r.augment) ?? { id: r.augment, usesLeft: 0, usedThisHand: true, revealed: true, publicId: r.augment, acquiredHand: state.handNumber };
  return ctxFor(state, owner, aug);
}

function applyRespond(state: GameState, p: PlayerState, a: Extract<GameAction, { type: 'respond' }>): string | null {
  const r = state.respond;
  if (state.phase !== 'respond' || !r) return '지금은 응답할 제안이 없습니다.';
  if (!r.participants.includes(p.id)) return '응답할 대상이 아닙니다.';
  if (r.answers[p.id]) return '이미 응답했습니다.';
  const ans: RespondAnswer = {};
  if (typeof a.accept === 'boolean') ans.accept = a.accept;
  if (typeof a.bid === 'number') ans.bid = a.bid;
  if (typeof a.choice === 'number') ans.choice = a.choice;
  if (typeof a.cardIndex === 'number') ans.cardIndex = a.cardIndex;
  const err = ACTIVE[r.augment]!.respond!.error(respondCtx(state, r), r, p, ans);
  if (err) return err;
  r.answers[p.id] = ans;
  if (!respondPending(state).length) finishRespond(state);
  return null;
}

/** 응답을 마감한다 (모두 응답했거나 시간 초과). 응답하지 않은 사람은 기본 응답 */
function finishRespond(state: GameState): void {
  const r = state.respond;
  if (state.phase !== 'respond' || !r) return;
  const hooks = ACTIVE[r.augment]!.respond!;
  const ctx = respondCtx(state, r);
  for (const id of r.participants) {
    const p = playerById(state, id);
    if (p && !r.answers[id]) r.answers[id] = hooks.fallback(ctx, r, p);
  }
  state.respond = null;
  state.phase = r.resume;
  if (hooks.done(ctx, r)) {
    // 다음 단계 응답 (공동 환승의 카드 고르기)
    r.seq = ++state.respondSeq;
    state.respond = r;
    state.phase = 'respond';
    state.decisionSeq++;
    return;
  }
  continueAfterReaction(state);
}

/** 기본 응답 (시간 초과·자리 비움) */
function respondDefault(state: GameState, p: PlayerState): RespondAnswer {
  const r = state.respond!;
  return ACTIVE[r.augment]!.respond!.fallback(respondCtx(state, r), r, p);
}

// ───────────────────────── 서킷브레이커 · 하이카드 · 나 다시 돌아갈래 ─────────────────────────

/** 서킷브레이커: 이번 라운드에 낸 칩을 모두 돌려주고 라운드 첫 행동자부터 다시 (레이즈 1회 제한) */
function restartRound(state: GameState): void {
  const r = state.round;
  for (const p of state.players) {
    if (!p.inHand) continue;
    const refund = Math.max(0, p.streetBet - (r.startBets[p.id] ?? 0));
    if (refund > 0) {
      p.streetBet -= refund;
      p.contributed -= refund;
      p.chips += refund;
      if (p.chips > 0) {
        p.allIn = false;
        p.wentAllIn = false;
      }
    }
    p.streetShort = 0;
    p.acted = false;
    p.actedLevel = 0;
    p.forcedCall = false;
  }
  state.currentBet = r.startCurrentBet;
  state.minRaise = r.startMinRaise || currentBlinds(state).bb;
  state.betSetter = r.startSetter ? { ...r.startSetter } : null;
  state.lastAggression = null;
  r.raises = 0;
  r.actions = 0;
  r.raiseCap = 1;
  addLog(state, '서킷브레이커: 이번 라운드에 낸 칩을 모두 돌려주고 첫 행동자부터 다시 시작합니다 (레이즈 1회 제한)');
  const next = nextIdx(state, r.firstFrom, (p) => needsToAct(state, p));
  state.toAct = next >= 0 ? next : null;
  state.decisionSeq++;
}

/** 하이카드: 이번 핸드를 무효화하고 남은 사람 중 홀카드 1장이 가장 높은 사람이 팟을 가져간다 (와일드 미적용) */
function highCardDuel(state: GameState): void {
  dropPendingDeclarations(state);
  const order = seatOrderFromDealer(state);
  const top = (p: PlayerState) => Math.max(...p.hole.map(rankOf));
  const entries: ShowdownEntry[] = [];
  for (const i of order) {
    const p = state.players[i];
    if (!live(p)) continue;
    p.shown = true;
    const r = top(p);
    const best = p.hole.find((c) => rankOf(c) === r)!;
    entries.push({ id: p.id, cards: [...p.hole], handName: `최고 카드 ${rankName(r)}`, bestCards: [best], score: [r], applied: [], tiebreak: [] });
  }
  addLog(state, `하이카드 승부: ${entries.map((e) => `${playerById(state, e.id)!.name} ${cardsText(e.cards)}`).join(', ')}`);
  // 핸드를 무효화하고 팟 전체를 가장 높은 카드를 가진 사람이 가져간다 (동점은 분배)
  const total = state.players.reduce((sum, p) => sum + p.contributed, 0) + state.deadMoney;
  const best = Math.max(...entries.map((e) => e.score[0]));
  const winners = entries.filter((e) => e.score[0] === best).map((e) => e.id);
  const won: Record<string, number> = {};
  for (const [id, amt] of splitPot(total, winners)) {
    won[id] = (won[id] ?? 0) + amt;
    playerById(state, id)!.chips += amt;
  }
  addLog(state, `${winners.map((id) => playerById(state, id)!.name).join(', ')} 팟 ${total}칩 획득 (하이카드${winners.length > 1 ? ', 분할' : ''})`);
  const potResults = [{ amount: total, eligible: entries.map((e) => e.id), winners }];
  finishHand(state, {
    hand: state.handNumber,
    showdown: true,
    board: state.board.slice(0, state.boardRevealed),
    sealed: [],
    entries,
    pots: potResults,
    won,
    table: ['하이카드 승부 (핸드 무효)', ...tableEffectNotes(state)],
    extras: [],
  });
}

/**
 * 나 다시 돌아갈래: 블라인드를 뺀 베팅을 모두 돌려주고, 같은 버튼·블라인드로 새 덱을 섞어 프리플랍부터 다시.
 * 선언자는 돌려받을 칩의 50%를 은행에 낸다. 이전 카드에 대한 정보는 모두 지운다.
 */
function restartHand(state: GameState, declarer: PlayerState): void {
  dropPendingDeclarations(state);
  let declarerRefund = 0;
  for (const p of state.players) {
    if (!p.inHand) continue;
    const refund = Math.max(0, p.contributed - p.blindPosted);
    p.chips += refund;
    p.contributed -= refund;
    if (p === declarer) declarerRefund = refund;
  }
  const fee = Math.floor(declarerRefund * 0.5);
  declarer.chips -= fee;
  state.stats.bankPaid += fee;
  // 이전 카드에 대한 정보 삭제: 이번 핸드의 카드가 담긴 로그와 메모
  const hand = state.handNumber;
  state.log = state.log.filter((e) => !(e.hand === hand && /\[[2-9TJQKA][shdc]\]/.test(e.text)));
  for (const p of state.players) {
    p.notes = p.notes.filter((n) => n.hand !== hand);
    const kicked = p.kicked;
    p.hole = [];
    p.folded = kicked;
    p.allIn = p.inHand && p.chips === 0;
    p.wentAllIn = p.allIn;
    p.streetBet = p.inHand ? p.blindPosted : 0;
    p.streetShort = 0;
    p.acted = false;
    p.actedLevel = 0;
    p.actedPreflop = false;
    p.lastAction = null;
    p.shown = false;
    p.foreseen = [];
    p.discarded = [];
    p.pendingDiscard = null;
    p.forcedCall = false;
    p.shepherdShown = [];
    p.shepherdLied = false;
    p.blackjackOn = false;
    p.eitherOr = null;
    p.lockerPending = false;
  }
  const bomb = state.effects.bomb;
  const underdog = state.effects.underdog;
  state.effects = { ...freshEffects(), bomb, underdog, restarted: true };
  state.board = [];
  state.burns = [];
  state.boardRevealed = 0;
  state.used = [];
  state.street = 'preflop';
  state.lastAggression = null;
  state.declareQueue = [];
  state.toAct = null;
  const inHand = new Set(state.players.filter((p) => p.inHand && !p.kicked).map((p) => p.id));
  // 보관함에서 꺼내 쓸 카드는 새 덱에서도 빼 둔다
  for (const p of state.players) {
    if (p.lockerReady) p.lockerStored = p.lockerReady;
  }
  dealCards(state);
  for (const p of state.players) if (!inHand.has(p.id)) p.inHand = p.inHand && p.kicked;
  addLog(state, `나 다시 돌아갈래: ${declarer.name}이(가) 블라인드를 뺀 베팅을 모두 돌려받고 ${fee}칩을 은행에 냈습니다. 새 덱으로 프리플랍부터 다시 시작합니다`);
  logHandStart(state);
  if (bomb) {
    state.currentBet = 0;
    state.betSetter = null;
    state.minRaise = currentBlinds(state).bb;
    closeRound(state);
    return;
  }
  postBlindsAndStart(state);
}

// ───────────────────────── 쇼다운 ─────────────────────────

export function tableEffectNotes(state: GameState): string[] {
  const e = state.effects;
  const out: string[] = [];
  const flips = e.flips + (e.underdog ? 1 : 0);
  if (flips % 2 === 1) out.push(e.underdog && e.flips === 0 ? '언더독: 족보 역전 (가장 낮은 패가 승리)' : '족보 역전 (가장 낮은 패가 승리)');
  else if (flips > 0) out.push('족보 역전 상쇄 (원래 순위)');
  if (e.sealed.length) out.push(`봉인: ${cardsText(e.sealed.map((i) => state.board[i]))}`);
  if (e.fogSeers.length) out.push('짙은 안개');
  if (e.glass) out.push('유리 테이블');
  if (e.blackout) out.push('암전');
  if (e.rewinds) out.push(`되감기 ${e.rewinds}회`);
  if (e.bomb) out.push('폭탄 팟');
  if (e.blindDarted.length) out.push(`실명 다트: ${e.blindDarted.map((id) => playerById(state, id)?.name ?? '?').join(', ')}`);
  if (e.restarted) out.push('다시 시작한 핸드');
  return out;
}

/** 내기할래?: 우승 족보 종류 (포카드 이상은 7) */
export function betCategory(score: readonly number[]): number {
  return Math.min(Category.Quads, score[0]);
}

export const BET_CATEGORY_NAMES = [...CATEGORY_NAMES.slice(0, 7), '포카드 이상'];

/** 쇼다운 판정 단위: 보드별(더블 보드·두 번의 운명) × 하이·로우 */
interface JudgeUnit {
  label: string;
  boardIdx: number;
  inverted: boolean;
}

function judgeUnits(state: GameState): { boards: { label: string; cards: Card[] }[]; units: JudgeUnit[] } {
  const inverted = invertedNow(state);
  const boards = [{ label: '', cards: evalBoard(state) }];
  if (state.board2) {
    const two = state.effects.twoFates;
    boards[0].label = two ? '첫 리버' : '첫 보드';
    boards.push({ label: two ? '두 번째 리버' : '두 번째 보드', cards: state.board2.slice(0, state.boardRevealed) });
  }
  const modes = state.effects.highLow
    ? [
        { label: '하이', inverted },
        { label: '로우', inverted: !inverted },
      ]
    : [{ label: '', inverted }];
  const units: JudgeUnit[] = [];
  boards.forEach((b, boardIdx) => {
    for (const m of modes) units.push({ label: [b.label, m.label].filter(Boolean).join(' · '), boardIdx, inverted: m.inverted });
  });
  return { boards, units };
}

/** 명추리 성공: 쇼다운 없이 참여할 수 있는 팟을 모두 가져간다 (모든 팟이면 카드 공개 없이 끝) */
function nameItWin(state: GameState, w: PlayerState, pots: { amount: number; eligible: string[] }[]): void {
  const total = pots.reduce((s, p) => s + p.amount, 0);
  w.chips += total;
  addLog(state, `${w.name} 팟 ${total}칩 획득 (명추리, 쇼다운 없음)`);
  finishHand(state, {
    hand: state.handNumber,
    showdown: false,
    board: state.board.slice(0, state.boardRevealed),
    sealed: [...state.effects.sealed],
    entries: [],
    pots: pots.map((p) => ({ amount: p.amount, eligible: p.eligible, winners: [w.id] })),
    won: { [w.id]: total },
    table: tableEffectNotes(state),
    extras: [`${w.name}: 명추리 성공`],
  });
}

function showdown(state: GameState): void {
  const potsOf = () =>
    computePots(
      state.players.filter((p) => p.inHand).map((p) => ({ id: p.id, contributed: p.contributed, folded: p.folded })),
      state.deadMoney,
    );
  const nw = playerById(state, state.nameItWinner);
  const nameIt = nw && live(nw) ? nw : null;
  if (nameIt && potsOf().every((pot) => pot.eligible.includes(nameIt.id))) return nameItWin(state, nameIt, potsOf());
  state.effects.fogLifted = true;
  const order = seatOrderFromDealer(state);
  const seatRank = (id: string) => order.findIndex((i) => state.players[i].id === id);
  const { boards, units } = judgeUnits(state);
  const board = boards[0].cards;
  const entries: ShowdownEntry[] = [];
  // 보드별 각 플레이어의 족보
  const contenders = boards.map(() => new Map<string, Contender>());
  for (const i of order) {
    const p = state.players[i];
    if (!live(p)) continue;
    p.shown = true;
    const ev = handEvalFor(state, p, board);
    const entry: ShowdownEntry = { id: p.id, cards: [...p.hole], handName: ev.value.name, bestCards: ev.value.cards, score: ev.value.score, applied: ev.applied, tiebreak: [] };
    contenders[0].set(p.id, contenderFor(state, p, ev));
    boards.slice(1).forEach((b, k) => {
      const ev2 = handEvalFor(state, p, b.cards);
      contenders[k + 1].set(p.id, contenderFor(state, p, ev2));
      (entry.alt ??= []).push({ label: b.label, handName: ev2.value.name });
    });
    entries.push(entry);
  }
  const table = tableEffectNotes(state);
  addLog(state, `쇼다운${table.length ? ` — ${table.join(', ')}` : ''}`);
  if (state.effects.fogSeers.length || state.effects.blindDarted.length || state.effects.glasses.length) addLog(state, `보드 공개: ${cardsText(state.board.slice(0, state.boardRevealed))}`);
  if (state.board2) addLog(state, `두 번째 보드: ${cardsText(state.board2.slice(0, state.boardRevealed))}`);
  for (const e of entries) {
    const p = playerById(state, e.id)!;
    const variants = e.applied.map((v) => VARIANT_LABEL[v]);
    addLog(state, `${p.name}: ${cardsText(e.cards)} — ${e.handName}${variants.length ? ` (${variants.join(', ')})` : ''}${e.alt?.length ? ` / ${e.alt.map((a) => `${a.label} ${a.handName}`).join(', ')}` : ''}`);
    for (const v of e.applied) {
      const aug = findAug(p, VARIANT_AUG[v]);
      if (aug) {
        countUse(state, aug.id);
        announceNamed(state, p, aug, '발동', '— 족보에 적용');
      }
    }
  }
  const pots = potsOf();
  // 팟마다 판정 단위별 승자 (명추리 성공자가 참여한 팟은 그 사람이 모두 가져간다)
  const decisions = pots.map((pot) =>
    nameIt && pot.eligible.includes(nameIt.id)
      ? units.map((): PotDecision => ({ winners: [nameIt.id], decidedBy: {} }))
      : units.map((u) => decidePot(pot.eligible.map((id) => contenders[u.boardIdx].get(id)!).filter(Boolean), { inverted: u.inverted, board: boards[u.boardIdx].cards })),
  );
  const extras: string[] = [];
  // 내기할래?: 쇼다운까지 가서 졌는데 우승 족보 예측이 맞으면 낸 칩의 50%를 팟에서 환급
  const mainWinner = entries.find((e) => decisions[0]?.[0]?.winners.includes(e.id));
  if (mainWinner) {
    const cat = betCategory(mainWinner.score);
    for (const e of entries) {
      const p = playerById(state, e.id)!;
      if (p.betPrediction === null || decisions.some((d) => d.some((u) => u.winners.includes(p.id)))) continue;
      if (p.betPrediction !== cat) continue;
      let refund = Math.floor(p.contributed * 0.5);
      let got = 0;
      for (const pot of pots) {
        if (refund <= 0) break;
        const take = Math.min(refund, pot.amount);
        pot.amount -= take;
        refund -= take;
        got += take;
      }
      p.chips += got;
      countUse(state, 'bet');
      const text = `${p.name}: 내기할래? 적중 (${BET_CATEGORY_NAMES[cat]}) — 낸 칩의 50%인 ${got}칩 환급`;
      extras.push(text);
      addLog(state, text);
    }
  }
  const won: Record<string, number> = {};
  const give = (id: string, amt: number) => {
    if (amt <= 0) return;
    won[id] = (won[id] ?? 0) + amt;
    playerById(state, id)!.chips += amt;
  };
  const potResults: PotResult[] = pots.map((pot, k) => {
    const label = pots.length > 1 ? (k === 0 ? '메인팟' : `사이드팟 ${k}`) : '팟';
    const unitDecisions = decisions[k];
    // 동점 처리 증강 표시
    unitDecisions.forEach((decision) => {
      for (const [id, tags] of Object.entries(decision.decidedBy)) {
        const entry = entries.find((x) => x.id === id)!;
        const p = playerById(state, id)!;
        for (const t of tags) {
          if (entry.tiebreak.includes(t)) continue;
          entry.tiebreak.push(t);
          const aug = findAug(p, t);
          if (aug) {
            countUse(state, t);
            announceNamed(state, p, aug, '발동', t === 'pureBlood' ? '— 순혈 적용' : '— 동점 상황에서 승리');
          }
        }
      }
    });
    // 판정 단위로 나누고, 나누어떨어지지 않는 칩은 딜러 왼쪽에 가장 가까운 승자에게
    const n = unitDecisions.length;
    const base = Math.floor(pot.amount / n);
    const unitResults: PotUnit[] = unitDecisions.map((decision, u) => {
      const ordered = order.map((i) => state.players[i].id).filter((id) => decision.winners.includes(id));
      const shares = teamShares(state, pot, ordered, base);
      for (const [id, amt] of shares) give(id, amt);
      return { label: units[u].label || label, amount: base, winners: [...shares.keys()].filter((id) => (shares.get(id) ?? 0) > 0) };
    });
    const rem = pot.amount - base * n;
    const allWinners = [...new Set(unitResults.flatMap((u) => u.winners))].sort((a, b) => seatRank(a) - seatRank(b));
    if (rem > 0 && allWinners.length) {
      give(allWinners[0], rem);
      const first = unitResults.find((u) => u.winners.includes(allWinners[0]))!;
      first.amount += rem;
    }
    for (const u of unitResults) {
      addLog(state, `${u.winners.map((id) => playerById(state, id)!.name).join(', ')} ${n > 1 ? `${label} ${u.label}` : label} ${u.amount}칩 획득${u.winners.length > 1 ? ' (분할)' : ''}`);
    }
    return { amount: pot.amount, eligible: pot.eligible, winners: allWinners, ...(n > 1 ? { units: unitResults } : {}) };
  });
  // 무승부로 하지 않을래?: 나를 이긴 승자의 족보 종류가 내 족보 종류와 같으면 결과 직후 나에게만 선택 창
  if (units.length === 1) offerDraws(state, entries, potResults);
  finishHand(state, {
    hand: state.handNumber,
    showdown: true,
    board: state.board.slice(0, state.boardRevealed),
    sealed: [...state.effects.sealed],
    ...(state.board2 ? { board2: state.board2.slice(0, state.boardRevealed) } : {}),
    entries,
    pots: potResults,
    won,
    table,
    extras,
  });
}

/** 판정 단위 하나의 칩을 승자에게 나눈다 (운명 공동체면 팀원과 반씩 — 5단계에서 확장) */
function teamShares(_state: GameState, _pot: { eligible: string[] }, winnersInOrder: string[], amount: number): Map<string, number> {
  return winnersInOrder.length ? splitPot(amount, winnersInOrder) : new Map();
}

const TIEBREAK_AUGS: AugmentId[] = ['kickerMaster', 'absoluteKicker', 'pureBlood', 'drawOffer'];

function offerDraws(state: GameState, entries: ShowdownEntry[], pots: PotResult[]): void {
  for (const e of entries) {
    const me = playerById(state, e.id)!;
    const da = findAug(me, 'drawOffer');
    if (!da || (da.usesLeft ?? 0) <= 0 || !active(me)) continue;
    const myCat = betCategory(e.score);
    for (const [k, pot] of pots.entries()) {
      if (!pot.eligible.includes(me.id) || pot.winners.includes(me.id)) continue;
      const w = pot.winners.find((id) => {
        const we = entries.find((x) => x.id === id);
        const wp = playerById(state, id)!;
        return we && betCategory(we.score) === myCat && !TIEBREAK_AUGS.some((t) => findAug(wp, t));
      });
      if (!w) continue;
      if (me.drawPrompt && me.drawPrompt.winnerId !== w) continue;
      me.drawPrompt = { winnerId: w, pots: [...(me.drawPrompt?.pots ?? []), k] };
    }
    if (me.drawPrompt) addLog(state, `무승부로 하지 않을래?: ${playerById(state, me.drawPrompt.winnerId)!.name}에게 무승부를 제안할 수 있습니다`, { to: [me.id] });
  }
}

/** 무승부로 하지 않을래? 응답: 그 승자와 나 둘이서 그 팟(승자 몫)을 반씩 */
function applyDraw(state: GameState, p: PlayerState, accept: boolean): string | null {
  const dp = p.drawPrompt;
  if (state.phase !== 'handEnd' || !dp) return '지금은 무승부를 제안할 수 없습니다.';
  p.drawPrompt = null;
  if (!accept) return null;
  const da = findAug(p, 'drawOffer');
  const w = playerById(state, dp.winnerId);
  const r = state.result;
  if (!da || (da.usesLeft ?? 0) <= 0 || !w || !r) return null;
  da.usesLeft = (da.usesLeft ?? 0) - 1;
  countUse(state, 'drawOffer');
  const order = seatOrderFromDealer(state).map((i) => state.players[i].id);
  let moved = 0;
  for (const k of dp.pots) {
    const pot = r.pots[k];
    const share = Math.floor(pot.amount / pot.winners.length) + (pot.winners[0] === w.id ? pot.amount % pot.winners.length : 0);
    // 반으로 나누고 남는 1칩은 딜러 왼쪽에 가까운 쪽에게
    const half = Math.floor(share / 2);
    const odd = share - half * 2;
    const toMe = half + (odd && order.indexOf(p.id) < order.indexOf(w.id) ? 1 : 0);
    const amt = Math.min(toMe, w.chips);
    w.chips -= amt;
    p.chips += amt;
    moved += amt;
  }
  r.won[p.id] = (r.won[p.id] ?? 0) + moved;
  r.won[w.id] = (r.won[w.id] ?? 0) - moved;
  const text = `${p.name}: 무승부로 하지 않을래? — ${w.name}와(과) 팟을 반씩 나눠 ${moved}칩을 받음`;
  r.extras.push(text);
  announceNamed(state, p, da, '발동', `— ${w.name}와(과) 무승부`);
  addLog(state, text);
  return null;
}

function endHandUncontested(state: GameState, winner: PlayerState): void {
  dropPendingDeclarations(state);
  state.reaction = null;
  returnUncalled(state);
  const total = state.players.reduce((s, p) => s + p.contributed, 0) + state.deadMoney;
  winner.chips += total;
  addLog(state, `${winner.name} 팟 ${total}칩 획득 (나머지 모두 폴드)`);
  // 쇼맨십: 쇼다운 없이 이겼으면 카드를 자진 공개할지 고른다
  if (findAug(winner, 'showmanship') && winner.hole.length >= 2 && state.lastFolderId) {
    winner.showPending = true;
    addLog(state, '쇼맨십: 홀카드를 공개하면 마지막으로 폴드한 상대에게서 1BB(하이카드면 2BB)를 받습니다.', { to: [winner.id] });
  }
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
  // 쇼다운 직후 선택(무승부 제안)이 남아 있으면 탈락 판정은 다음 핸드 시작 전에
  if (!state.players.some((p) => p.drawPrompt) && bustSweep(state)) return;
  state.phase = 'handEnd';
  state.decisionSeq++;
}

/** 탈락·추방된 사람의 상환 예약은 사라진다 (빌린 칩은 돌려받지 못함) */
function dropTasksOf(state: GameState, id: string): void {
  const gone = state.tasks.filter((t) => t.playerId === id && (t.kind === 'sharkRepay' || t.kind === 'loanRepay'));
  if (!gone.length) return;
  state.tasks = state.tasks.filter((t) => !gone.includes(t));
  addLog(state, `${playerById(state, id)?.name ?? '?'}의 빚이 사라졌습니다`);
}

/** 다음 핸드(upcoming)가 시작되기 전에 처리할 예약 작업 */
function runTasks(state: GameState, upcoming: number): void {
  const due = state.tasks.filter((t) => t.dueHand <= upcoming);
  if (!due.length) return;
  state.tasks = state.tasks.filter((t) => t.dueHand > upcoming);
  for (const t of due) TASKS[t.kind](state, t);
}

/** 칩이 0이 된 사람을 탈락시킨다. 남은 사람이 1명 이하면 게임을 끝내고 true */
function bustSweep(state: GameState): boolean {
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
    p.lockerPending = false;
    p.showPending = false;
    addLog(state, `${p.name} 탈락 (${p.place}위)`);
    dropTasksOf(state, p.id);
  });
  const remaining = state.players.filter(active);
  if (remaining.length <= 1) {
    endGame(state, remaining[0] ?? null);
    return true;
  }
  return false;
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

/** 보관함: 핸드가 끝난 뒤 보관할 카드 / 프리플랍에 보관한 카드와 바꿀 홀카드 */
function applyLocker(state: GameState, p: PlayerState, cardIndex: number): string | null {
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= p.hole.length) return '카드를 올바르게 고르세요.';
  if (state.phase === 'handEnd' && p.lockerPending) {
    p.lockerStored = p.hole[cardIndex];
    p.lockerPending = false;
    countUse(state, 'locker');
    note(state, p, 'info', `보관함: ${cardToken(p.lockerStored)}을(를) 보관했습니다. 다음 핸드 프리플랍에 바꿀 수 있습니다.`, [p.lockerStored]);
    return null;
  }
  if (p.lockerReady && basePhase(state) === 'betting' && state.street === 'preflop' && live(p)) {
    const old = p.hole[cardIndex];
    p.hole[cardIndex] = p.lockerReady;
    p.discarded.push(old);
    state.used.push({ card: old, kind: 'discard' });
    note(state, p, 'info', `보관함: ${cardToken(old)} → ${cardToken(p.lockerReady)} 교체`, [old, p.lockerReady]);
    p.lockerReady = null;
    return null;
  }
  return '지금은 보관함을 쓸 수 없습니다.';
}

/** 쇼맨십: 쇼다운 없이 이긴 뒤 카드 공개 여부 */
function applyShow(state: GameState, p: PlayerState, reveal: boolean): string | null {
  if (state.phase !== 'handEnd' || !p.showPending) return '지금은 카드를 공개할 수 없습니다.';
  p.showPending = false;
  if (!reveal) return null;
  const sm = findAug(p, 'showmanship')!;
  p.shown = true;
  const { bb } = currentBlinds(state);
  const bluff = evaluatePlayerHand(p.hole, evalBoard(state), rulesFor(p)).value.category === Category.HighCard;
  const folder = playerById(state, state.lastFolderId);
  const amount = folder && folder !== p ? Math.min((bluff ? 2 : 1) * bb, folder.chips) : 0;
  if (folder && amount > 0) {
    folder.chips -= amount;
    p.chips += amount;
  }
  countUse(state, 'showmanship');
  addLog(state, `${p.name}: 홀카드 공개 ${cardsText(p.hole)}${bluff ? ' (블러프!)' : ''}`);
  announceNamed(state, p, sm, '발동', folder ? `— ${folder.name}에게서 ${amount}칩` : '');
  if (state.result) state.result.extras.push(`${p.name}: 쇼맨십 ${bluff ? '블러프 공개' : '공개'} +${amount}`);
  return null;
}

/** 양자택일: 후보 중 하나 고르기 (턴 공개 전까지) */
function applyEitherOrPick(p: PlayerState, pick: number): string | null {
  if (!p.eitherOr) return '고를 후보가 없습니다.';
  if (pick !== 0 && pick !== 1) return '후보를 올바르게 고르세요.';
  if (p.eitherOr.pick !== null) return '이미 골랐습니다.';
  p.eitherOr.pick = pick;
  return null;
}

/** 핸드 종료 화면 이후 다음 핸드로 (서버가 잠시 기다렸다가 호출) */
export function startNextHand(state: GameState): ActionResult {
  if (state.phase !== 'handEnd') return { ok: false, error: '핸드가 끝나지 않았습니다.' };
  // 애착·보관함 선택을 안 했으면 높은 카드, 쇼맨십은 공개하지 않음
  for (const p of state.players) {
    const best = [...p.hole].sort((a, b) => rankOf(b) - rankOf(a))[0];
    if (p.attachPending) applyAttach(state, p, p.hole.indexOf(best));
    if (p.lockerPending) applyLocker(state, p, p.hole.indexOf(best));
    p.showPending = false;
    p.drawPrompt = null;
  }
  // 예약 작업 (사채 상환 등)
  runTasks(state, state.handNumber + 1);
  // 핸드가 끝난 뒤 칩이 바뀌었을 수 있다 (쇼맨십·상환 등)
  if (bustSweep(state)) return { ok: true };
  if (!betweenHands(state)) return { ok: true };
  state.handNumber++;
  const due = state.handNumber >= state.levelStartHand + state.levelHands;
  if (due || state.forceLevelUp) {
    state.forceLevelUp = false;
    state.levelIndex++;
    state.levelStartHand = state.handNumber;
    // 메이드 인 헤븐: 새 블라인드 레벨이 시작되면 모두 원래 시간으로
    if (state.heaven.length) addLog(state, '메이드 인 헤븐: 블라인드 레벨이 바뀌어 모두 원래 행동 시간으로 돌아갑니다');
    state.heaven = [];
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
  if (state.respond) return '제안·입찰에 대한 응답을 기다리는 중입니다.';
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
  if (typeof a.choice === 'number') params.choice = a.choice;
  if (typeof a.boardIndex === 'number') params.boardIndex = a.boardIndex;
  if (isAugmentId(a.rumor)) params.augment = a.rumor;
  const err = lockError(state) ?? effect.check(ctxFor(state, p, aug), params, false) ?? taxError(state, p);
  if (err) return err;
  declare(state, p, aug, params);
  return null;
}

/** 지금 버튼으로 선언할 수 있는가 (화면 안내용; 최종 검증은 applyAction) */
export function canUseNow(state: GameState, p: PlayerState, aug: OwnedAugment, params: ActiveParams = {}): string | null {
  if (state.phase === 'gameOver' || p.out) return '게임에 참여하고 있지 않습니다.';
  if (state.respond) return '제안·입찰에 대한 응답을 기다리는 중입니다.';
  const def = AUGMENTS[aug.id];
  if (def.uses?.per === 'game' && (aug.usesLeft ?? 0) <= 0) return '남은 사용 횟수가 없습니다.';
  if (def.uses?.per === 'hand' && aug.usedThisHand) return '이번 핸드에 이미 사용했습니다.';
  const effect = ACTIVE[aug.id];
  if (!effect || def.trigger !== 'button') return def.timing;
  return lockError(state) ?? effect.check(ctxFor(state, p, aug), params, false) ?? taxError(state, p);
}

// ───────────────────────── 공개 API ─────────────────────────

export function applyAction(state: GameState, playerId: string, action: GameAction): ActionResult {
  const joiner = getJoiner(state, playerId);
  if (joiner) {
    // 자리에 앉기 전에는 증강 선택만 할 수 있다
    if (!action || typeof action !== 'object' || action.type !== 'pick') return { ok: false, error: '다음 핸드부터 참여합니다.' };
    const err = isAugmentId(action.augment) ? applyJoinerPick(state, joiner, action.augment, parityArg(action.parity)) : '알 수 없는 증강입니다.';
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
      err = isAugmentId(action.augment) ? applyPick(state, p, action.augment, parityArg(action.parity)) : '알 수 없는 증강입니다.';
      break;
    case 'discard':
      err = applyDiscard(state, p, action.cardIndex);
      break;
    case 'declare':
      err = applyDeclare(state, idx, action);
      break;
    case 'counter':
      err = applyCounter(state, p);
      break;
    case 'attach':
      err = applyAttach(state, p, action.cardIndex);
      break;
    case 'locker':
      err = findAug(p, 'locker') || p.lockerReady ? applyLocker(state, p, action.cardIndex) : '보관함이 없습니다.';
      break;
    case 'eitherOr':
      err = applyEitherOrPick(p, action.pick);
      break;
    case 'show':
      err = applyShow(state, p, action.reveal === true);
      break;
    case 'immunity':
      err = applyImmunity(state, p);
      break;
    case 'draw':
      err = applyDraw(state, p, action.accept === true);
      break;
    case 'respond':
      err = applyRespond(state, p, action);
      break;
    case 'turnRiver':
      err = !p.turnRiver || p.turnRiver.swap !== null ? '정할 순서가 없습니다.' : null;
      if (!err) p.turnRiver!.swap = action.swap === true;
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
    case 'respond':
      return { seq, kind: 'respond', playerIds: respondPending(state).map((p) => p.id) };
    case 'handEnd':
      return { seq, kind: 'handEnd', playerIds: state.players.filter((p) => p.attachPending || p.lockerPending || p.showPending || p.drawPrompt).map((p) => p.id) };
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
      return p.forcedCall || noFold(state, p) ? { type: 'call' } : { type: 'fold' };
    case 'discard':
      return { type: 'discard', cardIndex: state.rng.int(3) };
    case 'declare':
      return { type: 'declare', augment: null };
    case 'respond':
      return { type: 'respond', ...respondDefault(state, p) };
    case 'handEnd': {
      const best = Math.max(0, p.hole.indexOf([...p.hole].sort((a, b) => rankOf(b) - rankOf(a))[0]));
      if (p.attachPending) return { type: 'attach', cardIndex: best };
      if (p.lockerPending) return { type: 'locker', cardIndex: best };
      if (p.drawPrompt) return { type: 'draw', accept: false };
      return { type: 'show', reveal: false };
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
  if (pending.kind === 'respond') {
    finishRespond(state);
    return pending.playerIds;
  }
  const affected: string[] = [];
  for (const id of pending.playerIds) {
    const act = defaultActionFor(state, id);
    if (!act) continue;
    if (pending.kind === 'turn') addLog(state, `${playerById(state, id)!.name}: 시간 초과`);
    if (pending.kind === 'turn' && act.type === 'fold' && turnCutFor(state, id) > 0) state.stats.heavenFolds++;
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
    fold: !p.forcedCall && !noFold(state, p),
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
