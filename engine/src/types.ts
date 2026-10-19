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
export type Phase = 'augmentSelect' | 'betting' | 'discard' | 'declare' | 'reaction' | 'respond' | 'handEnd' | 'gameOver';

/** 제안·응답: 한 명에게 제안해 수락/거절을 받거나(offer), 여러 명에게서 비공개 입찰·선언을 동시에 모은다(collect) */
export interface RespondAnswer {
  accept?: boolean;
  bid?: number;
  /** 강함/약함, 교환 진열대·재활용의 고른 후보 카드 번호 (-1 = 바꾸지 않음) 등 */
  choice?: number;
  cardIndex?: number;
}

export interface RespondState {
  kind: 'offer' | 'collect';
  augment: AugmentId;
  ownerId: string;
  /** 응답해야 하는 사람 */
  participants: string[];
  /** 응답 (결과가 나올 때까지 당사자 뷰에만) */
  answers: Record<string, RespondAnswer>;
  /** 제안 내용 (선언자가 고른 카드 등, 당사자 뷰에만) */
  params: { targetId?: string; cardIndex?: number; card?: Card; extra?: Record<string, unknown> };
  /** 응답 제한 시간 (초, 기본 15) */
  seconds?: number;
  /** 공동 환승: 수락 후 각자 카드 고르기 단계 */
  stage: 'offer' | 'pick';
  /** 응답이 끝나면 돌아갈 단계 */
  resume: Phase;
  seq: number;
}

/** N핸드 뒤 자동으로 처리되는 예약 작업 */
export interface ScheduledTask {
  kind: 'sharkRepay' | 'loanRepay' | 'revive';
  playerId: string;
  /** 사채: 빌려준 사람 */
  otherId?: string;
  /** 이 핸드가 시작되기 직전에 처리 */
  dueHand: number;
  amount: number;
}

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
  /** 잠복으로 숨긴 증강 (처음 쓰는 순간 드러남) */
  hidden?: boolean;
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
  | 'info'
  /** 증강을 주고받은 기록 (핸드가 바뀌어도 남김) */
  | 'augment';

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
  /** 턴과 리버 사이: 미리 본 두 카드의 보드 위치와 순서를 바꿀지 (null = 아직 안 정함) */
  turnRiver: { idx: number[]; cards: Card[]; swap: boolean | null } | null;
  /** 무승부로 하지 않을래?: 쇼다운 직후 제안할 수 있는 상대와 팟 */
  drawPrompt: { winnerId: string; pots: number[] } | null;
  /** 진실 게임: 공개 선언한 족보 종류 (0~7) */
  truthClaim: number | null;
  /** 밀봉 계약: 0 = 전원 폴드, 1 = 한 명 이상 콜 (비공개) */
  contract: number | null;
  /** 3일 안에 오리라: 부활 대기 중이면 돌아올 핸드 번호 (out 은 true) */
  dormant: number | null;
  /** 폭주기관차: 연승 수 (공개) */
  streak: number;
  /** 폭주기관차: 이번 증강 선택에서 더 가져갈 수 있는 개수 */
  pickExtra: number;
  /** 잠복: 숨길 증강을 고를 수 있는 동안 (다음 핸드 시작 전까지) */
  lurkChoose: boolean;
  /** 잠복: 숨길 증강이 없어 다음에 얻는 증강을 숨긴다 */
  lurkWaiting: boolean;
  /** 기생: 이번 핸드에 홀카드를 빌려 쓰는 상대 */
  parasite: string | null;
  /** 승격: 이번 핸드 족보 한 단계 위로 */
  promoted: boolean;
  /** 연금술: 이번 핸드 족보 계산에서 바꾼 홀카드 (공개) */
  alchemy: { index: number; from: Card; to: Card } | null;
  /** 증강 리롤: 남은 횟수 (게임 전체) */
  rerolls: number;
  /** 재충전: 되돌릴 증강을 고르는 중 / 이번 선택 라운드에서 이미 재충전했는가 */
  rechargePending: boolean;
  rechargeDone: boolean;
  /** 이번 핸드에 공개된 내 홀카드 (미끼 공개·반쪽짜리 비밀·배짱 시험·교환 진열대 등, 이미 공개된 카드로 취급) */
  exposed: Card[];
  /** 봉인 봉투: 보관 중인 예비 카드 (나만 봄, 플랍 라운드 동안 교체 가능) */
  envelope: Card | null;
  /** 선불 교환: 플랍 직전에 새 카드 1장을 받는다 */
  prepay: boolean;
  /** 냉동 보관: 보관한 카드 (핸드가 바뀌어도 유지, 이후 덱에서 제외) */
  frozen: Card | null;
  /** 한도 설정: 이번 핸드에 낼 수 있는 최대 칩 (null = 없음) / 다음 핸드에 걸 한도 */
  betCap: number | null;
  betCapNext: boolean;
  /** 적금: 적립한 0.1BB 단위 수 (나에게만) */
  savings: number;
  /** 예약 주문: 이번 핸드에 지정한 숫자 (공개) */
  reserveRank: number | null;
  /** 현상수배: 이번 핸드·다음 핸드 대상 */
  wanted: string | null;
  wantedNext: string | null;
  /** 사이드 베팅·빨대 꼽기: 비공개로 지목한 사람 */
  sideBetOn: string | null;
  strawOn: string | null;
  /** 복수: 직전 쇼다운에서 나를 이긴 상대 (나에게만) */
  nemesis: string | null;
  /** 연승을 마지막으로 센 핸드 (연승 수당·폭주기관차가 같은 카운터를 쓰므로 한 번만) */
  streakHand: number;
  /** 연막탄: 공개할 때 끝까지 숨긴 홀카드 (다른 플레이어 뷰·로그에서 '??') */
  smoked: Card | null;
  /** 인디언 포커: 이마에 붙인 홀카드 (본인만 못 봄) */
  forehead: Card | null;
  /** 색맹: 이번 핸드 색 플러시 */
  colorBlindOn: boolean;
  /** 그림자 분신: 이번 판정에서 무늬를 바꾼 홀카드 */
  shadow: { index: number; to: Card } | null;
  /** 오마하의 피: 홀카드 2장을 모두 써서 한 단계 위로 */
  omaha: boolean;
  /** 기록관용: 이번 핸드 프리플랍에 자발적으로 칩을 냈는가, 리버에서 베팅·레이즈했는가 */
  vpipHand: boolean;
  aggressed: boolean;
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

/** 팟 분할 판정 단위 (보드별, 하이·로우, 팀별, 무승부) */
export interface PotUnit {
  label: string;
  amount: number;
  winners: string[];
}

export interface PotResult {
  amount: number;
  eligible: string[];
  winners: string[];
  /** 둘 이상의 판정 단위로 나뉜 경우 */
  units?: PotUnit[];
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
  /** 다른 판정 단위(두 번째 보드)의 족보 */
  alt?: { label: string; handName: string }[];
}

export interface HandResult {
  hand: number;
  showdown: boolean;
  board: Card[];
  sealed: number[];
  /** 더블 보드·두 번의 운명의 두 번째 보드 */
  board2?: Card[];
  entries: ShowdownEntry[];
  pots: PotResult[];
  won: Record<string, number>;
  /** 결과 화면 상단에 표시할 테이블 효과 (족보 역전, 봉인 등) */
  table: string[];
  /** 부가 효과 (하이리스크 보너스, 양치기 소년 벌금 등) */
  extras: string[];
  /** 이 핸드로 칩이 0이 된 사람 (토템·부활로 살아나도 포함, 사냥꾼 판정용) */
  busted?: string[];
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
  /** 증강 선택에 "재충전" 카드를 보여 준다 */
  recharge: boolean;
  /** 플레이어당 게임 전체 증강 리롤 횟수 */
  rerolls: number;
  /** 이번 게임의 증강 풀 (null = 전체). 새 증강을 뽑는 모든 곳에 적용 */
  pool: AugmentId[] | null;
}

/** 사용된 카드 (카운팅 보유자에게만 보임) */
export interface UsedCard {
  card: Card;
  /** shown: 공개하고 버린 카드 (마지막 갈림길) */
  kind: 'burn' | 'fold' | 'discard' | 'rewind' | 'shown' | 'called';
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
  /** 한 번만 더: raiseCap 이 이 효과로 걸렸는가 (상한을 넘는 올인은 콜 금액만) */
  oneMore: boolean;
  /** 자물쇠: 이번 라운드에는 액티브·공개형 증강 사용 불가 */
  locked: boolean;
  /** 자본주의: 이번 라운드에서 가장 크게 베팅·레이즈한 사람과 금액 */
  maxPut: { id: string; amount: number } | null;
  capitalDone: boolean;
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
  /** 안경 없어서 잘 안보여: 선언자(가림에서 빠짐), 면역으로 빠진 사람, 선언 시점 로그 번호 */
  glasses: string[];
  glassesImmune: string[];
  glassesSeq: number;
  /** 하이로우: 팟을 가장 높은 패와 가장 낮은 패가 반씩 */
  highLow: boolean;
  /** 배수진: 폴드·레이즈 금지 (면역이면 폴드 가능) */
  lastStand: boolean;
  lastStandImmune: string[];
  /** 자본주의: 플랍·턴 라운드가 끝날 때마다 가장 크게 베팅한 사람이 보드 1장 추가 여부를 정함 */
  capitalism: boolean;
  /** 자석: 지정한 무늬, 이미 다시 뽑았는가 */
  magnet: { suit: string; used: boolean } | null;
  /** 두 번의 운명 (두 번째 보드는 리버만 다름) */
  twoFates: boolean;
  /** 침묵의 리버: 리버 베팅 없이 쇼다운 */
  silentRiver: boolean;
  /** 시한폭탄: 체크 = 폴드 (면역·올인 예외) */
  timeBomb: boolean;
  timeBombImmune: string[];
  /** 공용 카드: 모두가 보드처럼 쓰는 공개 카드 */
  shared: Card[];
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
  /** 탈취: 원래 선언자 (ownerId 는 탈취한 사람으로 바뀐다) */
  stolenFrom?: string | null;
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
  /** 그 밖에 은행에 낸 칩 (나 다시 돌아갈래, 대출 상환 등) */
  bankPaid: number;
  /** 메이드 인 헤븐 적용 중 시간 초과로 자동 폴드된 횟수 */
  heavenFolds: number;
  /** 중도 참여자에게 은행에서 새로 지급한 칩 */
  joinChips: number;
  /** 추방으로 사라진 칩 */
  kickedChips: number;
  /** 플레이어별 재충전한 증강 */
  recharges: Record<string, AugmentId[]>;
  /** 증강별 선택지에 나온 횟수 */
  offered: Partial<Record<AugmentId, number>>;
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
  /** 두 번째 보드 (더블 보드, 두 번의 운명). 첫 보드와 같은 장수만큼 공개된다 */
  board2: Card[] | null;
  /** 스트리트별 누적 공개 장수 (기본 3-4-5, 거꾸로 강을 거슬러 1-2-5). 보드가 늘어나면 extraCards 만큼 뒤로 밀린다 */
  revealPlan: number[];
  extraCards: number;
  /** 미리 공개된 예약 카드 (미리 온 결말, 동결) */
  reservedPublic: { index: number; card: Card; label: string }[];
  /** 다른 효과가 바꿀 수 없는 확정 카드의 보드 위치 (예약 카드, 턴과 리버 사이) */
  fixedIdx: number[];
  /** 다음 핸드에 적용할 보드 효과 */
  nextHand: { reverse: boolean; prophecy: boolean; freezeCard: Card | null };
  /** 지금 열린 선언 기회의 단계 */
  windowStage: 'flop' | 'turn' | 'turnEnd' | 'river' | 'preShowdown' | null;
  /** 딜러의 변덕: 아직 시작하지 않은 반시계 핸드 수, 이번 핸드가 반시계인가 */
  whimLeft: number;
  reversed: boolean;
  /** 인디언 포커: 다음 핸드에 이마 카드를 붙이는가 (면역으로 빠진 사람) */
  indianNext: boolean;
  indianImmuneNext: string[];
  /** 자본주의: 보드 추가 여부를 정하는 사람 */
  capitalChooser: string | null;
  /** 진행 중인 제안·입찰 */
  respond: RespondState | null;
  respondSeq: number;
  /** 카드 경매로 앞면 공개된 카드 */
  auctionCard: Card | null;
  /** 눈싸움: 두 사람과 비공개 선언 (1 = 강함, 0 = 약함) */
  staredown: { a: string; b: string; claims: Record<string, number> } | null;
  /** 명추리 성공: 쇼다운 없이 이 사람이 참여할 수 있는 팟을 모두 가져간다 */
  nameItWinner: string | null;
  /** 예약 작업 (사채·대출 상환, 부활) */
  tasks: ScheduledTask[];
  /** 운명 공동체: 이번 핸드의 팀 (2명씩) */
  teams: string[][];
  /** 운명 공동체: 다음 핸드에 적용할 팀 */
  teamsNext: string[][] | null;
  /** 교환 진열대로 모두에게 공개된 후보 카드 */
  offerCards: Card[];
  /** 복기 노트: 플랍이 공개된 시점에 각자 완성했던 족보 종류 (핸드마다) */
  flopCategory: Record<string, number>;
  /** 기록관: 플레이어별 공개 행동 기록 (참여 핸드 수, 프리플랍 참여 수, 쇼다운에서 드러난 블러프 수) */
  records: Record<string, { hands: number; vpip: number; bluffs: number }>;
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
  /** 메이드 인 헤븐: 선언자별 시작 핸드 (다음 핸드부터 매 핸드 5초씩 감소, 블라인드 레벨이 바뀌면 초기화) */
  heaven: { by: string; startHand: number; immune: string[] }[];
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
  | { type: 'declare'; augment: AugmentId | null; boardIndex?: number; cardIndex?: number; targetId?: string; choice?: number; card?: Card }
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
  /** 턴과 리버 사이: 미리 본 두 카드의 순서를 바꿀지 */
  | { type: 'turnRiver'; swap: boolean }
  /** 무승부로 하지 않을래?: 쇼다운 직후 제안 여부 */
  | { type: 'draw'; accept: boolean }
  /** 탈취: 반응 대기 중인 선언을 빼앗고 대상·카드를 다시 고른다 */
  | { type: 'steal'; targetId?: string; boardIndex?: number; cardIndex?: number; choice?: number }
  /** 봉인 봉투: 보관 카드와 바꿀 홀카드 (생략하면 버림) */
  | { type: 'envelope'; cardIndex?: number }
  /** 냉동 보관: 보관한 카드를 꺼내 홀카드와 바꾼다 */
  | { type: 'coldStorage'; cardIndex: number }
  /** 증강 리롤: 지금 선택지를 새로 뽑는다 */
  | { type: 'reroll' }
  /** 재충전: augment 없이 보내면 재충전 카드를 고른 상태(대상 고르기), augment 를 주면 그 증강을 처음 횟수로 */
  | { type: 'recharge'; augment?: AugmentId }
  /** 잠복: 숨길 증강 고르기 */
  | { type: 'lurk'; augment: AugmentId }
  /** 제안·입찰·비공개 선언에 대한 응답 */
  | { type: 'respond'; accept?: boolean; bid?: number; choice?: number; cardIndex?: number }
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

export type PendingKind = 'turn' | 'pick' | 'discard' | 'declare' | 'reaction' | 'respond' | 'handEnd' | 'none';

export interface Pending {
  seq: number;
  kind: PendingKind;
  /** 결정해야 하는 플레이어 (reaction 은 카운터 스펠 보유자와 무관하게 항상 빈 배열) */
  playerIds: string[];
}
