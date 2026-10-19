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
  | 'restart';

export type Stars = 1 | 2 | 3;

export type AugmentCategory = '정보형' | '카드 조작형' | '족보 변형형' | '경제/베팅형' | '심리전형' | '방어/카운터형' | '공개형';

/**
 * 발동 방식
 * - passive: 조건이 되면 자동
 * - button: 원할 때 버튼으로 선언 (시점 조건은 timing 참고)
 * - toggle: 켜 두면 조건이 될 때 자동 사용 (면제권) / 미리 준비 (위장)
 * - window: 정해진 선언 기회(플랍·턴·리버 공개 직후)에만
 * - call: 콜할 때 함께 선언 (무임승차)
 * - reaction: 다른 증강의 반응 대기 시간 중에만 (카운터 스펠, 면역)
 */
export type Trigger = 'passive' | 'button' | 'toggle' | 'window' | 'call' | 'reaction';

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
  /** 같은 그룹은 한 사람이 1개만 보유 (variant: 4장 플러시·징검다리·4장 스트레이트·짝수/홀수 동맹·보폭 두 배) */
  group?: 'variant' | 'counter';
  /** 1차 / 2차 풀 */
  pool?: 1 | 2;
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
    id: 'seal', name: '봉인', stars: 3, category: '카드 조작형', trigger: 'window', disclosure: 'named',
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
    uses: { count: 1, per: 'game' }, target: 'richerOpponent',
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
    id: 'heavyFog', name: '짙은 안개', stars: 3, category: '공개형', trigger: 'button', disclosure: 'named', public: true,
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
    id: 'eitherOr', name: '양자택일', stars: 3, category: '카드 조작형', trigger: 'window', disclosure: 'named', pool: 2,
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
    id: 'totem', name: '불사의 토템', stars: 2, category: '경제/베팅형', trigger: 'passive', disclosure: 'onEffect', pool: 2,
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
    description: '게임 1회. 공개형 증강의 반응 대기 중에 사용하면 나만 그 효과에서 빠진다 (암전·유리 테이블·러시안 룰렛·짙은 안개·실명 다트·너 나가·죽음과 세금). 폭탄 팟·하이카드·언더독·밥상 뒤집기·나 다시 돌아갈래에는 쓸 수 없다.',
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
    uses: { count: 1, per: 'game' }, target: 'opponentInHand',
    description: '플랍 전 프리플랍 베팅 중 내 차례에 선언. 상대 1명을 지목하면 그 상대는 이번 핸드 동안 보드를 볼 수 없고 자기 홀카드만 보며 플레이한다 (쇼다운 때 공개). 지목형.',
    timing: '프리플랍 베팅 중 내 차례',
  }),
  getOut: D({
    id: 'getOut', name: '너 나가', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true, pool: 2,
    uses: { count: 1, per: 'game' }, target: 'opponentInHand',
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
};

export const ALL_AUGMENT_IDS = Object.keys(AUGMENTS) as AugmentId[];

export function isAugmentId(v: unknown): v is AugmentId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(AUGMENTS, v);
}

/** 플레이어가 직접 쓰는(액티브) 증강인가 — 공포탄 사용 조건 */
export function isActiveAugment(id: AugmentId): boolean {
  return AUGMENTS[id].trigger !== 'passive';
}

/** 보유 규칙: 중복 불가, 4장 플러시/징검다리 중 1개, 방어/카운터형 1개 */
export function canHold(owned: readonly AugmentId[], id: AugmentId): boolean {
  if (owned.includes(id)) return false;
  const g = AUGMENTS[id].group;
  if (g && owned.some((o) => AUGMENTS[o].group === g)) return false;
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
export function rollAugmentOffer(level: number, owned: AugmentId[], rng: Rng, tier?: Stars): AugmentId[] {
  const t = tier ?? rollTier(level, rng);
  const offer: AugmentId[] = [];
  for (let s = t; s >= 1 && offer.length < 3; s--) {
    const avail = ALL_AUGMENT_IDS.filter((id) => AUGMENTS[id].stars === s && canHold(owned, id) && !offer.includes(id));
    offer.push(...sample(avail, 3 - offer.length, rng));
  }
  return offer;
}
