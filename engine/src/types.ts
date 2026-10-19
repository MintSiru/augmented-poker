// 엔진 내부 상태 타입과 행동 타입.
// GameState 는 서버 메모리 안에만 존재하며, 클라이언트로는 view.ts 가 만든 PlayerView 만 나간다.

import type { Card } from './cards.js';
import type { AugmentId } from './augments.js';
import type { Rng } from './rng.js';
import type { AppliedVariant } from './evaluator.js';

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

/**
 * augmentSelect: 증강 선택 / betting: 베팅 / discard: 세 번째 손 동시 결정
 * declare: 턴·리버 공개 직후 선언 기회(되감기·봉인·밥상 뒤집기) / reaction: 증강 선언 후 3초 반응 대기
 * handEnd: 핸드 결과 / gameOver
 */
export type Phase = 'augmentSelect' | 'betting' | 'discard' | 'declare' | 'reaction' | 'handEnd' | 'gameOver';

export interface OwnedAugment {
  id: AugmentId;
  /** 게임 전체 남은 횟수 (null = 제한 없음 또는 핸드당 사용) */
  usesLeft: number | null;
  /** 핸드당 1회 증강: 이번 핸드에 썼는가 */
  usedThisHand: boolean;
  /** 다른 플레이어에게 공개되었는가 */
  revealed: boolean;
  /** 공개 시 다른 사람에게 보이는 증강 (위장 시 가짜) */
  publicId: AugmentId | null;
  /** 편애: 와일드 숫자 2..14 */
  wildRank?: number;
  /** 면제권: 켜져 있으면 블라인드 차례에 자동 사용 */
  armed?: boolean;
  /** 위장: 준비해 둔 가짜 증강 */
  fakeId?: AugmentId | null;
  /** 양치기 소년: 게임 1회 가짜 공개를 썼는가 */
  fakeUsed?: boolean;
  /** 짝수/홀수 동맹: 고른 쪽 */
  parity?: 'even' | 'odd';
  acquiredHand: number;
}

export type NoteKind =
  | 'clairvoyance'
  | 'thermal'
  | 'liedetector'
  | 'foresight'
  | 'observer'
  | 'inquiry'
  | 'mulligan'
  | 'discard'
  | 'mirror'
  | 'disinfo'
  | 'blank'
  | 'thermometer'
  | 'radar'
  | 'forecast'
  | 'leaderboard'
  | 'traceback'
  | 'bet'
  | 'info';

/** 해당 플레이어만 아는 정보 */
export interface PrivateNote {
  hand: number;
  kind: NoteKind;
  text: string;
  cards?: Card[];
  targetId?: string;
}

export interface PlayerState {
  id: string;
  name: string;
  isBot: boolean;
  seat: number;
  chips: number;
  out: boolean;
  outAtHand: number | null;
  place: number | null;
  sittingOut: boolean;
  augments: OwnedAugment[];
  /** 다음 증강 선택을 건너뛸 횟수 (하이리스크 패배) */
  skipPicks: number;
  pickOptions: AugmentId[] | null;
  notes: PrivateNote[];

  // ---- 핸드 단위 상태 ----
  inHand: boolean;
  hole: Card[];
  folded: boolean;
  allIn: boolean;
  wentAllIn: boolean;
  streetBet: number;
  /** 무임승차로 이번 스트리트에 면제된 콜 금액 (실제로 내지 않았지만 맞춘 것으로 본다) */
  streetShort: number;
  contributed: number;
  acted: boolean;
  actedLevel: number;
  actedPreflop: boolean;
  mulliganFee: number;
  lastAction: string | null;
  /** 쇼다운에서 카드를 공개했는가 */
  shown: boolean;
  foreseen: number[];
  discarded: Card[];
  pendingDiscard: number | null;
  /** 강제 집행 대상: 폴드할 수 없고 콜해야 한다 */
  forcedCall: boolean;
  /** 양치기 소년으로 공개한 카드 (진짜·가짜 구분 없이 공개 정보) */
  shepherdShown: Card[];
  /** 비공개: 이번 핸드에 가짜 카드를 공개했는가 */
  shepherdLied: boolean;
  /** 애착: 다음 핸드로 가져갈 카드 */
  keptCard: Card | null;
  /** 애착: 핸드 종료 후 가져갈 카드를 고르는 중 */
  attachPending: boolean;
  /** 추방됨: 진행 중인 핸드는 폴드 처리되고, 핸드가 끝나면 자리에서 제거된다 */
  kicked: boolean;

  // ---- 2차 증강 상태 ----
  /** 이번 핸드에 낸 블라인드(폭탄 팟 앤티 포함) — 나 다시 돌아갈래에서 돌려주지 않는 몫 */
  blindPosted: number;
  /** 모범납세자: 블라인드를 낸 횟수 (게임 전체) */
  blindsPaid: number;
  /** 철벽: 이번 핸드 동안 지목형 증강의 대상이 될 수 없다 */
  ironWall: boolean;
  /** 블랙잭을 발동했다 (이번 핸드) */
  blackjackOn: boolean;
  /** 내기할래?: 예측한 우승 족보 종류 (0~7, 7 = 포카드 이상) */
  betPrediction: number | null;
  /** 데스티니 드로우: 다음 핸드에 받을 카드 */
  destinyCard: Card | null;
  /** 보관함: 핸드 종료 후 보관할 카드를 고르는 중 / 보관한 카드 / 이번 핸드 프리플랍에 바꿀 수 있는 카드 */
  lockerPending: boolean;
  lockerStored: Card | null;
  lockerReady: Card | null;
  /** 양자택일: 턴 후보 2장과 고른 쪽 */
  eitherOr: { cards: Card[]; pick: number | null } | null;
  /** 왕귀: 쇼다운에서 팟을 못 받고 진 횟수 */
  lateLosses: number;
  /** 쇼맨십: 핸드 종료 후 카드 공개 여부를 고르는 중 */
  showPending: boolean;
  /** 이 플레이어에게 보여 줄 로그의 시작 번호 (중도 참여자는 참여 이후 로그만 본다) */
  logFrom: number;
}

/** 중도 참여 대기자: 다른 플레이어가 받은 증강 선택 횟수만큼 고른 뒤 다음 핸드 시작 때 자리에 앉는다 */
export interface Joiner {
  player: PlayerState;
  /** 앞으로 고를 증강 수 (지금 고르는 중인 것 포함) */
  picksLeft: number;
  picksTotal: number;
  /** 선택지가 바뀔 때마다 증가 (서버의 30초 타이머 기준) */
  pickSeq: number;
}

export interface LogEntry {
  seq: number;
  hand: number;
  text: string;
  to?: string[];
  except?: string[];
}

export interface PotResult {
  amount: number;
  eligible: string[];
  winners: string[];
}

export interface ShowdownEntry {
  id: string;
  cards: Card[];
  handName: string;
  bestCards: Card[];
  score: number[];
  applied: AppliedVariant[];
  /** 동점 처리 증강이 승부를 가른 경우 */
  tiebreak: AugmentId[];
}

export interface HandResult {
  hand: number;
  showdown: boolean;
  board: Card[];
  sealed: number[];
  entries: ShowdownEntry[];
  pots: PotResult[];
  won: Record<string, number>;
  /** 결과 화면 상단에 표시할 테이블 효과 (족보 역전, 봉인 등) */
  table: string[];
  /** 부가 효과 (하이리스크 보너스, 양치기 소년 벌금 등) */
  extras: string[];
}

export interface DebugDeal {
  board?: Card[];
  hands?: Record<string, Card[]>;
  /** 번 카드 3장 (플랍·턴·리버 앞) */
  burns?: Card[];
  /** 남은 덱 맨 위부터의 순서 (멀리건 교체·되감기에 쓰이는 카드) */
  deck?: Card[];
}

/** 블라인드 상승 방식: 기본 표(1→2→4→7.5→15→30→60배 …) / 레벨마다 1.5배 */
export type BlindSchedule = 'standard' | 'x1.5';
/** 블라인드 상승 주기: 자동(레벨 시작 시 남은 인원 × 2핸드) / 고정 N핸드 */
export type LevelMode = 'auto' | 'fixed';

export interface GameOptions {
  startingChips: number;
  /** 시작 빅블라인드 (스몰블라인드는 절반) */
  bigBlind: number;
  blindSchedule: BlindSchedule;
  levelMode: LevelMode;
  /** 고정 주기일 때 레벨당 핸드 수 */
  fixedLevelHands: number;
  debug: boolean;
}

/** 사용된 카드 (카운팅 보유자에게만 보임) */
export interface UsedCard {
  card: Card;
  /** shown: 공개하고 버린 카드 (마지막 갈림길) */
  kind: 'burn' | 'fold' | 'discard' | 'rewind' | 'shown';
}

/** 베팅 라운드 단위 상태 (서킷브레이커·자물쇠) */
export interface RoundState {
  /** 이번 라운드의 레이즈(올인 레이즈 포함) 수 */
  raises: number;
  /** 이번 라운드 베팅 행동 수 (자물쇠: 0일 때만 선언) */
  actions: number;
  /** 라운드 시작 시점 (서킷브레이커로 되돌릴 때) */
  startBets: Record<string, number>;
  startCurrentBet: number;
  startMinRaise: number;
  startSetter: { idx: number; raise: boolean } | null;
  firstFrom: number;
  /** 남은 레이즈 허용 수 (null = 제한 없음). 서킷브레이커 후 1 */
  raiseCap: number | null;
  /** 자물쇠: 이번 라운드에는 액티브·공개형 증강 사용 불가 */
  locked: boolean;
}

export interface TableEffects {
  glass: boolean;
  blackout: boolean;
  /** 짙은 안개: 플랍을 볼 수 있는 선언자 */
  fogSeers: string[];
  /** 쇼다운에서 안개가 걷혔는가 */
  fogLifted: boolean;
  flips: number;
  rewinds: number;
  sealed: number[];
  /** 실명 다트 대상 (쇼다운 전까지 보드를 못 봄) */
  blindDarted: string[];
  /** 폭탄 팟 핸드 */
  bomb: boolean;
  /** 언더독 적용 핸드 */
  underdog: boolean;
  /** 면역: 암전 중에도 자기 카드를 보는 사람, 유리 테이블에서 카드를 숨긴 사람 */
  blackoutImmune: string[];
  glassImmune: string[];
  /** 나 다시 돌아갈래로 다시 시작한 핸드 */
  restarted: boolean;
}

/** 선언된 액티브·공개형 증강 (3초 반응 대기 후 적용) */
export interface Declaration {
  id: number;
  ownerId: string;
  augment: AugmentId;
  params: ActiveParams;
  /** "비공개 증강 사용" 알림 (이름 숨김) */
  anonymous: boolean;
  /** 이름 공개형일 때 다른 사람에게 보이는 이름 (위장 반영) */
  publicName: string | null;
  countered: boolean;
  counteredBy: string | null;
  /** 죽음과 세금으로 낸 세금 (효과가 성립하지 않으면 돌려준다) */
  taxPaid: number;
  /** 면역: 이 공개형 효과에서 빠지는 사람 */
  immune: string[];
  /** 소문처럼 선언자까지 숨기는 선언 */
  secret: boolean;
}

export interface ActiveParams {
  targetId?: string;
  cardIndex?: number;
  card?: Card;
  boardIndex?: number;
  /** 면제권: 어느 블라인드인가 */
  blind?: 'SB' | 'BB';
  /** 내기할래?: 예측 족보 (0~7) */
  choice?: number;
  /** 소문: 퍼뜨릴 증강 */
  augment?: AugmentId;
}

export interface GameStats {
  picks: Partial<Record<AugmentId, number>>;
  uses: Partial<Record<AugmentId, number>>;
  /** 은행에서 새로 생성된 칩 (하이리스크 보너스) */
  bankChips: number;
  /** 은행으로 사라진 칩 (죽음과 세금) */
  bankTaxed: number;
  /** 그 밖에 은행에 낸 칩 (나 다시 돌아갈래) */
  bankPaid: number;
  /** 중도 참여자에게 은행에서 새로 지급한 칩 */
  joinChips: number;
  /** 추방으로 사라진 칩 */
  kickedChips: number;
}

export interface GameState {
  options: GameOptions;
  rng: Rng;
  players: PlayerState[];
  phase: Phase;
  handNumber: number;
  levelIndex: number;
  /** 현재 레벨이 시작된 핸드 번호와 이 레벨의 핸드 수 (자동 주기는 레벨 시작 시 남은 인원 × 2) */
  levelStartHand: number;
  levelHands: number;
  /** 지금까지 열린 증강 선택 횟수 (중도 참여자가 고를 개수) */
  pickRounds: number;
  /** 중도 참여 대기자 (아직 자리에 앉지 않음) */
  joiners: Joiner[];
  /** 자리를 비켜 준 탈락자 (계속 관전할 수 있도록 보관) */
  retired: PlayerState[];
  dealerIdx: number;
  sbIdx: number;
  bbIdx: number;
  street: Street;
  /** 핸드 시작 시 미리 떼어 둔 보드 5장 (공개된 만큼만 뷰로 나감) */
  board: Card[];
  /** 핸드 시작 시 미리 떼어 둔 번 카드 3장 (플랍·턴·리버 앞) */
  burns: Card[];
  boardRevealed: number;
  /** 남은 덱 (멀리건 교체, 되감기용) */
  deck: Card[];
  used: UsedCard[];
  effects: TableEffects;
  /** 다음 핸드에 암전 적용 */
  blackoutNext: boolean;
  /** 다음 핸드 암전을 선언한 사람 (추방되면 효과가 끝난다) */
  blackoutBy: string | null;
  /** 다음 핸드 암전에서 면역으로 빠진 사람 */
  blackoutImmuneNext: string[];
  /** 다음 핸드 폭탄 팟 */
  bombNext: boolean;
  /** 언더독: 앞으로 적용될 핸드 수 (이번 핸드 제외) */
  underdogLeft: number;
  /** 죽음과 세금 선언자별 면역으로 세금이 면제된 사람 */
  taxExempt: Record<string, string[]>;
  /** 이번 베팅 라운드 */
  round: RoundState;
  /** 마지막으로 폴드한 사람 (쇼맨십) */
  lastFolderId: string | null;
  currentBet: number;
  minRaise: number;
  toAct: number | null;
  /** 이번 스트리트의 베팅 기준을 마지막으로 만든 행동 (무임승차 조건) */
  betSetter: { idx: number; raise: boolean } | null;
  /** 베팅 행동 일련번호와 마지막 공격 행동 (거짓말 탐지기 "직후" 판정) */
  betActionSeq: number;
  lastAggression: { idx: number; seq: number; street: Street } | null;
  deadMoney: number;
  /** 선언 기회 대기열 (플레이어 인덱스, 앞이 현재 차례) */
  declareQueue: number[];
  /** 반응 대기: 선언 대기열과 끝난 뒤 돌아갈 단계 */
  reaction: { queue: Declaration[]; resume: Phase } | null;
  declSeq: number;
  decisionSeq: number;
  result: HandResult | null;
  log: LogEntry[];
  logSeq: number;
  winnerId: string | null;
  nextDeal: DebugDeal | null;
  forceLevelUp: boolean;
  /** 죽음과 세금을 선언한 플레이어 (게임 끝까지 유지) */
  taxers: string[];
  stats: GameStats;
}

export type BetAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call'; freeRide?: boolean }
  /** amount = 이번 스트리트에 내 베팅 총액이 되도록 (raise to) */
  | { type: 'raise'; amount: number }
  | { type: 'allin' };

export type GameAction =
  | BetAction
  | { type: 'pick'; augment: AugmentId; parity?: 'even' | 'odd' }
  | { type: 'discard'; cardIndex: number }
  /** 선언 기회: augment=null 이면 넘기기 */
  | { type: 'declare'; augment: AugmentId | null; boardIndex?: number }
  | { type: 'counter' }
  | { type: 'attach'; cardIndex: number }
  /** 보관함: 핸드 종료 후 보관할 카드 / 프리플랍에 보관한 카드와 바꿀 홀카드 */
  | { type: 'locker'; cardIndex: number }
  /** 양자택일: 턴 후보 중 고르기 */
  | { type: 'eitherOr'; pick: number }
  /** 쇼맨십: 카드 공개 여부 */
  | { type: 'show'; reveal: boolean }
  /** 면역: 반응 대기 중인 공개형 효과에서 빠진다 */
  | { type: 'immunity' }
  | {
      type: 'useAugment';
      augment: AugmentId;
      targetId?: string;
      cardIndex?: number;
      card?: Card;
      fakeId?: AugmentId | null;
      on?: boolean;
      choice?: number;
      boardIndex?: number;
      rumor?: AugmentId;
    };

export type ActionResult = { ok: true } | { ok: false; error: string };

export type PendingKind = 'turn' | 'pick' | 'discard' | 'declare' | 'reaction' | 'handEnd' | 'none';

export interface Pending {
  seq: number;
  kind: PendingKind;
  /** 결정해야 하는 플레이어 (reaction 은 카운터 스펠 보유자와 무관하게 항상 빈 배열) */
  playerIds: string[];
}
