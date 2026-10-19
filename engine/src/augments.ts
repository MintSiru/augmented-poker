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
  | 'deathTax';

export type Stars = 1 | 2 | 3;

export type AugmentCategory = '정보형' | '카드 조작형' | '족보 변형형' | '경제/베팅형' | '심리전형' | '방어/카운터형' | '공개형';

/**
 * 발동 방식
 * - passive: 조건이 되면 자동
 * - button: 원할 때 버튼으로 선언 (시점 조건은 timing 참고)
 * - toggle: 켜 두면 조건이 될 때 자동 사용 (면제권) / 미리 준비 (위장)
 * - window: 정해진 선언 기회(턴·리버 공개 직후)에만
 * - call: 콜할 때 함께 선언 (무임승차)
 * - reaction: 다른 증강의 반응 대기 시간 중에만 (카운터 스펠)
 */
export type Trigger = 'passive' | 'button' | 'toggle' | 'window' | 'call' | 'reaction';

/**
 * 공개 방식
 * - anonymous: 사용 시 "○○님이 비공개 증강을 사용했습니다" (이름 숨김)
 * - named: 사용(선언) 시 이름 공개
 * - onEffect: 패시브. 효과가 처음 드러나는 순간 공개
 * - never: 나만 아는 효과라 공개하지 않음
 */
export type Disclosure = 'anonymous' | 'named' | 'onEffect' | 'never';

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
  /** 같은 그룹은 한 사람이 1개만 보유 */
  group?: 'flushOrGap' | 'counter';
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
    group: 'flushOrGap',
    description: '나에게만 적용. 같은 무늬 4장도 플러시로 인정. 5장 플러시보다는 낮고, 4장 플러시끼리는 높은 카드 순으로 비교.',
    timing: '쇼다운에서 자동',
  }),
  gapStraight: D({
    id: 'gapStraight', name: '징검다리', stars: 2, category: '족보 변형형', trigger: 'passive', disclosure: 'onEffect', uses: null,
    group: 'flushOrGap',
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
    description: '패시브, 1회, 자동. 다른 사람의 증강이 나를 강제 폴드시키거나 내 카드를 교환·폐기할 때 막는다 (1차 풀에서는 러시안 룰렛).',
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
    id: 'deathTax', name: '죽음과 세금', stars: 2, category: '공개형', trigger: 'button', disclosure: 'named', public: true,
    uses: { count: 1, per: 'game' },
    description: '선언한 순간부터 게임이 끝날 때까지, 선언자를 제외한 모든 플레이어는 액티브·공개형 증강을 쓸 때마다 은행에 1BB를 낸다 (패시브·자동 발동 제외, 공포탄도 납부). 두 명이 선언하면 2BB이고 각자 자기 세금만 면제. 낼 칩이 없으면 그 증강을 쓸 수 없다.',
    timing: '게임 중 언제든',
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
