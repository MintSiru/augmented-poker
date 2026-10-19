// 증강 데이터 정의 (이름, 별, 카테고리, 횟수, 발동 방식, 공개 방식, 사용 시점 안내)와 선택지 생성 규칙.
// 효과 함수는 effects.ts 에 따로 있다. 2차 풀 증강은 여기에 정의를 추가하고 effects.ts 에 효과를 등록하면 된다.

import { Rng, sample } from './rng.js';

export type AugmentId =
  // 정보형
  | 'observer'
  | 'thermal'
  | 'clairvoyance'
  | 'liedetector'
  | 'counting'
  | 'foresight'
  // 카드 조작형
  | 'mulligan'
  | 'thirdHand'
  | 'rewind'
  | 'attachment'
  | 'seal'
  // 족보 변형형
  | 'wrapStraight'
  | 'kickerMaster'
  | 'fourFlush'
  | 'gapStraight'
  | 'absoluteKicker'
  | 'favoritism'
  // 경제/베팅형
  | 'insurance'
  | 'exemption'
  | 'highRisk'
  | 'freeRide'
  | 'enforcement'
  // 심리전형
  | 'disguise'
  | 'inquiry'
  | 'blank'
  | 'shepherd'
  // 방어/카운터형
  | 'disinfo'
  | 'vest'
  | 'mirror'
  | 'counterSpell'
  // 공개형
  | 'blackout'
  | 'glassTable'
  | 'russianRoulette'
  | 'flipTable'
  | 'heavyFog'
  | 'deathTax'
  // ───── 2차 풀 ─────
  // 정보형
  | 'thermometer'
  | 'radar'
  | 'colorForecast'
  | 'leaderboard'
  // 카드 조작형
  | 'destinyDraw'
  | 'locker'
  | 'blindDraw'
  | 'eitherOr'
  | 'lastFork'
  // 족보 변형형
  | 'doubleStep'
  | 'fourStraight'
  | 'parity'
  | 'pureBlood'
  | 'blackjack'
  // 경제/베팅형
  | 'modelTaxpayer'
  | 'taxOffice'
  | 'circuitBreaker'
  | 'bet'
  | 'lateBloomer'
  | 'totem'
  // 심리전형
  | 'showmanship'
  | 'rumor'
  // 방어/카운터형
  | 'traceback'
  | 'ironWall'
  | 'immunity'
  | 'padlock'
  // 공개형
  | 'bombPot'
  | 'blindDart'
  | 'getOut'
  | 'highCardDuel'
  | 'underdog'
  | 'restart'
  // ───── 3차 풀 ─────
  // 시야·시간
  | 'glasses'
  | 'heaven'
  // 보드·팟 구조
  | 'plusOne'
  | 'capitalism'
  | 'reverseRiver'
  | 'doubleBoard'
  | 'twoFates'
  | 'prophecy'
  | 'turnRiver'
  | 'highLow'
  | 'freeze'
  | 'magnet'
  | 'swapBoard'
  | 'lastStand'
  | 'sidePotBreaker'
  | 'drawOffer'
  // 제안·응답
  | 'pickMe'
  | 'jointTransfer'
  | 'loanShark'
  | 'infoAuction'
  | 'cardAuction'
  | 'truthGame'
  | 'staredown'
  | 'sealedContract'
  | 'nameIt'
  // 좌석·증강 흐름
  | 'comeBack'
  | 'runaway'
  | 'augShuffle'
  | 'lurk'
  | 'hunter'
  | 'loan'
  // 판정 공유·팀·탈취
  | 'destinyTeam'
  | 'parasite'
  | 'steal'
  | 'promotion'
  | 'alchemy'
  | 'publicHearing'
  // 확률·통계
  | 'recorder'
  | 'fateThread'
  // ═════ 4차 풀 ═════
  // 정보형
  | 'afterimage'
  | 'reviewNote'
  | 'smell'
  | 'suitCheck'
  | 'wiretap'
  | 'deadScanner'
  | 'ammoCheck'
  | 'blackBox'
  | 'link'
  | 'focus'
  // 카드 조작형
  | 'showcase'
  | 'envelope'
  | 'prepay'
  | 'coldStorage'
  | 'recycle'
  | 'pickpocket'
  // 족보 변형형
  | 'shadow'
  | 'numberMirror'
  | 'underdogCrown'
  | 'neighbors'
  | 'triplets'
  | 'omahaBlood'
  | 'royalty'
  | 'colorBlind'
  // 경제/베팅형
  | 'savings'
  | 'reserveOrder'
  | 'wanted'
  | 'nerveTest'
  | 'sideBet'
  | 'winBonus'
  | 'betCap'
  | 'smallPot'
  | 'regroup'
  | 'coHarvest'
  | 'revenge'
  | 'straw'
  | 'cataclysm'
  // 심리전형
  | 'smokeBomb'
  | 'bait'
  // 방어/카운터형
  | 'pokerFace'
  | 'selectiveReveal'
  | 'infoToll'
  | 'trap'
  // 공개형
  | 'indianPoker'
  | 'dealerWhim'
  | 'commonWell'
  | 'silentRiver'
  | 'truce'
  | 'sharedCard'
  | 'halfSecret'
  | 'oneMore'
  | 'switcheroo'
  | 'catchThief'
  | 'timeBomb'
  | 'lastChoice';

export type Stars = 1 | 2 | 3;

export type AugmentCategory = '정보형' | '카드 조작형' | '족보 변형형' | '경제/베팅형' | '심리전형' | '방어/카운터형' | '공개형';

/**
 * 발동 방식
 * - passive: 조건이 되면 자동
 * - button: 원할 때 버튼으로 선언 (시점 조건은 timing 참고)
 * - toggle: 켜 두면 조건이 될 때 자동 사용 (면제권) / 미리 준비 (위장)
 * - window: 정해진 선언 기회(플랍·턴·리버 공개 직후)에만
 * - call: 콜할 때 함께 선언 (무임승차)
 * - reaction: 다른 증강의 반응 대기 시간 중에만 (카운터 스펠, 면역, 탈취)
 * - prompt: 조건이 되면 나에게만 "발동할까요?" 선택이 뜬다 (무승부로 하지 않을래?)
 */
export type Trigger = 'passive' | 'button' | 'toggle' | 'window' | 'call' | 'reaction' | 'prompt';

/**
 * 공개 방식
 * - anonymous: 사용 시 "○○님이 비공개 증강을 사용했습니다" (이름 숨김)
 * - named: 사용(선언) 시 이름 공개
 * - onEffect: 패시브. 효과가 처음 드러나는 순간 공개
 * - never: 나만 아는 효과라 공개하지 않음
 * - secret: 누가 썼는지도 알리지 않는다 (소문: 익명 메시지만)
 */
export type Disclosure = 'anonymous' | 'named' | 'onEffect' | 'never' | 'secret';

export type TargetKind = 'opponentInHand' | 'opponent' | 'lastAggressor' | 'richerOpponent';

export interface AugmentDef {
  id: AugmentId;
  name: string;
  stars: Stars;
  category: AugmentCategory;
  description: string;
  trigger: Trigger;
  disclosure: Disclosure;
  /** 공개형: 선언 즉시 이름 공개, 테이블 전체에 영향 */
  public?: boolean;
  /** 사용 횟수 (null = 제한 없음) */
  uses: { count: number; per: 'game' | 'hand' } | null;
  /** 사용 가능 시점 안내 (버튼 툴팁) */
  timing: string;
  target?: TargetKind;
  /** 같은 그룹은 한 사람이 1개만 보유 (variant: 4장 플러시·징검다리·4장 스트레이트·짝수/홀수 동맹·보폭 두 배, revival: 불사의 토템·3일 안에 오리라) */
  group?: 'variant' | 'counter' | 'revival';
  /** 게임 전체에서 한 명만 가질 수 있는 유일 증강 */
  unique?: boolean;
  /** 탈취로 선언자를 바꿀 수 있는 증강 (다른 플레이어나 보드 카드를 지정) */
  stealable?: boolean;
  /** 지목형 (철벽으로 막을 수 있음) */
  targeted?: boolean;
  /** 1차 / 2차 / 3차 / 4차 풀 */
  pool?: 1 | 2 | 3 | 4;
  /** 함께 가질 수 없는 증강 (양방향으로 검사) */
  conflicts?: AugmentId[];
  /** 면역으로 피할 수 없는 공개형 (판 전체 규칙을 바꾸는 것) */
  tableWide?: boolean;
}

const D = (d: AugmentDef) => d;

export const AUGMENTS: Record<AugmentId, AugmentDef> = {
  // ───────── 정보형 ─────────
  observer: D({
    id: 'observer', name: '관찰자', stars: 1, category: '정보형', trigger: 'passive', disclosure: 'never', uses: null,
    description: '패시브. 쇼다운 없이 폴드한 상대의 홀카드를 핸드 종료 후 나만 본다.',
    timing: '핸드가 끝나면 자동',
  }),
  thermal: D({
    id: 'thermal', name: '열화상 카메라', stars: 1, category: '정보형', trigger: 'button', disclosure: 'anonymous',
    uses: { count: 3, per: 'game' }, target: 'opponentInHand',
    description: '게임 3회. 상대 1명의 홀카드 2장이 각각 하이(10~A)인지 로우(2~9)인지 나만 확인한다.',
    timing: '핸드 진행 중, 내가 핸드에 참여하고 있을 때',
  }),
  clairvoyance: D({
    id: 'clairvoyance', name: '투시', stars: 2, category: '정보형', trigger: 'button', disclosure: 'anonymous',
    uses: { count: 1, per: 'game' }, target: 'opponentInHand',
    description: '게임 1회. 상대 1명의 홀카드 중 무작위 1장을 나만 본다.',
    timing: '핸드 진행 중, 내가 핸드에 참여하고 있을 때',
  }),
  liedetector: D({
    id: 'liedetector', name: '거짓말 탐지기', stars: 2, category: '정보형', trigger: 'button', disclosure: 'anonymous',
    uses: { count: 2, per: 'game' }, target: 'lastAggressor',
    description: '게임 2회. 상대가 베팅·레이즈한 직후 사용. 그 상대의 최선 5장이 홀카드를 써서 원페어 이상(메이드 핸드)인지 아닌지만 나만 확인한다.',
    timing: '상대가 베팅·레이즈한 직후 (다음 행동 전)',
  }),
  counting: D({
    id: 'counting', name: '카운팅', stars: 2, category: '정보형', trigger: 'passive', disclosure: 'never', uses: null,
    description: '패시브. 이번 핸드에 사용된 카드(번 카드, 폴드한 홀카드, 버려진 카드)와 남은 카드 구성, 내 아웃츠와 리버까지의 완성 확률을 실시간으로 나만 본다.',
    timing: '항상 자동',
  }),
  foresight: D({
    id: 'foresight', name: '예지', stars: 3, category: '정보형', trigger: 'button', disclosure: 'anonymous',
    uses: { count: 2, per: 'game' },
    description: '게임 2회. 플랍 이후 다음에 나올 보드 카드 1장을 나만 미리 본다.',
    timing: '플랍 또는 턴이 공개된 뒤 (다음 카드가 나오기 전)',
  }),

  // ───────── 카드 조작형 ─────────
  mulligan: D({
    id: 'mulligan', name: '멀리건', stars: 1, category: '카드 조작형', trigger: 'button', disclosure: 'named',
    uses: { count: 1, per: 'hand' },
    description: '매 핸드 1회. 프리플랍에 내가 행동하기 전, 1BB를 팟에 내고 홀카드 1장을 교체한다.',
    timing: '프리플랍, 내가 행동하기 전 (칩이 BB보다 많을 때)',
  }),
  thirdHand: D({
    id: 'thirdHand', name: '세 번째 손', stars: 2, category: '카드 조작형', trigger: 'passive', disclosure: 'onEffect', uses: null,
    description: '패시브. 홀카드를 3장 받고, 플랍 공개 직후 1장을 버린다.',
    timing: '자동 (플랍 직후 버릴 카드 선택)',
  }),
  rewind: D({
    id: 'rewind', name: '되감기', stars: 2, category: '카드 조작형', trigger: 'window', disclosure: 'named',
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 턴이나 리버 공개 직후 베팅 전에 선언. 그 카드를 버리고 새로 1장을 깐다. 모든 플레이어에게 적용.',
    timing: '턴·리버 공개 직후 선언 기회에',
  }),
  attachment: D({
    id: 'attachment', name: '애착', stars: 2, category: '카드 조작형', trigger: 'passive', disclosure: 'never', uses: null,
    description: '패시브. 쇼다운에서 이기면 홀카드 1장을 골라 다음 핸드에 그대로 가져가고, 나머지만 새로 받는다.',
    timing: '쇼다운에서 이긴 뒤 자동 (가져갈 카드 선택)',
  }),
  seal: D({
    id: 'seal', name: '봉인', stars: 3, category: '카드 조작형', trigger: 'window', disclosure: 'named', stealable: true,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 리버 공개 후 보드 카드 1장을 지정해, 이번 핸드에서 모든 플레이어의 족보 계산에서 제외한다.',
    timing: '리버 공개 직후 선언 기회에',
  }),

  // ───────── 족보 변형형 ─────────
  wrapStraight: D({
    id: 'wrapStraight', name: '원형 스트레이트', stars: 1, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null,
    description: '나에게만 적용. A를 넘어 이어지는 스트레이트(예: Q-K-A-2-3)도 인정. 최고 숫자는 연결의 끝 카드(이 예에서는 3)로 비교.',
    timing: '쇼다운에서 자동',
  }),
  kickerMaster: D({
    id: 'kickerMaster', name: '키커 장인', stars: 1, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null,
    description: '나에게만 적용. 족보와 키커까지 완전히 같아 스플릿될 상황이면 내가 이긴다.',
    timing: '쇼다운에서 자동',
  }),
  fourFlush: D({
    id: 'fourFlush', name: '4장 플러시', stars: 2, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null,
    group: 'variant',
    description: '나에게만 적용. 같은 무늬 4장도 플러시로 인정. 5장 플러시보다는 낮고, 4장 플러시끼리는 높은 카드 순으로 비교.',
    timing: '쇼다운에서 자동',
  }),
  gapStraight: D({
    id: 'gapStraight', name: '징검다리', stars: 2, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null,
    group: 'variant',
    description: '나에게만 적용. 숫자 하나가 비어 있는 스트레이트(예: 5-6-8-9-10)도 인정. 최고 숫자가 같으면 일반 스트레이트가 더 높음.',
    timing: '쇼다운에서 자동',
  }),
  absoluteKicker: D({
    id: 'absoluteKicker', name: '절대 키커', stars: 2, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null,
    description: '나에게만 적용. 쇼다운에서 같은 숫자의 같은 족보로 맞붙으면 키커와 상관없이 내가 이긴다. 보드 5장만으로 완성된 완전 동점은 스플릿.',
    timing: '쇼다운에서 자동',
  }),
  favoritism: D({
    id: 'favoritism', name: '편애', stars: 3, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null,
    description: '나에게만 적용. 고를 때 숫자 하나(2~A)가 무작위로 정해져 나에게만 보이고, 그 숫자 카드는 와일드카드로 취급한다.',
    timing: '쇼다운에서 자동',
  }),

  // ───────── 경제/베팅형 ─────────
  insurance: D({
    id: 'insurance', name: '보험', stars: 1, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', uses: null,
    description: '패시브. 플랍 이후에 폴드하면 이번 핸드에 자신이 낸 칩의 25%를 팟에서 돌려받는다.',
    timing: '플랍 이후 폴드하면 자동',
  }),
  exemption: D({
    id: 'exemption', name: '면제권', stars: 1, category: '경제/베팅형', trigger: 'toggle', disclosure: 'named',
    uses: { count: 3, per: 'game' },
    description: '게임 3회. 켜 두면 내 차례의 블라인드를 내지 않는다.',
    timing: '언제든 켜고 끌 수 있음 (블라인드 차례에 자동 사용)',
  }),
  highRisk: D({
    id: 'highRisk', name: '하이리스크', stars: 2, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', uses: null,
    description: '패시브. 올인해서 이기면 팟의 20%를 은행에서 추가로 받고, 지면 다음 증강 선택 기회를 1번 잃는다.',
    timing: '올인한 핸드가 끝나면 자동',
  }),
  freeRide: D({
    id: 'freeRide', name: '무임승차', stars: 2, category: '경제/베팅형', trigger: 'call', disclosure: 'named',
    uses: { count: 2, per: 'game' },
    description: '게임 2회. 레이즈나 올인에 콜할 때 발동. 콜 금액의 50%만 내고 그만큼 콜한 것으로 처리한다. 상대가 낸 초과분은 상대에게 돌아간다.',
    timing: '내 차례에 레이즈·올인을 마주했을 때 (콜 대신)',
  }),
  enforcement: D({
    id: 'enforcement', name: '강제 집행', stars: 3, category: '경제/베팅형', trigger: 'button', disclosure: 'named',
    uses: { count: 1, per: 'game' }, target: 'richerOpponent', targeted: true, stealable: true,
    description: '게임 1회. 리버 베팅 라운드에서 내가 올인했을 때 선언. 나보다 칩이 많은 상대 1명을 지목하면 그 상대는 폴드할 수 없고 콜해야 한다.',
    timing: '리버에서 내가 올인한 뒤, 지목할 상대가 아직 응답하기 전',
  }),

  // ───────── 심리전형 ─────────
  disguise: D({
    id: 'disguise', name: '위장', stars: 1, category: '심리전형', trigger: 'toggle', disclosure: 'never',
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 다음에 이름이 공개되는 내 증강을, 내가 고른 가짜 증강 이름으로 표시한다.',
    timing: '언제든 준비 (다음 이름 공개 때 자동 적용)',
  }),
  inquiry: D({
    id: 'inquiry', name: '탐문', stars: 1, category: '심리전형', trigger: 'button', disclosure: 'anonymous',
    uses: { count: 2, per: 'game' }, target: 'opponent',
    description: '게임 2회. 상대 1명을 지정해 그 플레이어가 가진 증강들의 별 개수만 확인한다.',
    timing: '게임 중 언제든',
  }),
  blank: D({
    id: 'blank', name: '공포탄', stars: 1, category: '심리전형', trigger: 'button', disclosure: 'anonymous',
    uses: { count: 2, per: 'game' },
    description: '게임 2회. 다른 액티브 증강을 보유했을 때만 사용 가능. 진짜와 똑같은 "비공개 증강 사용" 알림만 띄우고 실제 효과는 없다.',
    timing: '게임 중 언제든 (다른 액티브 증강 보유 시)',
  }),
  shepherd: D({
    id: 'shepherd', name: '양치기 소년', stars: 2, category: '심리전형', trigger: 'button', disclosure: 'named',
    uses: { count: 1, per: 'hand' },
    description: '매 핸드 1회, 플랍 이후 베팅 라운드에서 내 홀카드 1장을 공개. 게임 1회는 가짜 카드로 바꿔 공개할 수 있다. 쇼다운에서 거짓이 드러나면 함께 간 상대들에게 2BB를 나눠 준다.',
    timing: '플랍 이후 베팅 라운드, 핸드에 참여 중일 때',
  }),

  // ───────── 방어/카운터형 (한 사람당 1개) ─────────
  disinfo: D({
    id: 'disinfo', name: '역정보', stars: 1, category: '방어/카운터형', trigger: 'passive', disclosure: 'never',
    uses: { count: 1, per: 'game' }, group: 'counter',
    description: '게임 1회, 자동. 내 카드나 패 상태가 처음으로 정보형 증강(투시, 열화상 카메라, 거짓말 탐지기)에 노출될 때 가짜 결과를 보여 준다.',
    timing: '자동',
  }),
  vest: D({
    id: 'vest', name: '방탄조끼', stars: 1, category: '방어/카운터형', trigger: 'passive', disclosure: 'onEffect',
    uses: { count: 1, per: 'game' }, group: 'counter',
    description: '패시브, 1회, 자동. 다른 사람의 증강이 나를 강제 폴드시키거나 내 카드를 교환·폐기할 때 막는다 (러시안 룰렛, 너 나가).',
    timing: '자동',
  }),
  mirror: D({
    id: 'mirror', name: '거울', stars: 2, category: '방어/카운터형', trigger: 'passive', disclosure: 'never', uses: null,
    group: 'counter',
    description: '패시브. 누군가 정보형 증강으로 내 정보를 보면 알림을 받고, 그 사람의 같은 종류 정보를 나도 본다.',
    timing: '자동',
  }),
  counterSpell: D({
    id: 'counterSpell', name: '카운터 스펠', stars: 3, category: '방어/카운터형', trigger: 'reaction', disclosure: 'named',
    uses: { count: 1, per: 'game' }, group: 'counter',
    description: '게임 1회. 반응 대기 시간 중 사용. 다른 플레이어가 선언한 액티브·공개형 증강을 무효화하고, 그 사람의 사용 횟수는 소모된다. 카운터 스펠 자체는 무효화할 수 없다.',
    timing: '다른 사람의 증강 반응 대기(3초) 중',
  }),

  // ───────── 공개형 (게임 1회, 선언 즉시 이름 공개) ─────────
  blackout: D({
    id: 'blackout', name: '암전', stars: 1, category: '공개형', trigger: 'button', disclosure: 'named', public: true,
    uses: { count: 1, per: 'game' },
    description: '카드를 나눠 주기 전에만 선언. 선언자를 포함한 전원이 자기 홀카드를 보지 못한 채 진행하고 쇼다운 때 공개. 멀리건은 무작위 1장 교체, 세 번째 손은 무작위 1장 버리기.',
    timing: '핸드 사이 (결과 화면·증강 선택 중, 다음 핸드 배분 전)',
  }),
  glassTable: D({
    id: 'glassTable', name: '유리 테이블', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true,
    uses: { count: 1, per: 'game' },
    description: '선언자를 포함한 전원의 홀카드를 공개한 채 이번 핸드를 진행한다.',
    timing: '핸드 진행 중',
  }),
  russianRoulette: D({
    id: 'russianRoulette', name: '러시안 룰렛', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true,
    uses: { count: 1, per: 'game' },
    description: '3명 이상 남아 있을 때만 선언. 선언자를 포함해 남은 플레이어 중 무작위 1명이 강제 폴드 (낸 칩은 팟에 남음).',
    timing: '핸드 진행 중, 폴드하지 않은 사람이 3명 이상일 때',
  }),
  flipTable: D({
    id: 'flipTable', name: '밥상 뒤집기', stars: 3, category: '공개형', trigger: 'window', disclosure: 'named', public: true,
    uses: { count: 1, per: 'game' },
    tableWide: true,
    description: '리버 공개 후, 리버 베팅 전에 선언. 이번 핸드는 족보가 역전되어 가장 낮은 패가 승리한다.',
    timing: '리버 공개 직후 선언 기회에',
  }),
  heavyFog: D({
    id: 'heavyFog', name: '짙은 안개', stars: 3, category: '공개형', trigger: 'button', disclosure: 'named', public: true, stealable: true,
    uses: { count: 1, per: 'game' },
    description: '플랍이 깔리기 전 선언. 플랍 3장은 선언자만 보고, 다른 플레이어에게는 쇼다운 때 공개. 족보 판정에는 정상 반영.',
    timing: '프리플랍 (플랍이 깔리기 전)',
  }),
  deathTax: D({
    id: 'deathTax', name: '죽음과 세금', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 2,
    uses: { count: 1, per: 'game' },
    description: '선언한 순간부터 게임이 끝날 때까지, 선언자를 제외한 모든 플레이어는 액티브·공개형 증강을 쓸 때마다 은행에 1BB를 낸다 (패시브·자동 발동 제외, 공포탄도 납부). 두 명이 선언하면 2BB이고 각자 자기 세금만 면제. 낼 칩이 없으면 그 증강을 쓸 수 없다.',
    timing: '게임 중 언제든',
  }),

  // ═════════════════════════ 2차 풀 ═════════════════════════

  // ───────── 정보형 ─────────
  thermometer: D({
    id: 'thermometer', name: '온도계', stars: 2, category: '정보형', trigger: 'button', disclosure: 'anonymous', pool: 2,
    uses: { count: 1, per: 'hand' }, target: 'opponentInHand',
    description: '매 핸드 1회. 상대 1명의 홀카드 숫자 합이 15 이상인지 미만인지 나만 확인한다 (J=11, Q=12, K=13, A=14).',
    timing: '핸드 진행 중, 내가 핸드에 참여하고 있을 때',
  }),
  radar: D({
    id: 'radar', name: '레이더', stars: 2, category: '정보형', trigger: 'button', disclosure: 'anonymous', pool: 2,
    uses: { count: 3, per: 'game' },
    description: '게임 3회. 보드 카드 1장을 지정하면, 나를 제외하고 그 숫자와 같은 숫자의 홀카드를 가진 플레이어 수를 나만 확인한다 (누구인지는 모름).',
    timing: '플랍 이후, 내가 핸드에 참여하고 있을 때',
  }),
  colorForecast: D({
    id: 'colorForecast', name: '색채 예보', stars: 2, category: '정보형', trigger: 'button', disclosure: 'anonymous', pool: 2,
    uses: { count: 2, per: 'game' },
    description: '게임 2회. 플랍 또는 턴의 내 행동 직전에 다음 보드 카드의 무늬만 나만 확인한다. 이후 되감기 등으로 카드가 바뀌면 결과가 달라질 수 있다.',
    timing: '플랍·턴 베팅 라운드에서 내 차례 (행동 전)',
  }),
  leaderboard: D({
    id: 'leaderboard', name: '순위표', stars: 3, category: '정보형', trigger: 'button', disclosure: 'anonymous', pool: 2,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 턴이 공개된 이후, 핸드에 남은 플레이어 중 현재 보드 기준(증강 효과 반영)으로 내 패가 몇 등인지만 나만 확인한다. 동점은 같은 등수.',
    timing: '턴 공개 이후, 내가 핸드에 참여하고 있을 때',
  }),

  // ───────── 카드 조작형 ─────────
  destinyDraw: D({
    id: 'destinyDraw', name: '데스티니 드로우', stars: 2, category: '카드 조작형', trigger: 'button', disclosure: 'named', pool: 2,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 카드를 나눠 받기 전에 선언하고, 덱에서 원하는 카드 1장을 골라 홀카드로 받는다 (나머지는 무작위). 다른 사람이 애착·보관함으로 가져온 카드는 고를 수 없다. 고른 카드는 나만 안다.',
    timing: '핸드 사이 (다음 핸드 배분 전)',
  }),
  locker: D({
    id: 'locker', name: '보관함', stars: 2, category: '카드 조작형', trigger: 'passive', disclosure: 'never', uses: null, pool: 2,
    description: '패시브. 폴드할 때 홀카드 1장을 보관했다가, 다음 핸드 프리플랍에 홀카드 1장과 바꿀 수 있다. 바꾸지 않으면 사라진다. 보관 중인 카드는 다음 핸드 덱에서 제외.',
    timing: '폴드한 핸드가 끝날 때 보관할 카드 선택 → 다음 핸드 프리플랍에 교체',
  }),
  blindDraw: D({
    id: 'blindDraw', name: '블라인드 드로우', stars: 2, category: '카드 조작형', trigger: 'button', disclosure: 'named', pool: 2,
    uses: { count: 3, per: 'game' },
    description: '게임 3회. 턴 공개 후 내 홀카드 1장을 버리고 덱 맨 위 카드로 교체한다. 새 카드는 나만 본다.',
    timing: '턴 공개 이후 베팅 라운드, 내가 핸드에 참여하고 있을 때',
  }),
  eitherOr: D({
    id: 'eitherOr', name: '양자택일', stars: 3, category: '카드 조작형', trigger: 'window', disclosure: 'named', pool: 2, stealable: true,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 플랍 공개 직후 턴 카드 후보 2장을 나만 보고 하나를 고른다. 고른 카드가 턴에 공개되고 나머지는 버린다. 사용 사실은 모두에게 표시.',
    timing: '플랍 공개 직후 선언 기회에',
  }),
  lastFork: D({
    id: 'lastFork', name: '마지막 갈림길', stars: 3, category: '카드 조작형', trigger: 'window', disclosure: 'named', pool: 2,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 리버 공개 후 베팅 전에 내 홀카드 1장을 공개하고 버린 뒤 새 카드 1장을 받는다. 새 카드는 나만 보며, 사용 사실과 버린 카드는 공개.',
    timing: '리버 공개 직후 선언 기회에',
  }),

  // ───────── 족보 변형형 ─────────
  doubleStep: D({
    id: 'doubleStep', name: '보폭 두 배', stars: 1, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 2,
    group: 'variant',
    description: '나에게만 적용. 숫자가 정확히 2씩 증가하는 5장(예: 2-4-6-8-10)도 스트레이트로 인정. A는 1로만 쓰고 최고 숫자로 비교, 같으면 일반 스트레이트가 높다. 스트레이트 플러시에는 적용하지 않는다.',
    timing: '쇼다운에서 자동',
  }),
  fourStraight: D({
    id: 'fourStraight', name: '4장 스트레이트', stars: 2, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 2,
    group: 'variant',
    description: '나에게만 적용. 연속된 숫자 4장과 다른 카드 1장으로 스트레이트를 만든다. 연속된 4장의 최고 숫자로 비교하고, 같으면 일반 스트레이트가 높다. 스트레이트 플러시에는 적용하지 않는다.',
    timing: '쇼다운에서 자동',
  }),
  parity: D({
    id: 'parity', name: '짝수/홀수 동맹', stars: 2, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 2,
    group: 'variant',
    description: '나에게만 적용. 획득할 때 짝수(2·4·6·8·10·Q) 또는 홀수(3·5·7·9·J·K)를 고른다. 5장이 모두 고른 쪽 숫자면 "동맹 플러시"(A 제외). 일반 플러시와 같은 등급, 높은 카드 순 비교, 완전히 같으면 일반 플러시가 높다.',
    timing: '쇼다운에서 자동',
  }),
  pureBlood: D({
    id: 'pureBlood', name: '순혈', stars: 3, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 2,
    description: '나에게만 적용. 최종 족보에 홀카드 2장이 모두 쓰였으면, 같은 족보 종류끼리 비교할 때 숫자와 상관없이 내가 이긴다 (예: 포켓 33 원페어가 KK 원페어를 이김). 상대도 순혈 조건을 만족하면 원래 비교.',
    timing: '쇼다운에서 자동',
  }),
  blackjack: D({
    id: 'blackjack', name: '블랙잭', stars: 3, category: '족보 변형형', trigger: 'window', disclosure: 'anonymous', pool: 2,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 리버 베팅 전에 비공개로 발동. 7장 중 5장의 숫자 합(J·Q·K=10, A=1 또는 11)이 정확히 21이면 가장 낮은 풀하우스와 동급. 원래 족보가 더 높으면 원래 족보를 쓰고, 블랙잭끼리는 스플릿.',
    timing: '리버 공개 직후 선언 기회에 (21을 만들 수 있을 때)',
  }),

  // ───────── 경제/베팅형 ─────────
  modelTaxpayer: D({
    id: 'modelTaxpayer', name: '모범납세자', stars: 1, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 2,
    description: '패시브. 블라인드(SB 또는 BB)를 4번 낼 때마다 다음에 돌아오는 블라인드 1번을 면제받는다. 면제된 블라인드는 아무도 내지 않고 최소 베팅 단위는 BB 그대로.',
    timing: '블라인드 차례에 자동',
  }),
  taxOffice: D({
    id: 'taxOffice', name: '세무서', stars: 1, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 2,
    description: '패시브. 다른 플레이어가 공개형 증강을 선언할 때마다 그 사람이 나에게 1BB를 낸다 (모자라면 있는 만큼).',
    timing: '자동',
  }),
  circuitBreaker: D({
    id: 'circuitBreaker', name: '서킷브레이커', stars: 2, category: '경제/베팅형', trigger: 'button', disclosure: 'named', pool: 2,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 한 베팅 라운드에서 레이즈(올인 포함)가 3번 이상 나온 뒤 내 차례에 선언. 이번 라운드에 낸 칩을 모두 돌려주고 라운드 첫 행동자부터 다시 시작하며, 다시 시작한 라운드에서는 레이즈를 1번만 허용한다.',
    timing: '레이즈가 3번 이상 나온 베팅 라운드의 내 차례',
  }),
  bet: D({
    id: 'bet', name: '내기할래?', stars: 2, category: '경제/베팅형', trigger: 'button', disclosure: 'anonymous', pool: 2,
    uses: { count: 1, per: 'hand' },
    description: '매 핸드 1회. 프리플랍 내 첫 행동 전에 이번 핸드의 우승 족보 종류를 비공개로 예측한다. 쇼다운까지 가서 졌는데 예측이 맞았다면, 이번 핸드에 낸 칩의 50%를 팟에서 돌려받는다.',
    timing: '프리플랍, 내 첫 행동 전',
  }),
  lateBloomer: D({
    id: 'lateBloomer', name: '왕귀', stars: 2, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 2,
    description: '패시브. 쇼다운에서 팟을 전혀 받지 못하고 진 횟수가 3번 쌓인 뒤 처음으로 팟을 이기면, 그 팟의 50%(최대 20BB)를 추가로 받는다. 이 칩은 나를 뺀 남은 플레이어가 똑같이 나눠 낸다. 발동하면 횟수는 0으로.',
    timing: '자동',
  }),
  totem: D({
    id: 'totem', name: '불사의 토템', stars: 2, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', pool: 2, group: 'revival',
    uses: { count: 1, per: 'game' },
    description: '게임 1회, 자동. 쇼다운에서 올인으로 칩을 모두 잃으면 탈락하지 않고, 승자의 몫에서 10BB를 남겨 받은 채 계속한다.',
    timing: '자동',
  }),

  // ───────── 심리전형 ─────────
  showmanship: D({
    id: 'showmanship', name: '쇼맨십', stars: 1, category: '심리전형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 2,
    description: '패시브. 상대 전원이 폴드해 쇼다운 없이 이겼을 때 홀카드 2장을 자진 공개하면, 마지막으로 폴드한 상대에게서 1BB를 받는다. 공개한 패가 하이카드(블러프)였다면 2BB.',
    timing: '쇼다운 없이 이긴 핸드가 끝날 때 (공개 여부 선택)',
  }),
  rumor: D({
    id: 'rumor', name: '소문', stars: 1, category: '심리전형', trigger: 'button', disclosure: 'secret', pool: 2,
    uses: { count: 2, per: 'game' },
    description: '게임 2회. "이 테이블 누군가 ○○ 증강을 가지고 있다"는 메시지를 익명으로 띄운다. ○○는 자유롭게 고르며, 진짜인지는 확인하지 않는다.',
    timing: '게임 중 언제든',
  }),

  // ───────── 방어/카운터형 (한 사람당 1개) ─────────
  traceback: D({
    id: 'traceback', name: '역추적', stars: 1, category: '방어/카운터형', trigger: 'passive', disclosure: 'never', uses: null, pool: 2,
    group: 'counter',
    description: '패시브. 나에게 정보형 증강(투시, 열화상 카메라, 거짓말 탐지기, 온도계)이 쓰이면 누가 무엇을 썼는지 알림을 받는다. 효과는 막지 못한다.',
    timing: '자동',
  }),
  ironWall: D({
    id: 'ironWall', name: '철벽', stars: 1, category: '방어/카운터형', trigger: 'button', disclosure: 'named', pool: 2,
    uses: { count: 2, per: 'game' }, group: 'counter',
    description: '게임 2회. 핸드 시작 시 선언. 이번 핸드 동안 나는 지목형 증강(강제 집행, 실명 다트, 너 나가)의 대상이 될 수 없다.',
    timing: '프리플랍, 내 첫 행동 전',
  }),
  immunity: D({
    id: 'immunity', name: '면역', stars: 2, category: '방어/카운터형', trigger: 'reaction', disclosure: 'named', pool: 2,
    uses: { count: 1, per: 'game' }, group: 'counter',
    description: '게임 1회. 공개형 증강의 반응 대기 중에 사용하면 나만 그 효과에서 빠진다 (암전·유리 테이블·러시안 룰렛·짙은 안개·실명 다트·너 나가·죽음과 세금·배수진·증강 셔플·운명 공동체·메이드 인 헤븐·안경 없어서 잘 안보여). 판 전체 규칙이나 보드·팟 구조를 바꾸는 공개형과 경매에는 쓸 수 없다.',
    timing: '다른 사람의 공개형 증강 반응 대기(3초) 중',
  }),
  padlock: D({
    id: 'padlock', name: '자물쇠', stars: 2, category: '방어/카운터형', trigger: 'button', disclosure: 'named', pool: 2,
    uses: { count: 1, per: 'game' }, group: 'counter',
    description: '게임 1회. 베팅 라운드 시작 시(아무도 행동하기 전) 선언. 이번 베팅 라운드 동안 나를 포함한 모든 플레이어는 액티브·공개형 증강을 쓸 수 없다 (카운터 스펠 포함). 패시브·자동 발동은 그대로.',
    timing: '베팅 라운드가 시작되고 아무도 행동하기 전',
  }),

  // ───────── 공개형 (게임 1회) ─────────
  bombPot: D({
    id: 'bombPot', name: '폭탄 팟', stars: 1, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 2,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '카드를 나누기 전 선언. 다음 핸드는 블라인드 대신 전원이 3BB를 내고, 프리플랍 베팅 없이 바로 플랍을 공개한 뒤 첫 베팅을 시작한다. 3BB가 없으면 있는 만큼 내고 올인.',
    timing: '핸드 사이 (다음 핸드 배분 전)',
  }),
  blindDart: D({
    id: 'blindDart', name: '실명 다트', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 2,
    uses: { count: 1, per: 'game' }, target: 'opponentInHand', targeted: true, stealable: true,
    description: '플랍 전 프리플랍 베팅 중 내 차례에 선언. 상대 1명을 지목하면 그 상대는 이번 핸드 동안 보드를 볼 수 없고 자기 홀카드만 보며 플레이한다 (쇼다운 때 공개). 지목형.',
    timing: '프리플랍 베팅 중 내 차례',
  }),
  getOut: D({
    id: 'getOut', name: '너 나가', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 2,
    uses: { count: 1, per: 'game' }, target: 'opponentInHand', targeted: true, stealable: true,
    description: '플랍 전 프리플랍 베팅 중 내 차례에 선언 (핸드에 3명 이상일 때). 상대 1명을 지목하면 이번 핸드에서 강제로 폴드한다 (낸 칩은 팟에). 지목형, 강제 폴드.',
    timing: '프리플랍 베팅 중 내 차례 (핸드에 3명 이상)',
  }),
  highCardDuel: D({
    id: 'highCardDuel', name: '하이카드', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 2,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '프리플랍 베팅 중 내 차례에 선언. 이번 핸드를 무효화하고, 남은 플레이어 중 홀카드 1장이 가장 높은 사람이 팟을 가져간다 (A 최고, 동점은 분배, 와일드 미적용).',
    timing: '프리플랍 베팅 중 내 차례',
  }),
  underdog: D({
    id: 'underdog', name: '언더독', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 2,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '카드를 나눠 주기 전에만 선언. 다음 핸드부터 3핸드 동안 족보 순위가 뒤바뀌어 가장 낮은 패가 승리한다. 밥상 뒤집기와 겹치면 상쇄.',
    timing: '핸드 사이 (다음 핸드 배분 전)',
  }),
  restart: D({
    id: 'restart', name: '나 다시 돌아갈래', stars: 3, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 2,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '쇼다운 전 내 차례에 선언. 블라인드를 뺀 이번 핸드의 베팅을 모두 돌려주고 같은 버튼·블라인드로 새 덱을 섞어 프리플랍부터 다시 시작한다. 선언자는 돌려받을 칩의 50%를 은행에 낸다. 다시 시작한 핸드에서는 누구도 이 증강을 쓸 수 없다.',
    timing: '쇼다운 전, 베팅 중 내 차례',
  }),

  // ═════════════════════════ 3차 풀 ═════════════════════════

  // ───────── 시야·시간 제어 ─────────
  glasses: D({
    id: 'glasses', name: '안경 없어서 잘 안보여', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 3,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 프리플랍 베팅 전에 선언. 이번 핸드 동안 선언자를 뺀 모두에게 보드 카드의 무늬를 숨기고 숫자만 보이며, 다른 사람의 칩·베팅 금액은 대략값(BB 단위)으로 보인다. 현재 족보 표시와 카운팅도 숨긴다. 쇼다운 결과는 또렷하게 공개.',
    timing: '프리플랍, 아무도 행동하기 전',
  }),
  heaven: D({
    id: 'heaven', name: '메이드 인 헤븐', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 3,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 선언한 다음 핸드부터 선언자를 뺀 모두의 행동 제한 시간이 매 핸드 5초씩 줄어든다 (최소 5초). 다음 블라인드 레벨이 시작되면 원래 시간으로. 두 명이 선언하면 감소량이 합쳐지고 각자 자기 효과에서만 빠진다.',
    timing: '게임 중 언제든',
  }),

  // ───────── 보드·팟 구조 ─────────
  plusOne: D({
    id: 'plusOne', name: '플러스 원', stars: 2, category: '카드 조작형', trigger: 'window', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 리버 공개 후 베팅 전에 선언. 6번째 보드 카드를 1장 더 공개하고, 모두 보드 6장과 홀카드 중 최선의 5장으로 판정한다.',
    timing: '리버 공개 직후 선언 기회에',
  }),
  capitalism: D({
    id: 'capitalism', name: '자본주의', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 3,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '플랍 공개 후 선언. 이번 핸드의 플랍·턴 베팅 라운드가 끝날 때마다 그 라운드에서 가장 크게 베팅·레이즈한 사람이 보드 카드를 1장 더 깔지 정한다 (보드 최대 7장, 추가 카드는 다음 카드보다 먼저 공개).',
    timing: '플랍 베팅 라운드 중',
  }),
  reverseRiver: D({
    id: 'reverseRiver', name: '거꾸로 강을 거슬러', stars: 1, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 3,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '카드를 나누기 전 선언. 다음 핸드의 보드가 1장 → 1장 → 3장 순서로 공개된다. 베팅 라운드 수는 같다.',
    timing: '핸드 사이 (다음 핸드 배분 전)',
  }),
  doubleBoard: D({
    id: 'doubleBoard', name: '더블 보드', stars: 1, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 3,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '플랍이 깔리기 전 선언. 보드를 2세트 깔고, 각 보드의 승자가 팟을 절반씩 나눈다.',
    timing: '프리플랍 (플랍이 깔리기 전)',
  }),
  twoFates: D({
    id: 'twoFates', name: '두 번의 운명', stars: 1, category: '공개형', trigger: 'window', disclosure: 'named', public: true, pool: 3,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '턴까지 남은 플레이어가 모두 올인해 추가 베팅이 불가능할 때 선언. 리버를 두 번 따로 뽑아 각 결과에 팟의 절반을 배정한다.',
    timing: '턴 공개 직후, 더 베팅할 수 없을 때',
  }),
  prophecy: D({
    id: 'prophecy', name: '미리 온 결말', stars: 1, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 3,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '카드를 나누기 전 선언. 다음 핸드 시작 때 덱에서 1장을 공개해 그 핸드의 리버로 예약한다.',
    timing: '핸드 사이 (다음 핸드 배분 전)',
  }),
  turnRiver: D({
    id: 'turnRiver', name: '턴과 리버 사이', stars: 3, category: '카드 조작형', trigger: 'window', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' }, stealable: true,
    description: '게임 1회. 플랍 직후 턴·리버로 나올 두 카드를 나만 미리 보고 공개 순서를 정한다. 두 카드는 그대로 확정. 사용 사실은 공개, 본 카드는 비공개.',
    timing: '플랍 공개 직후 선언 기회에',
  }),
  highLow: D({
    id: 'highLow', name: '하이로우', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 3,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '플랍 전 선언. 이번 팟을 가장 높은 패와 가장 낮은 패(역전 순위)가 반씩 나눈다. 한 사람이 양쪽을 모두 가져갈 수 있다.',
    timing: '프리플랍 (플랍이 깔리기 전)',
  }),
  freeze: D({
    id: 'freeze', name: '동결', stars: 1, category: '카드 조작형', trigger: 'button', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' }, stealable: true,
    description: '게임 1회. 핸드가 끝날 때 이번 보드 카드 1장을 지정하면 다음 핸드 플랍에 그 카드가 반드시 포함된다. 지정 카드는 모두에게 공개.',
    timing: '핸드 결과 화면 (공개된 보드 카드 지정)',
  }),
  magnet: D({
    id: 'magnet', name: '자석', stars: 2, category: '카드 조작형', trigger: 'button', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 플랍 후 무늬 하나를 공개 지정한다. 턴과 리버 중 그 무늬가 아닌 카드가 처음 나오면 버리고 다시 1장을 뽑는다 (다시 뽑은 카드는 확정).',
    timing: '플랍 베팅 라운드 중',
  }),
  swapBoard: D({
    id: 'swapBoard', name: '맞바꾸기', stars: 3, category: '카드 조작형', trigger: 'button', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 턴 공개 후 내 홀카드 1장과 보드 카드 1장을 바꾼다. 교체 내용은 모두에게 공개.',
    timing: '턴 공개 이후 베팅 라운드',
  }),
  lastStand: D({
    id: 'lastStand', name: '배수진', stars: 3, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 3,
    uses: { count: 1, per: 'game' },
    description: '프리플랍 내 행동 전 선언. 이번 핸드 동안 모두 폴드할 수 없고 레이즈도 금지 (체크·콜만 가능).',
    timing: '프리플랍, 내 첫 행동 전',
  }),
  sidePotBreaker: D({
    id: 'sidePotBreaker', name: '사이드 팟 브레이커', stars: 2, category: '경제/베팅형', trigger: 'button', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 내 올인으로 사이드팟이 생긴 핸드에서 메인 팟을 이겼을 때 선언. 다른 플레이어들끼리 쌓은 사이드팟의 30%를 가져온다.',
    timing: '핸드 결과 화면 (올인해서 메인 팟을 이겼을 때)',
  }),
  drawOffer: D({
    id: 'drawOffer', name: '무승부로 하지 않을래?', stars: 2, category: '경제/베팅형', trigger: 'prompt', disclosure: 'named', pool: 3,
    uses: { count: 3, per: 'game' },
    description: '게임 3회. 쇼다운에서 나를 이긴 승자의 족보 종류가 내 족보 종류와 같으면 결과 직후 "무승부를 제안할까요?"가 나에게만 뜬다. 발동하면 그 승자와 나 둘이서 그 팟을 반씩 나눈다. 승자가 동점 처리 증강을 가졌다면 상쇄되어 발동할 수 없다.',
    timing: '쇼다운 결과 직후 (조건이 되면 선택 창)',
  }),

  // ───────── 제안·응답 ─────────
  pickMe: D({
    id: 'pickMe', name: '골라 봐', stars: 1, category: '심리전형', trigger: 'button', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' }, target: 'opponentInHand',
    description: '게임 1회. 플랍 또는 턴의 내 행동 직전 상대 1명에게 제안한다. 수락하면 그 상대가 나에게 3BB를 내고, 내가 고른 홀카드 1장을 그 상대만 본다.',
    timing: '플랍·턴 베팅 라운드의 내 차례 (행동 전)',
  }),
  jointTransfer: D({
    id: 'jointTransfer', name: '공동 환승', stars: 1, category: '카드 조작형', trigger: 'window', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' }, target: 'opponentInHand',
    description: '게임 1회. 플랍 직후 상대 1명에게 교환을 제안한다. 수락하면 각자 홀카드 1장을 비공개로 골라 동시에 맞바꾼다 (두 사람에게만 보임).',
    timing: '플랍 공개 직후 선언 기회에',
  }),
  loanShark: D({
    id: 'loanShark', name: '사채업자', stars: 1, category: '경제/베팅형', trigger: 'button', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' }, target: 'opponent',
    description: '게임 1회. 상대 1명에게 5BB를 빌려주겠다고 제안한다. 수락하면 2핸드 뒤 7BB를 자동으로 돌려받는다 (모자라면 있는 만큼). 상대가 그전에 탈락·추방되면 빌려준 칩은 사라진다.',
    timing: '게임 중 언제든',
  }),
  infoAuction: D({
    id: 'infoAuction', name: '정보 경매', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 3,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '플랍 후 선언. 턴 카드를 미리 볼 권리를 남은 플레이어 전원이 비공개로 입찰한다 (0 = 참여 안 함, 최소 1BB). 최고 입찰자만 턴 카드를 보고 낙찰금은 팟에. 낙찰자와 낙찰금만 공개.',
    timing: '플랍 베팅 라운드 중',
  }),
  cardAuction: D({
    id: 'cardAuction', name: '카드 경매', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 3,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '플랍 후 선언. 덱에서 1장을 공개하고 남은 플레이어 전원이 비공개로 입찰한다 (최소 1BB). 최고 입찰자가 그 카드를 홀카드 1장과 바꾸고 (버린 카드는 비공개) 낙찰금은 팟에.',
    timing: '플랍 베팅 라운드 중',
  }),
  truthGame: D({
    id: 'truthGame', name: '진실 게임', stars: 1, category: '심리전형', trigger: 'button', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 리버 내 차례에 "내 패는 [족보 종류] 이상"이라고 공개 선언한다. 콜한 상대와 쇼다운에 가면, 진실이면 그 상대 각각에게서 3BB를 받고 거짓이면 각각에게 3BB를 준다.',
    timing: '리버 베팅 라운드의 내 차례',
  }),
  staredown: D({
    id: 'staredown', name: '눈싸움', stars: 1, category: '심리전형', trigger: 'button', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' }, target: 'opponentInHand', targeted: true,
    description: '게임 1회. 리버에서 상대 1명을 지목해 둘이 동시에 상대보다 "강함/약함"을 비공개로 선언한다. 둘 다 쇼다운에 가면 공개하고, 한 명만 정직했다면 정직한 쪽이 상대에게서 2BB를 받는다.',
    timing: '리버 베팅 라운드',
  }),
  sealedContract: D({
    id: 'sealedContract', name: '밀봉 계약', stars: 1, category: '심리전형', trigger: 'button', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 리버에서 베팅·레이즈하기 직전 "전원 폴드" 또는 "한 명 이상 콜"을 비공개로 고른다. 계약 사실만 공개되고, 핸드 종료 후 맞히면 은행에서 3BB를 받는다.',
    timing: '리버 베팅 라운드의 내 차례',
  }),
  nameIt: D({
    id: 'nameIt', name: '명추리', stars: 2, category: '심리전형', trigger: 'window', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'hand' }, target: 'opponentInHand', targeted: true,
    description: '매 핸드 1회. 리버 베팅이 끝난 뒤 카드 공개 전에 쇼다운 상대 1명을 지목하고 카드 1장을 부른다. 그 상대의 홀카드와 일치하면 쇼다운 없이 내가 참여할 수 있는 팟을 모두 가져가고, 틀리면 폴드하고 그 상대에게 2BB를 낸다.',
    timing: '리버 베팅이 끝난 뒤 쇼다운 직전 선언 기회에',
  }),

  // ───────── 좌석·증강 흐름 ─────────
  comeBack: D({
    id: 'comeBack', name: '3일 안에 오리라', stars: 1, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', pool: 3,
    uses: { count: 1, per: 'game' }, group: 'revival',
    description: '게임 1회. 어떤 이유로든 탈락하면 부활 대기 상태가 되고, 3핸드가 지난 뒤 원래 자리로 돌아온다. 돌아올 때의 10BB는 남은 플레이어가 똑같이 나눠 낸다. 불사의 토템과 동시 보유 불가.',
    timing: '탈락하면 자동',
  }),
  runaway: D({
    id: 'runaway', name: '폭주기관차', stars: 2, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 3,
    description: '패시브. 연속한 핸드에서 5BB 이상인 팟을 이기면 연승. 3연승이면 다음 증강 선택에서 3개 중 2개, 5연승이면 3개 모두를 가져간다. 연승 수는 모두에게 표시. 보상을 받으면 연승이 처음부터.',
    timing: '자동',
  }),
  augShuffle: D({
    id: 'augShuffle', name: '증강 셔플', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 3,
    uses: { count: 1, per: 'game' }, unique: true,
    description: '핸드 사이에 선언. 전원이 보유 증강 중 무작위 1개를 왼쪽 사람에게 넘긴다 (남은 횟수 그대로, 받은 증강은 받은 사람만 앎). 게임 전체에서 한 명만 가질 수 있는 유일 증강.',
    timing: '핸드 사이',
  }),
  lurk: D({
    id: 'lurk', name: '잠복', stars: 1, category: '심리전형', trigger: 'passive', disclosure: 'never', uses: null, pool: 3,
    description: '얻는 순간 내 다른 증강 1개를 골라 숨긴다 (없으면 다음에 얻는 증강). 숨긴 증강은 좌석의 보유 증강 수와 탐문 결과에서 빠지고, 처음 쓰는 순간 드러난다.',
    timing: '획득 시',
  }),
  hunter: D({
    id: 'hunter', name: '사냥꾼', stars: 2, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 3,
    description: '패시브. 내가 참여한 팟에서 다른 플레이어를 탈락시키면, 다 쓴 내 ★·★★ 액티브 증강 중 무작위 1개를 1회 충전한다 (토템·부활로 살아나도 탈락시킨 것으로 침).',
    timing: '자동',
  }),
  loan: D({
    id: 'loan', name: '대출', stars: 2, category: '경제/베팅형', trigger: 'button', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 은행에서 20BB를 빌리고 5핸드 뒤 25BB를 자동 상환한다. 모자라면 있는 만큼 내고 보유 증강 1개가 무작위로 몰수된다. 상환 전에 탈락·추방되면 대출은 사라진다.',
    timing: '게임 중 언제든',
  }),

  // ───────── 판정 공유·팀·탈취 ─────────
  destinyTeam: D({
    id: 'destinyTeam', name: '운명 공동체', stars: 3, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 3,
    uses: { count: 1, per: 'game' }, target: 'opponent', stealable: true,
    description: '4명 이상 남았을 때 카드를 나누기 전 선언. 짝을 지정하고 나머지는 무작위로 2명씩 짝지어 다음 핸드를 팀전으로 진행한다. 쇼다운에서 팀원이 이기면 그 팟을 팀원과 반씩 나눈다 (각자 낸 칩 한도 안에서). 팀원끼리도 홀카드는 볼 수 없다.',
    timing: '핸드 사이, 4명 이상',
  }),
  parasite: D({
    id: 'parasite', name: '기생', stars: 3, category: '족보 변형형', trigger: 'window', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' }, target: 'opponentInHand', targeted: true,
    description: '게임 1회. 쇼다운 직전 상대 1명을 지목한다. 내 홀카드 1장과 그 상대의 홀카드 중 높은 1장으로도 족보를 만들 수 있고, 더 좋은 쪽으로 판정한다 (카드를 빼앗지는 않음).',
    timing: '리버 베팅이 끝난 뒤 쇼다운 직전 선언 기회에',
  }),
  steal: D({
    id: 'steal', name: '탈취', stars: 3, category: '방어/카운터형', trigger: 'reaction', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' }, group: 'counter',
    description: '게임 1회. 반응 대기 중, 다른 사람이나 보드 카드를 지정하는 증강(짙은 안개·봉인·실명 다트·너 나가·강제 집행·양자택일·턴과 리버 사이·동결·운명 공동체)이 선언된 직후 사용. 내가 선언한 것으로 바꿔 대상과 카드를 내가 정한다.',
    timing: '탈취할 수 있는 증강의 반응 대기(3초) 중',
  }),
  promotion: D({
    id: 'promotion', name: '승격', stars: 3, category: '족보 변형형', trigger: 'window', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 리버 공개 후 베팅 전에 선언. 이번 핸드 내 족보를 한 단계 올려 판정한다 (원페어 → 투페어 등, 최대 풀하우스).',
    timing: '리버 공개 직후 선언 기회에',
  }),
  alchemy: D({
    id: 'alchemy', name: '연금술', stars: 3, category: '족보 변형형', trigger: 'window', disclosure: 'named', pool: 3,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 리버 공개 후 베팅 전에 선언. 이번 핸드 족보 계산에서 내 홀카드 1장의 숫자를 한 단계 올리거나 내린다 (무늬 유지, A와 2는 이어지지 않음, 공개된 카드와 같아지는 변경 금지). 바꾼 카드는 공개.',
    timing: '리버 공개 직후 선언 기회에',
  }),
  publicHearing: D({
    id: 'publicHearing', name: '공개 청문회', stars: 2, category: '방어/카운터형', trigger: 'passive', disclosure: 'onEffect', pool: 3,
    uses: { count: 1, per: 'game' }, group: 'counter',
    description: '게임 1회, 자동. 상대가 정보형 증강으로 내 비공개 정보를 확인할 때 발동. 확인은 허용하되, 사용자의 같은 종류 정보(투시라면 사용자의 홀카드 무작위 1장)를 테이블 전원에게 공개한다.',
    timing: '자동',
  }),

  // ───────── 확률·통계 ─────────
  recorder: D({
    id: 'recorder', name: '기록관', stars: 1, category: '정보형', trigger: 'passive', disclosure: 'never', uses: null, pool: 3,
    description: '패시브. 상대별 프리플랍 참여율과 쇼다운에서 드러난 블러프 횟수를 좌석 옆에 나에게만 보여 준다.',
    timing: '항상 자동',
  }),
  fateThread: D({
    id: 'fateThread', name: '운명의 실', stars: 3, category: '정보형', trigger: 'button', disclosure: 'anonymous', pool: 3,
    uses: { count: 1, per: 'game' }, target: 'opponentInHand',
    description: '게임 1회. 플랍 공개 직후 상대 1명을 비공개로 지목해, 리버까지 나와 그 상대만 맞붙는다고 가정한 현재 승률(%)을 나만 확인한다 (증강 효과 반영).',
    timing: '플랍 베팅 라운드, 내가 핸드에 참여하고 있을 때',
  }),

  // ═════════════════════════ 4차 풀 ═════════════════════════

  // ───────── 정보형 ─────────
  afterimage: D({
    id: 'afterimage', name: '잔상', stars: 1, category: '정보형', trigger: 'passive', disclosure: 'never', uses: null, pool: 4,
    conflicts: ['counting'],
    description: '패시브. 번 카드를 나만 본다. 카운팅과 동시 보유 불가.',
    timing: '번 카드가 쓰일 때 자동',
  }),
  reviewNote: D({
    id: 'reviewNote', name: '복기 노트', stars: 1, category: '정보형', trigger: 'button', disclosure: 'anonymous', pool: 4,
    uses: { count: 2, per: 'game' }, target: 'opponent',
    description: '게임 2회. 핸드 종료 직후 상대 1명을 지정해, 그 사람이 플랍 시점에 완성했던 족보 종류만 확인한다. 카드와 키커는 비공개. 플랍 전에 폴드했다면 "플랍 전 폴드"로 표시하고 횟수는 소모하지 않는다.',
    timing: '핸드 결과 화면',
  }),
  smell: D({
    id: 'smell', name: '후각', stars: 1, category: '정보형', trigger: 'button', disclosure: 'anonymous', pool: 4,
    uses: { count: 1, per: 'hand' }, target: 'opponentInHand',
    description: '매 핸드 1회. 상대 1명의 홀카드가 포켓 페어인지 예/아니오로만 확인한다.',
    timing: '핸드 진행 중',
  }),
  suitCheck: D({
    id: 'suitCheck', name: '무늬 감별', stars: 1, category: '정보형', trigger: 'button', disclosure: 'anonymous', pool: 4,
    uses: { count: 3, per: 'game' }, target: 'opponentInHand',
    description: '게임 3회. 상대 1명의 홀카드가 같은 무늬(수티드)인지 확인한다.',
    timing: '핸드 진행 중',
  }),
  wiretap: D({
    id: 'wiretap', name: '도청', stars: 1, category: '정보형', trigger: 'passive', disclosure: 'never', uses: null, pool: 4,
    description: '패시브. 다른 플레이어가 정보형 증강으로 카드나 패 정보를 확인할 때, 같은 결과와 사용한 사람을 나도 본다. 도청 보유자가 여러 명이면 모두 본다.',
    timing: '자동',
  }),
  deadScanner: D({
    id: 'deadScanner', name: '데드 카드 스캐너', stars: 1, category: '정보형', trigger: 'window', disclosure: 'anonymous', pool: 4,
    uses: { count: 2, per: 'game' }, conflicts: ['counting'],
    description: '게임 2회. 프리플랍이 끝난 직후 선언. 폴드한 플레이어들이 버린 카드 중 내가 지정한 무늬나 숫자가 몇 장인지 개수만 확인한다. 카운팅과 동시 보유 불가.',
    timing: '플랍 공개 직후 선언 기회에',
  }),
  ammoCheck: D({
    id: 'ammoCheck', name: '탄약 조사', stars: 1, category: '정보형', trigger: 'button', disclosure: 'anonymous', pool: 4,
    uses: { count: 2, per: 'game' }, target: 'opponent',
    description: '게임 2회. 상대 1명이 보유한 횟수 제한 증강의 남은 사용 횟수 총합만 확인한다. 증강 이름과 각각의 잔여 횟수는 알 수 없다.',
    timing: '게임 중 언제든',
  }),
  blackBox: D({
    id: 'blackBox', name: '블랙박스', stars: 1, category: '정보형', trigger: 'button', disclosure: 'anonymous', pool: 4,
    uses: { count: 2, per: 'game' },
    description: '게임 2회. 핸드가 끝난 직후 발동. 공개되지 않은 남은 보드 카드와, 그 보드가 그대로 깔렸다면 핸드 종료 시점까지 남아 있던 플레이어와 나 중 누가 1등이었는지를 나만 확인한다.',
    timing: '핸드 결과 화면',
  }),
  link: D({
    id: 'link', name: '연결 고리', stars: 2, category: '정보형', trigger: 'button', disclosure: 'anonymous', pool: 4,
    uses: { count: 2, per: 'game' }, target: 'opponentInHand',
    description: '게임 2회. 플랍 또는 턴에서 상대 1명을 지정해, 그 상대가 보드와 숫자가 같은 홀카드를 몇 장(0·1·2) 가졌는지 나만 확인한다. 무늬는 알려 주지 않는다.',
    timing: '플랍·턴 베팅 라운드',
  }),
  focus: D({
    id: 'focus', name: '초점', stars: 2, category: '정보형', trigger: 'button', disclosure: 'anonymous', pool: 4,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 플랍 공개 전에 발동. 이번 플랍 3장 중 가장 높은 숫자와 가장 낮은 숫자만 나만 미리 확인한다.',
    timing: '프리플랍 (플랍 공개 전)',
  }),

  // ───────── 카드 조작형 ─────────
  showcase: D({
    id: 'showcase', name: '교환 진열대', stars: 1, category: '카드 조작형', trigger: 'button', disclosure: 'named', pool: 4,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 프리플랍 첫 행동 전에 덱에서 2장을 모두에게 공개한다. 그중 1장과 내 홀카드 1장을 바꿀 수 있고, 내놓은 카드와 남은 후보는 버린다. 거절해도 횟수는 소모.',
    timing: '프리플랍, 내 첫 행동 전',
  }),
  envelope: D({
    id: 'envelope', name: '봉인 봉투', stars: 1, category: '카드 조작형', trigger: 'button', disclosure: 'named', pool: 4,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 프리플랍 첫 행동 전에 덱에서 예비 카드 1장을 나만 보고 보관한다. 플랍 공개 직후 홀카드 1장과 바꾸거나 버린다. 보관 중인 카드는 덱에서 빠진다.',
    timing: '프리플랍, 내 첫 행동 전',
  }),
  prepay: D({
    id: 'prepay', name: '선불 교환', stars: 1, category: '카드 조작형', trigger: 'button', disclosure: 'named', pool: 4,
    uses: { count: 2, per: 'game' },
    description: '게임 2회. 프리플랍 첫 행동 전에 홀카드 1장을 공개하고 버린다. 프리플랍은 홀카드 1장으로 베팅하고, 살아남으면 플랍 직전에 새 카드 1장을 받는다.',
    timing: '프리플랍, 내 첫 행동 전',
  }),
  coldStorage: D({
    id: 'coldStorage', name: '냉동 보관', stars: 2, category: '카드 조작형', trigger: 'button', disclosure: 'named', pool: 4,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 플랍이나 턴에서 홀카드 1장을 비공개로 보관하고 덱에서 새 카드 1장을 받는다. 보관한 카드는 이후 원하는 핸드의 프리플랍 첫 행동 전에 홀카드 1장과 바꿔 꺼낼 수 있다. 보관 중인 카드는 이후 모든 핸드의 덱에서 제외.',
    timing: '플랍·턴 베팅 라운드',
  }),
  recycle: D({
    id: 'recycle', name: '재활용', stars: 2, category: '카드 조작형', trigger: 'button', disclosure: 'named', pool: 4,
    uses: { count: 2, per: 'game' },
    description: '게임 2회. 플랍 후 이번 핸드의 번 카드를 확인하고, 원하면 그중 1장을 내 홀카드 1장과 바꾼다. 버린 내 카드는 덱으로 돌아가지 않는다.',
    timing: '플랍 이후 베팅 라운드',
  }),
  pickpocket: D({
    id: 'pickpocket', name: '소매치기', stars: 2, category: '카드 조작형', trigger: 'window', disclosure: 'named', pool: 4,
    uses: { count: 1, per: 'game' }, conflicts: ['counting'],
    description: '게임 1회. 쇼다운 직전, 이번 핸드에 폴드한 플레이어 1명의 홀카드 2장과 내 홀카드 2장을 통째로 바꾼다. 카운팅과 동시 보유 불가.',
    timing: '리버 베팅이 끝난 뒤 쇼다운 직전 선언 기회에',
  }),

  // ───────── 족보 변형형 ─────────
  shadow: D({
    id: 'shadow', name: '그림자 분신', stars: 1, category: '족보 변형형', trigger: 'window', disclosure: 'named', pool: 4,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 쇼다운 판정 때 사용. 내 홀카드 1장의 무늬를, 같은 숫자인 보드 카드의 무늬로 바꿔 판정한다.',
    timing: '리버 베팅이 끝난 뒤 쇼다운 직전 선언 기회에',
  }),
  numberMirror: D({
    id: 'numberMirror', name: '숫자 거울', stars: 1, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 4,
    description: '패시브. 6과 9를 같은 숫자로 취급한다. 페어·트리플·포카드 판정에만 적용되고 스트레이트에는 쓸 수 없다.',
    timing: '쇼다운 자동',
  }),
  underdogCrown: D({
    id: 'underdogCrown', name: '약자의 왕관', stars: 1, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 4,
    description: '패시브. 내 홀카드의 2는 하이카드와 키커 비교에서 A보다 높게 친다. 족보 구성(스트레이트 등)에는 영향 없음.',
    timing: '쇼다운 자동',
  }),
  neighbors: D({
    id: 'neighbors', name: '이웃사촌', stars: 1, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 4,
    description: '패시브. 숫자가 1 차이 나는 두 장(예: 7-8)을 원페어로 인정한다. 높은 쪽 숫자의 페어로 비교하며, 투페어 이상을 만드는 데는 쓸 수 없다.',
    timing: '쇼다운 자동',
  }),
  triplets: D({
    id: 'triplets', name: '삼쌍둥이', stars: 1, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 4,
    description: '패시브. 7장에 서로 다른 페어가 3쌍 있으면, 가장 높은 페어를 트리플, 두 번째 페어를 페어로 삼은 풀하우스로 인정한다 (예: KK-99-44-2는 K 풀 오브 9).',
    timing: '쇼다운 자동',
  }),
  omahaBlood: D({
    id: 'omahaBlood', name: '오마하의 피', stars: 2, category: '족보 변형형', trigger: 'window', disclosure: 'named', pool: 4,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 쇼다운에서 발동을 고른다. 홀카드 2장을 모두 써야 족보가 인정되는 대신, 최종 족보를 한 단계 올린다 (원페어 → 투페어, 트리플 → 스트레이트 등, 최대 풀하우스).',
    timing: '리버 베팅이 끝난 뒤 쇼다운 직전 선언 기회에',
  }),
  royalty: D({
    id: 'royalty', name: '왕실', stars: 3, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 4,
    description: '패시브. J·Q·K를 같은 숫자로 취급한다 (J-Q-K는 트리플). J·Q·K 중 두 장 이상이 함께 필요한 스트레이트는 성립하지 않는다.',
    timing: '쇼다운 자동',
  }),
  colorBlind: D({
    id: 'colorBlind', name: '색맹', stars: 3, category: '족보 변형형', trigger: 'button', disclosure: 'named', pool: 4,
    uses: { count: 2, per: 'game' }, group: 'variant',
    description: '게임 2회. 배타적 풀. 핸드 시작 시 선언하면 그 1핸드 동안 무늬 대신 색(빨강/검정)으로 플러시를 판정한다. 스트레이트 플러시는 원래 무늬 기준. 색 플러시는 일반 플러시와 같은 등급이며, 완전히 같으면 일반 플러시가 더 높다.',
    timing: '프리플랍, 내 첫 행동 전',
  }),

  // ───────── 경제/베팅형 ─────────
  savings: D({
    id: 'savings', name: '적금', stars: 1, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 4,
    description: '패시브. 프리플랍에서 폴드할 때마다 0.1BB를 적립하고, 다음에 팟을 이기면 은행에서 한꺼번에 받는다. 적립액은 나에게만 표시.',
    timing: '자동',
  }),
  reserveOrder: D({
    id: 'reserveOrder', name: '예약 주문', stars: 1, category: '경제/베팅형', trigger: 'button', disclosure: 'named', pool: 4,
    uses: { count: 1, per: 'hand' },
    description: '매 핸드 프리플랍 행동 전에 숫자 하나를 공개 지정한다. 플랍에 그 숫자가 나오고 내가 아직 핸드에 남아 있으면 팟에서 1BB를 바로 가져온다. 여러 장 나와도 한 번.',
    timing: '프리플랍, 내 첫 행동 전',
  }),
  wanted: D({
    id: 'wanted', name: '현상수배', stars: 1, category: '경제/베팅형', trigger: 'button', disclosure: 'named', pool: 4,
    uses: { count: 1, per: 'game' }, target: 'opponent', targeted: true,
    description: '게임 1회. 카드를 나누기 전 상대 1명을 공개 지목한다. 그 상대와 내가 모두 쇼다운에 도달해 내가 이기면 그 상대에게서 5BB를 추가로 받는다 (그 상대의 남은 칩 한도 내). 지목형.',
    timing: '핸드 사이 (다음 핸드 배분 전)',
  }),
  nerveTest: D({
    id: 'nerveTest', name: '배짱 시험', stars: 1, category: '경제/베팅형', trigger: 'button', disclosure: 'named', pool: 4,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 리버에서 베팅·레이즈한 직후 홀카드 1장을 골라 공개한다. 이후 상대가 전부 폴드하면 마지막으로 폴드한 상대에게서 3BB를 받는다.',
    timing: '리버에서 내가 베팅·레이즈한 직후',
  }),
  sideBet: D({
    id: 'sideBet', name: '사이드 베팅', stars: 1, category: '경제/베팅형', trigger: 'button', disclosure: 'named', pool: 4,
    uses: { count: 2, per: 'game' }, target: 'opponentInHand', conflicts: ['straw'],
    description: '게임 2회. 내가 폴드한 핸드에서, 남은 플레이어 중 누가 이길지 비공개로 예측하고 2BB를 팟에 넣는다. 맞히면 팟을 나누기 전에 4BB를 팟에서 돌려받고, 틀리면 넣은 칩은 승자의 몫이 된다. 빨대 꼽기와 동시 보유 불가.',
    timing: '내가 폴드한 뒤 (남은 플레이어 2명 이상)',
  }),
  winBonus: D({
    id: 'winBonus', name: '연승 수당', stars: 1, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 4,
    description: '패시브. 연속으로 팟을 이기면 2연승에 1BB, 3연승에 2BB처럼 1BB씩 늘어난 보너스를, 그 핸드에서 나에게 진 상대들이 나눠 낸다. 연승 수는 모두에게 표시.',
    timing: '자동',
  }),
  betCap: D({
    id: 'betCap', name: '한도 설정', stars: 1, category: '경제/베팅형', trigger: 'button', disclosure: 'named', pool: 4,
    uses: { count: 2, per: 'game' },
    description: '게임 2회. 핸드 시작 전에 이번 핸드에서 낼 최대 칩을 20BB로 묶는다. 20BB에 도달하면 그 이상은 낼 수 없고 올인과 같은 규칙(사이드팟)으로 처리한다.',
    timing: '핸드 사이 (다음 핸드 배분 전)',
  }),
  smallPot: D({
    id: 'smallPot', name: '소액 전문', stars: 1, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', pool: 4,
    uses: { count: 5, per: 'game' },
    description: '패시브. 최종 팟이 6BB 이하인 핸드에서 단독 승리하면(프리플랍 스틸 포함) 은행에서 1BB를 받는다. 게임 전체 최대 5회.',
    timing: '자동',
  }),
  regroup: D({
    id: 'regroup', name: '재정비', stars: 1, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', pool: 4,
    uses: { count: 2, per: 'game' },
    description: '게임 2회, 자동 발동. 쇼다운에서 팟을 전혀 받지 못하고 졌지만 칩이 남아 생존했다면, 핸드 종료 후 은행에서 2BB를 받는다.',
    timing: '자동',
  }),
  coHarvest: D({
    id: 'coHarvest', name: '공동 수확', stars: 1, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', pool: 4,
    uses: { count: 3, per: 'game' },
    description: '게임 3회, 자동 발동. 쇼다운에서 같은 팟을 동점으로 나눠 받으면 은행에서 2BB를 추가로 받는다. 서로 다른 사이드팟을 각자 이긴 경우는 제외, 핸드당 1회.',
    timing: '자동',
  }),
  revenge: D({
    id: 'revenge', name: '복수', stars: 2, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', uses: null, pool: 4,
    description: '패시브. 직전 쇼다운에서 나를 이긴 상대를 다음 쇼다운에서 이기면 그 상대에게서 팟의 15%를 추가로 받는다 (그 상대의 남은 칩 한도 내). 복수 대상은 나에게만 표시.',
    timing: '자동',
  }),
  straw: D({
    id: 'straw', name: '빨대 꼽기', stars: 2, category: '경제/베팅형', trigger: 'button', disclosure: 'named', pool: 4,
    uses: { count: 2, per: 'game' }, target: 'opponentInHand', conflicts: ['sideBet'],
    description: '게임 2회. 내가 폴드한 직후, 핸드에 2명 이상 남아 있을 때만 사용. 남은 플레이어 중 1명을 비공개로 지목하고(핸드 종료 후 로그에 공개), 그 사람이 이번 팟을 이기면 이번 핸드에 내가 낸 칩을 승자의 몫에서 전부 돌려받는다. 보험과 함께 발동하면 합쳐서 내가 낸 칩의 100%까지만. 사이드 베팅과 동시 보유 불가.',
    timing: '내가 폴드한 직후 (남은 플레이어 2명 이상)',
  }),
  cataclysm: D({
    id: 'cataclysm', name: '대격변', stars: 3, category: '경제/베팅형', trigger: 'button', disclosure: 'named', pool: 4,
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 핸드와 핸드 사이에 선언. 대격변을 뺀 내 보유 증강을 하나씩 무작위 새 증강으로 바꾼다. ★는 ★★로, ★★는 ★★★로, ★★★는 "몰?루 상자"로 별 개수부터 무작위(★·★★·★★★ 각 1/3)로 정해 그 별의 새 증강으로. 새 증강은 증강 풀 안에서 횟수가 꽉 찬 채로, 보유 규칙을 지켜 뽑는다. 대격변은 쓰고 나면 사라진다. 바뀐 결과는 나만 알고 좌석의 보유 증강 수는 그대로.',
    timing: '핸드 사이',
  }),

  // ───────── 심리전형 ─────────
  smokeBomb: D({
    id: 'smokeBomb', name: '연막탄', stars: 1, category: '심리전형', trigger: 'passive', disclosure: 'never', uses: null, pool: 4,
    description: '패시브. 쇼다운에서 이기거나 블러핑 성공 후 패를 공개할 때, 족보에 쓰지 않은 홀카드 1장은 끝까지 비공개로 둘 수 있다. 판정은 서버가 정상적으로 하고, 비공개 카드는 다른 플레이어 뷰에 보내지 않는다.',
    timing: '자동',
  }),
  bait: D({
    id: 'bait', name: '미끼 공개', stars: 1, category: '심리전형', trigger: 'button', disclosure: 'named', pool: 4,
    uses: { count: 2, per: 'game' },
    description: '게임 2회. 프리플랍 첫 행동 전에 홀카드 1장을 골라 공개한다. 이번 핸드를 쇼다운에서 이기면 콜한 상대 각각에게서 1BB를 받는다.',
    timing: '프리플랍, 내 첫 행동 전',
  }),

  // ───────── 방어/카운터형 ─────────
  pokerFace: D({
    id: 'pokerFace', name: '포커페이스', stars: 1, category: '방어/카운터형', trigger: 'passive', disclosure: 'never', uses: null, pool: 4, group: 'counter',
    description: '패시브. 탐문, 관찰자, 복기 노트, 도청, 탄약 조사에 내 정보가 잡히지 않는다 (사용자에게는 "정보 없음"으로 표시하고 횟수는 소모).',
    timing: '자동',
  }),
  selectiveReveal: D({
    id: 'selectiveReveal', name: '선택적 노출', stars: 1, category: '방어/카운터형', trigger: 'passive', disclosure: 'never', pool: 4, group: 'counter',
    uses: { count: 2, per: 'game' },
    description: '게임 2회. 상대가 내 홀카드 중 무작위 1장을 확인하는 증강(투시 등)을 쓸 때, 보여 줄 카드를 내가 고른다(제한 시간 10초, 응답 없으면 원래대로 무작위). 두 장 전체 확인이나 포켓 페어 여부 같은 질문형 정보에는 적용되지 않는다.',
    timing: '상대가 나에게 투시를 쓸 때',
  }),
  infoToll: D({
    id: 'infoToll', name: '정보 통행료', stars: 1, category: '방어/카운터형', trigger: 'passive', disclosure: 'onEffect', pool: 4, group: 'counter',
    uses: { count: 2, per: 'game' },
    description: '게임 2회. 상대가 나에게 정보형 증강을 쓰면, 결과 확인 전에 상대가 고른다. 나에게 2BB를 내고 진행하거나, 취소하고 사용 횟수를 돌려받는다(제한 시간 10초, 응답 없으면 취소). 어느 쪽이든 통행료 횟수는 소모된다.',
    timing: '상대가 나에게 정보형 증강을 쓸 때',
  }),
  trap: D({
    id: 'trap', name: '덫', stars: 1, category: '방어/카운터형', trigger: 'button', disclosure: 'never', pool: 4, group: 'counter',
    uses: { count: 1, per: 'game' },
    description: '게임 1회. 미리 비공개로 설치한다. 다음에 나를 대상으로 한 증강(지목형 또는 정보형)은 정상 발동하지만, 그 사용자의 보유 증강 전체(이름과 별)가 나에게 공개된다.',
    timing: '게임 중 언제든 (비공개 설치)',
  }),

  // ───────── 공개형 (모두 게임 1회) ─────────
  indianPoker: D({
    id: 'indianPoker', name: '인디언 포커', stars: 1, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 4,
    uses: { count: 1, per: 'game' },
    description: '카드를 나눠 주기 전에만 선언. 각자 홀카드 2장 중 1장은 이마에 붙인 상태로 받는다. 이마 카드는 본인만 못 보고 나머지는 모두 본다. 그 상태로 베팅 진행.',
    timing: '핸드 사이 (다음 핸드 배분 전)',
  }),
  dealerWhim: D({
    id: 'dealerWhim', name: '딜러의 변덕', stars: 1, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 4,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '프리플랍 시작 전 선언. 이번 핸드부터 3핸드 동안 버튼 이동, 블라인드 위치, 베팅 순서가 모두 반시계 방향으로 돈다. 3핸드가 끝나면 그 위치에서 다시 시계 방향으로 돈다.',
    timing: '핸드 사이 (다음 핸드 배분 전)',
  }),
  commonWell: D({
    id: 'commonWell', name: '공동 우물', stars: 1, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 4,
    uses: { count: 1, per: 'game' },
    description: '플랍 후 선언. 남은 플레이어 전원이 홀카드 1장씩 비공개로 골라 가운데에 내고, 섞어서 무작위로 다시 나눈다 (자기 카드를 다시 받을 수도 있음).',
    timing: '플랍 이후 베팅 라운드',
  }),
  silentRiver: D({
    id: 'silentRiver', name: '침묵의 리버', stars: 1, category: '공개형', trigger: 'window', disclosure: 'named', public: true, pool: 4,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '턴 베팅이 끝난 뒤 선언. 리버를 공개한 뒤 리버 베팅 없이 바로 쇼다운으로 간다.',
    timing: '턴 베팅이 끝난 뒤 선언 기회에',
  }),
  truce: D({
    id: 'truce', name: '휴전', stars: 1, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 4,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '플랍 또는 턴에서 내게 체크할 권리가 있을 때(이번 라운드에 아직 베팅이 없을 때) 선언. 이번 라운드는 모두 체크한 것으로 처리하고 다음 카드를 공개한다.',
    timing: '플랍·턴, 베팅이 없을 때 내 차례',
  }),
  sharedCard: D({
    id: 'sharedCard', name: '공용 카드', stars: 1, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 4,
    uses: { count: 1, per: 'game' },
    description: '플랍 전 선언. 남은 플레이어 전원이 홀카드 1장을 골라 공개하고(제한 시간 내 고르지 않으면 무작위), 공개된 카드는 모두가 보드처럼 쓸 수 있다. 각자 남은 홀카드는 1장.',
    timing: '프리플랍 (플랍이 깔리기 전)',
  }),
  halfSecret: D({
    id: 'halfSecret', name: '반쪽짜리 비밀', stars: 1, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 4,
    uses: { count: 1, per: 'game' },
    description: '프리플랍 베팅 전 선언. 남은 플레이어 전원이 홀카드 1장을 비공개로 골라 동시에 공개하고, 나머지 1장은 숨긴다.',
    timing: '프리플랍, 아무도 행동하기 전',
  }),
  oneMore: D({
    id: 'oneMore', name: '한 번만 더', stars: 1, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 4,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '베팅 라운드 시작 전 선언. 이번 라운드는 첫 베팅 이후 레이즈를 한 번만 허용하고, 이후에는 콜·폴드만 가능하다(체크는 정상). 상한을 넘는 올인은 콜에 필요한 금액까지만 낸다.',
    timing: '베팅 라운드가 시작되고 아무도 행동하기 전',
  }),
  switcheroo: D({
    id: 'switcheroo', name: '바꿔치기', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 4,
    uses: { count: 1, per: 'game' }, target: 'opponentInHand', targeted: true, stealable: true,
    description: '프리플랍 전용. 상대 1명을 지목해 내 홀카드 2장과 그 상대의 홀카드 2장을 맞교환한다. 지목형.',
    timing: '프리플랍 베팅 중',
  }),
  catchThief: D({
    id: 'catchThief', name: '도둑잡기', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 4,
    uses: { count: 1, per: 'game' },
    description: '각 베팅 라운드 시작 전 선언. 선언자가 방향(왼쪽/오른쪽)을 정하고, 핸드에 남은 플레이어가 각자 고른 홀카드 1장을 동시에 옆 사람에게 넘긴다(옆 사람은 남은 플레이어 기준).',
    timing: '베팅 라운드가 시작되고 아무도 행동하기 전',
  }),
  timeBomb: D({
    id: 'timeBomb', name: '시한폭탄', stars: 2, category: '공개형', trigger: 'window', disclosure: 'named', public: true, pool: 4,
    uses: { count: 1, per: 'game' },
    description: '플랍 공개 직후 선언. 이번 핸드에서는 체크를 선택하면 즉시 폴드 처리된다 (베팅하거나 폴드해야 함). 칩이 없어 베팅할 수 없는 올인 플레이어는 예외.',
    timing: '플랍 공개 직후 선언 기회에',
  }),
  lastChoice: D({
    id: 'lastChoice', name: '마지막 선택', stars: 2, category: '공개형', trigger: 'window', disclosure: 'named', public: true, pool: 4,
    uses: { count: 1, per: 'game' }, tableWide: true,
    description: '턴 베팅이 끝난 뒤 선언. 남은 전원이 홀카드를 그대로 둘지 1장 바꿀지 비공개로 고르고 동시에 공개한다. 바꾸는 사람은 버릴 카드를 뒷면으로 내고 차례로 새 카드를 받은 뒤, 리버를 정상 공개한다.',
    timing: '턴 베팅이 끝난 뒤 선언 기회에',
  }),
};

export const ALL_AUGMENT_IDS = Object.keys(AUGMENTS) as AugmentId[];

export function isAugmentId(v: unknown): v is AugmentId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(AUGMENTS, v);
}

/** 플레이어가 직접 쓰는(액티브) 증강인가 — 공포탄 사용 조건, 재충전·사냥꾼 대상 */
export function isActiveAugment(id: AugmentId): boolean {
  return AUGMENTS[id].trigger !== 'passive';
}

/** 게임 전체에서 다른 사람이 가진 유일 증강 (선택지에서 뺀다) */
export function uniqueTaken(ownedByOthers: readonly AugmentId[]): AugmentId[] {
  return ownedByOthers.filter((id) => AUGMENTS[id].unique);
}

/** 보유 규칙: 중복 불가, 4장 플러시/징검다리 중 1개, 방어/카운터형 1개 */
export function canHold(owned: readonly AugmentId[], id: AugmentId): boolean {
  if (owned.includes(id)) return false;
  const g = AUGMENTS[id].group;
  if (g && owned.some((o) => AUGMENTS[o].group === g)) return false;
  // 동시 보유 불가 (카운팅 ↔ 잔상·소매치기·데드 카드 스캐너, 사이드 베팅 ↔ 빨대 꼽기)
  if (owned.some((o) => AUGMENTS[id].conflicts?.includes(o) || AUGMENTS[o].conflicts?.includes(id))) return false;
  return true;
}

/** 레벨(1부터)별 별 개수 확률 [★, ★★, ★★★] (%) */
const TIER_POINTS: Record<number, [number, number, number]> = {
  1: [70, 25, 5],
  3: [40, 45, 15],
  5: [20, 50, 30],
};

export function tierWeights(level: number): [number, number, number] {
  if (level <= 1) return TIER_POINTS[1];
  if (level >= 5) return TIER_POINTS[5];
  if (TIER_POINTS[level]) return TIER_POINTS[level];
  const a = TIER_POINTS[level - 1];
  const b = TIER_POINTS[level + 1];
  return [0, 1, 2].map((i) => (a[i] + b[i]) / 2) as [number, number, number];
}

export function rollTier(level: number, rng: Rng): Stars {
  const scaled = tierWeights(level).map((w) => Math.round(w * 10));
  let x = rng.int(scaled.reduce((a, b) => a + b, 0));
  for (let i = 0; i < 3; i++) {
    if (x < scaled[i]) return (i + 1) as Stars;
    x -= scaled[i];
  }
  return 1;
}

/**
 * 선택지 생성: 별 개수를 레벨 확률로 뽑고, 그 별에서 보유 가능한 증강을 최대 3개 고른다.
 * 3개 미만이면 한 단계 낮은 별에서 채운다(그래도 모자라면 그 아래 별에서).
 */
export function rollAugmentOffer(
  level: number,
  owned: AugmentId[],
  rng: Rng,
  tier?: Stars,
  taken: readonly AugmentId[] = [],
  /** 이번 게임의 증강 풀 (없으면 전체) */
  allowed: ReadonlySet<AugmentId> | null = null,
): AugmentId[] {
  const t = tier ?? rollTier(level, rng);
  const offer: AugmentId[] = [];
  // 뽑은 별 → 한 단계씩 낮은 별 → 그래도 모자라면 높은 별
  const order: Stars[] = [t, ...([3, 2, 1] as Stars[]).filter((s) => s < t), ...([1, 2, 3] as Stars[]).filter((s) => s > t)];
  for (const s of order) {
    if (offer.length >= 3) break;
    // taken: 다른 사람이 이미 가진 유일 증강 (또는 지금 보이던 선택지)
    const avail = ALL_AUGMENT_IDS.filter(
      (id) => AUGMENTS[id].stars === s && (!allowed || allowed.has(id)) && canHold(owned, id) && !taken.includes(id) && !offer.includes(id),
    );
    offer.push(...sample(avail, 3 - offer.length, rng));
  }
  return offer;
}

/** 무작위 새 증강 1개 (대격변 등): 정한 별에서 풀·보유 규칙에 맞는 것 */
export function rollOneAugment(stars: Stars, owned: readonly AugmentId[], rng: Rng, taken: readonly AugmentId[] = [], allowed: ReadonlySet<AugmentId> | null = null): AugmentId | null {
  const avail = ALL_AUGMENT_IDS.filter((id) => AUGMENTS[id].stars === stars && (!allowed || allowed.has(id)) && canHold(owned, id) && !taken.includes(id));
  return avail.length ? sample(avail, 1, rng)[0] : null;
}

// ───────────────────────── 증강 풀 설정 ─────────────────────────

export type PoolPreset = 'p1' | 'p12' | 'p123' | 'all' | 'custom';

export const POOL_PRESET_LABEL: Record<PoolPreset, string> = { p1: '1차만', p12: '1~2차', p123: '1~3차', all: '전체', custom: '직접 고름' };

/** 프리셋의 증강 목록 (custom 이면 고른 목록 중 실제 있는 것만) */
export function poolIds(preset: PoolPreset, custom: readonly unknown[] = []): AugmentId[] {
  switch (preset) {
    case 'p1':
      return ALL_AUGMENT_IDS.filter((id) => (AUGMENTS[id].pool ?? 1) === 1);
    case 'p12':
      return ALL_AUGMENT_IDS.filter((id) => (AUGMENTS[id].pool ?? 1) <= 2);
    case 'p123':
      return ALL_AUGMENT_IDS.filter((id) => (AUGMENTS[id].pool ?? 1) <= 3);
    case 'custom': {
      const set = new Set(custom.filter(isAugmentId));
      return ALL_AUGMENT_IDS.filter((id) => set.has(id));
    }
    default:
      return [...ALL_AUGMENT_IDS];
  }
}

/** 별 개수별 증강 수 [★, ★★, ★★★] */
export function poolStarCounts(ids: readonly AugmentId[]): [number, number, number] {
  const c: [number, number, number] = [0, 0, 0];
  for (const id of ids) c[AUGMENTS[id].stars - 1]++;
  return c;
}

/** 별 개수마다 최소 3개가 있어야 시작할 수 있다. 부족하면 안내 문장 */
export const POOL_MIN_PER_STAR = 3;
export function poolError(ids: readonly AugmentId[]): string | null {
  const c = poolStarCounts(ids);
  const short = c.map((n, i) => (n < POOL_MIN_PER_STAR ? `${'★'.repeat(i + 1)} ${POOL_MIN_PER_STAR - n}개` : '')).filter(Boolean);
  return short.length ? `증강 풀이 부족합니다: ${short.join(', ')} 더 필요 (별마다 최소 ${POOL_MIN_PER_STAR}개)` : null;
}
