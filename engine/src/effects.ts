// 증강 효과 함수 레지스트리.
// - ACTIVE: 선언형 증강. check(시점·대상 검증) → 3초 반응 대기 → resolve(효과 적용). 카운터되면 onCountered.
// - PASSIVE: 엔진이 정해진 시점에 부르는 훅 (홀카드 수, 폴드, 핸드 종료, 정보 노출, 강제 폴드 방어).
// 족보 변형(원형·4장 플러시·징검다리·편애)은 core.rulesFor, 동점 처리(키커 장인·절대 키커)는 showdown.ts 에서 처리한다.
// 새 증강은 augments.ts 에 정의를 추가하고 여기에 효과를 등록하면 된다.

import { Card, cardToken, fullDeck, isCard, rankOf, rankName, suitOf } from './cards.js';
import { AUGMENTS, AugmentId, canHold, isActiveAugment, isAugmentId, rollOneAugment } from './augments.js';
import { blackjackCards, isMadeHand, Category, CATEGORY_NAMES } from './evaluator.js';
import { pickOne, shuffle } from './rng.js';
import { compareContenders } from './showdown.js';
import { headsUpEquity } from './equity.js';
import { contenderFor, handEvalFor, standingOf } from './standing.js';
import {
  active,
  addLog,
  canAct,
  announceNamed,
  basePhase,
  boardBlind,
  boardBlindIds,
  boardInfoHidden,
  flopCount,
  logBoard,
  maskFor,
  invertedNow,
  ownCardsHidden,
  cardsText,
  countUse,
  currentBlinds,
  evalBoard,
  findAug,
  handInProgress,
  holeVisible,
  newOwnedAugment,
  poolSet,
  takenByOthers,
  idxOf,
  live,
  nameOf,
  note,
  playerById,
  publicCards,
  putChips,
  rulesFor,
  seatOrderFromDealer,
  taxError,
  visibleBoard,
} from './core.js';
import type { ActiveParams, Declaration, GameState, HandResult, NoteKind, OwnedAugment, PlayerState, RespondAnswer, RespondState, ScheduledTask } from './types.js';

/** 효과 함수가 게임 흐름을 건드릴 때 쓰는 엔진 기능 (game.ts 가 제공) */
export interface EngineOps {
  /** 폴드 처리 (보험 등 폴드 훅 포함). 흐름 진행은 하지 않는다 */
  fold(p: PlayerState, forced: boolean): void;
  /** 서킷브레이커: 이번 베팅 라운드를 처음부터 다시 */
  restartRound(): void;
  /** 하이카드: 핸드를 무효화하고 홀카드 1장 승부 */
  highCardDuel(): void;
  /** 나 다시 돌아갈래: 핸드를 프리플랍부터 다시 */
  restartHand(declarer: PlayerState): void;
  /** 보드 카드 1장 추가 공개 (플러스 원) */
  addBoardCard(label: string): void;
  /** 베팅 행동 뒤 흐름 진행 (무임승차 콜) */
  afterBet(idx: number): void;
  /** 제안·입찰 시작: 응답이 모두 모이거나 15초가 지나면 효과의 respond.done 이 불린다 */
  startRespond(spec: Pick<RespondState, 'kind' | 'augment' | 'ownerId' | 'participants' | 'params'> & { seconds?: number }): boolean;
}

export interface Ctx {
  state: GameState;
  ops: EngineOps;
  owner: PlayerState;
  aug: OwnedAugment;
  /** 탈취한 선언: 선언 시점 조건(내 차례·내 올인 등)은 보지 않고 대상만 다시 검사 */
  stolen?: boolean;
  /** 정보 통행료를 내고(또는 선택적 노출 응답 뒤) 다시 처리 중 */
  tollPaid?: boolean;
  /** 선택적 노출로 대상이 고른 카드 번호 */
  pick?: number;
}

export interface ActiveEffect {
  /** 사용 가능 여부 (시점·대상). 횟수와 보유는 엔진이 공통으로 검사. atResolve=true 는 반응 대기 후 재검사 */
  check(ctx: Ctx, params: ActiveParams, atResolve: boolean): string | null;
  /** 선언 시 추가로 소모할 것 (양치기 소년의 가짜 공개 등) */
  consume?(ctx: Ctx, params: ActiveParams): void;
  resolve(ctx: Ctx, params: ActiveParams, decl: Declaration): void;
  onCountered?(ctx: Ctx, params: ActiveParams): void;
  /** 선언 세부 (로그, 공개) */
  detail?(ctx: Ctx, params: ActiveParams): string;
  /** 제안·입찰형: 응답 검증, 기본 응답(시간 초과·자리 비움), 결과 처리 */
  respond?: RespondHooks;
}

export interface RespondHooks {
  error(ctx: Ctx, r: RespondState, p: PlayerState, a: RespondAnswer): string | null;
  fallback(ctx: Ctx, r: RespondState, p: PlayerState): RespondAnswer;
  /** 응답이 모두 모였을 때. true 를 돌려주면 r 을 고친 채로 응답을 더 받는다 (공동 환승의 카드 고르기) */
  done(ctx: Ctx, r: RespondState): boolean;
}

/** 상대의 비공개 정보를 확인하는 증강의 종류 (역정보·거울·역추적·공개 청문회·도청·포커페이스가 반응) */
export type InfoKind = 'clairvoyance' | 'thermal' | 'liedetector' | 'thermometer' | 'smell' | 'suitCheck' | 'link' | 'inquiry' | 'ammoCheck' | 'reviewNote';

const INFO_NAME: Record<InfoKind, string> = {
  clairvoyance: '투시',
  thermal: '열화상 카메라',
  liedetector: '거짓말 탐지기',
  thermometer: '온도계',
  smell: '후각',
  suitCheck: '무늬 감별',
  link: '연결 고리',
  inquiry: '탐문',
  ammoCheck: '탄약 조사',
  reviewNote: '복기 노트',
};

/** 역정보가 가짜 결과를 만들 수 있는 종류 */
const FAKEABLE: readonly InfoKind[] = ['clairvoyance', 'thermal', 'liedetector', 'thermometer', 'smell', 'suitCheck', 'link'];
/** 포커페이스가 막는 종류 (관찰자·도청은 따로 처리) */
const POKER_FACE: readonly InfoKind[] = ['inquiry', 'reviewNote', 'ammoCheck'];

export interface PassiveEffect {
  /** 받는 홀카드 수 */
  holeCards?: number;
  onFold?(ctx: Ctx, forced: boolean): void;
  onHandEnd?(ctx: Ctx, result: HandResult): void;
  /** 정보형 증강에 노출될 때. 'fake' 를 돌려주면 보는 사람에게 가짜 결과를 보여 준다 */
  onInfoExposed?(ctx: Ctx, looker: PlayerState, kind: InfoKind): 'fake' | void;
  /** 다른 사람 증강의 강제 폴드를 막으면 true */
  blockForcedFold?(ctx: Ctx): boolean;
  /** 칩이 0이 되어 탈락할 때. true 면 탈락하지 않는다 (부활 대기 등) */
  onBust?(ctx: Ctx): boolean;
  /** 증강 선택 라운드가 시작될 때 (선택지를 받은 뒤) */
  onPickRound?(ctx: Ctx): void;
  /** 내가 증강을 얻었을 때 (얻은 증강 자신 포함) */
  onAcquire?(ctx: Ctx, got: OwnedAugment): void;
  /** 번 카드가 쓰일 때 */
  onBurn?(ctx: Ctx, card: Card): void;
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

/** 보드로 계산되는 정보를 쓰는 증강: 실명 다트 대상은 쓸 수 없다 */
function needSight(ctx: Ctx): string | null {
  return boardBlind(ctx.state, ctx.owner) ? '실명 다트: 이번 핸드에는 보드를 볼 수 없어 쓸 수 없습니다.' : null;
}

/** 보드의 무늬까지 알아야 계산되는 정보 (순위표·운명의 실·블랙잭 제외): 가림 규칙이 걸리면 쓸 수 없다 */
function needClearSight(ctx: Ctx): string | null {
  return needSight(ctx) ?? (boardInfoHidden(ctx.state, ctx.owner) ? '안경 없어서 잘 안보여: 이번 핸드에는 보드가 또렷하지 않아 쓸 수 없습니다.' : null);
}

/** 프리플랍 베팅 중 내 차례 (실명 다트·너 나가·하이카드) */
function preflopMyTurn(ctx: Ctx): string | null {
  const { state, owner } = ctx;
  if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.boardRevealed > 0) return '프리플랍 베팅 중에만 선언할 수 있습니다.';
  if (state.toAct !== idxOf(state, owner.id) && !ctx.stolen) return '내 차례에만 선언할 수 있습니다.';
  if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
  return null;
}

/** 지목형 증강(강제 집행·실명 다트·너 나가)의 대상 검사: 철벽이면 지목할 수 없다 */
function targetable(t: PlayerState): string | null {
  return t.ironWall ? `${t.name}은(는) 철벽으로 이번 핸드에 지목할 수 없습니다.` : null;
}

/** 강제 폴드 방어 (방탄조끼) */
function blocksForcedFold(ctx: Ctx, victim: PlayerState): boolean {
  for (const a of victim.augments) {
    const hook = PASSIVE[a.id]?.blockForcedFold;
    if (hook && hook({ ...ctx, owner: victim, aug: a })) return true;
  }
  return false;
}

/** 핸드 사이 (다음 핸드 배분 전) */
function betweenHandsCheck(ctx: Ctx): string | null {
  const b = basePhase(ctx.state);
  if (b !== 'handEnd' && b !== 'augmentSelect') return '카드를 나눠 주기 전(핸드 사이)에만 선언할 수 있습니다.';
  if (!active(ctx.owner)) return '게임에 참여하고 있지 않습니다.';
  return null;
}

function validHoleIndex(owner: PlayerState, ci: unknown): ci is number {
  return typeof ci === 'number' && Number.isInteger(ci) && ci >= 0 && ci < owner.hole.length;
}

function hiLoText(cards: Card[]): string {
  const hi = cards.filter((c) => rankOf(c) >= 10).length;
  return `하이 ${hi}장, 로우 ${cards.length - hi}장`;
}

// ───────────────────────── 정보형 결과 전달 ─────────────────────────

export interface InfoResult {
  /** 이름 뒤에 붙는 문장 ("의 홀카드 — 하이 1장, 로우 1장" 등) */
  text: string;
  cards?: Card[];
}

const yn = (b: boolean) => (b ? '예' : '아니오');

/** p 에 대한 진짜 정보. asker 는 보드 기준(연결 고리), pick 은 선택적 노출로 고른 카드 */
export function infoAbout(state: GameState, p: PlayerState, kind: InfoKind, asker: PlayerState, pick?: number): InfoResult {
  switch (kind) {
    case 'clairvoyance': {
      const c = pick !== undefined && p.hole[pick] ? p.hole[pick] : pickOne(p.hole, state.rng);
      return { text: `의 홀카드 중 1장은 ${cardToken(c)}`, cards: [c] };
    }
    case 'thermal':
      return { text: `의 홀카드 — ${hiLoText(p.hole)}` };
    case 'liedetector':
      return { text: ` — ${realMade(state, p) ? '메이드 핸드입니다' : '메이드 핸드가 아닙니다'}` };
    case 'thermometer':
      return { text: `의 홀카드 숫자 합은 15 ${p.hole.reduce((a, c) => a + rankOf(c), 0) >= 15 ? '이상' : '미만'}` };
    case 'smell':
      return { text: `의 홀카드는 포켓 페어인가? ${yn(pocketPair(p))}` };
    case 'suitCheck':
      return { text: `의 홀카드는 같은 무늬인가? ${yn(suited(p))}` };
    case 'link':
      return { text: `의 홀카드 중 보드와 숫자가 같은 카드: ${linkCount(state, p, asker)}장` };
    case 'inquiry': {
      // 잠복으로 숨긴 증강은 빠진다
      const stars = p.augments.filter((x) => !x.hidden).map((x) => AUGMENTS[x.id].stars).sort((x, y) => y - x);
      return { text: `의 증강 별 개수 — ${stars.length ? stars.map((s) => '★'.repeat(s)).join(', ') : '증강 없음'}` };
    }
    case 'ammoCheck':
      return { text: `의 횟수 제한 증강 남은 사용 횟수 총합: ${p.augments.reduce((sum, a) => sum + (AUGMENTS[a.id].uses?.per === 'game' ? (a.usesLeft ?? 0) : 0), 0)}회` };
    case 'reviewNote': {
      const c = state.flopCategory[p.id];
      return { text: c === undefined ? ' — 플랍 전 폴드' : `이(가) 플랍 시점에 완성했던 족보: ${CATEGORY_NAMES[c]}` };
    }
  }
}

/** 역정보: 실제와 다른 값 */
function fakeInfo(state: GameState, p: PlayerState, kind: InfoKind, asker: PlayerState): InfoResult {
  switch (kind) {
    case 'clairvoyance': {
      // 대상이 갖지 않았고 보는 사람이 이미 아는 카드도 아닌 가짜 카드
      const known = new Set<Card>([...p.hole, ...asker.hole, ...visibleBoard(state, asker).filter((c): c is Card => !!c), ...publicCards(state)]);
      const c = pickOne(fullDeck().filter((x) => !known.has(x)), state.rng);
      return { text: `의 홀카드 중 1장은 ${cardToken(c)}`, cards: [c] };
    }
    case 'thermal': {
      const n = p.hole.length;
      const real = p.hole.filter((c) => rankOf(c) >= 10).length;
      const h = pickOne(Array.from({ length: n + 1 }, (_, i) => i).filter((x) => x !== real), state.rng);
      return { text: `의 홀카드 — 하이 ${h}장, 로우 ${n - h}장` };
    }
    case 'liedetector':
      return { text: ` — ${realMade(state, p) ? '메이드 핸드가 아닙니다' : '메이드 핸드입니다'}` };
    case 'thermometer':
      return { text: `의 홀카드 숫자 합은 15 ${p.hole.reduce((a, c) => a + rankOf(c), 0) >= 15 ? '미만' : '이상'}` };
    case 'smell':
      return { text: `의 홀카드는 포켓 페어인가? ${yn(!pocketPair(p))}` };
    case 'suitCheck':
      return { text: `의 홀카드는 같은 무늬인가? ${yn(!suited(p))}` };
    case 'link': {
      const real = linkCount(state, p, asker);
      const n = pickOne([0, 1, 2].filter((x) => x !== real && x <= p.hole.length), state.rng);
      return { text: `의 홀카드 중 보드와 숫자가 같은 카드: ${n}장` };
    }
    default:
      return infoAbout(state, p, kind, asker);
  }
}

function pocketPair(p: PlayerState): boolean {
  const r = p.hole.map(rankOf);
  return r.some((x, i) => r.indexOf(x) !== i);
}

function suited(p: PlayerState): boolean {
  return p.hole.length >= 2 && p.hole.every((c) => suitOf(c) === suitOf(p.hole[0]));
}

/** 연결 고리: 보는 사람에게 보이는 보드와 숫자가 같은 홀카드 수 */
function linkCount(state: GameState, p: PlayerState, asker: PlayerState): number {
  const ranks = new Set(visibleBoard(state, asker).filter((c): c is Card => !!c).map(rankOf));
  return p.hole.filter((c) => ranks.has(rankOf(c))).length;
}

/**
 * 정보형 증강 결과를 사용자에게 전달한다.
 * 포커페이스 → 역정보(가짜 결과)·거울·역추적·공개 청문회 → 사용자 노트 → 도청 순서.
 */
export function deliverInfo(ctx: Ctx, t: PlayerState, kind: InfoKind, noteKind: NoteKind): void {
  const { state, owner } = ctx;
  const name = INFO_NAME[kind];
  if (POKER_FACE.includes(kind) && findAug(t, 'pokerFace')) {
    note(state, owner, noteKind, `${name}: ${t.name} — 정보 없음`, undefined, t.id);
    return;
  }
  const fake = exposeInfo(ctx, t, kind) && FAKEABLE.includes(kind);
  const res = fake ? fakeInfo(state, t, kind, owner) : infoAbout(state, t, kind, owner, ctx.pick);
  note(state, owner, noteKind, `${name}: ${t.name}${res.text}`, res.cards, t.id);
  // 도청: 같은 결과와 사용한 사람 (대상이 포커페이스면 잡히지 않음)
  if (findAug(t, 'pokerFace')) return;
  for (const w of state.players) {
    if (w === owner || w === t || !active(w) || !findAug(w, 'wiretap')) continue;
    countUse(state, 'wiretap');
    note(state, w, 'info', `도청: ${owner.name}이(가) ${t.name}에게 「${name}」 — ${t.name}${res.text}`, res.cards, t.id);
  }
}

/** 정보 통행료: 결과 확인 전에 사용자가 2BB를 내고 진행할지 고른다. 응답을 기다리게 되면 true (결과는 응답 뒤) */
export function infoGate(ctx: Ctx, params: ActiveParams, t: PlayerState): boolean {
  const { state, owner, aug } = ctx;
  if (ctx.tollPaid || t === owner || AUGMENTS[aug.id].category !== '정보형') return false;
  const toll = findAug(t, 'infoToll');
  if (!toll || (toll.usesLeft ?? 0) <= 0 || state.respond) return false;
  toll.usesLeft = (toll.usesLeft ?? 0) - 1;
  // 누가 확인하려 했는지는 당사자 둘만 안다
  revealPassive({ ...ctx, owner: t, aug: toll }, '— 통행료 요구');
  ctx.ops.startRespond({ kind: 'offer', augment: 'infoToll', ownerId: t.id, participants: [owner.id], params: { targetId: owner.id, extra: { augment: aug.id, params } }, seconds: 10 });
  return true;
}

/** 선택적 노출: 투시처럼 무작위 1장을 확인할 때 대상이 보여 줄 카드를 고른다. 응답을 기다리게 되면 true */
function selectGate(ctx: Ctx, params: ActiveParams, t: PlayerState): boolean {
  const { state, owner } = ctx;
  if (ctx.pick !== undefined || t === owner) return false;
  const sr = findAug(t, 'selectiveReveal');
  if (!sr || (sr.usesLeft ?? 0) <= 0 || state.respond || t.hole.length < 2) return false;
  sr.usesLeft = (sr.usesLeft ?? 0) - 1;
  countUse(state, 'selectiveReveal');
  ctx.ops.startRespond({ kind: 'collect', augment: 'selectiveReveal', ownerId: t.id, participants: [t.id], params: { targetId: owner.id, extra: { params } }, seconds: 10 });
  return true;
}

/** 응답이 끝난 뒤 원래 정보형 증강을 이어서 처리 */
function rerunInfo(ctx: Ctx, looker: PlayerState, augment: AugmentId, params: ActiveParams, pick?: number): void {
  const aug = findAug(looker, augment);
  if (!aug || !ACTIVE[augment]) return;
  const decl = { immune: [] } as unknown as Declaration;
  ACTIVE[augment]!.resolve({ state: ctx.state, ops: ctx.ops, owner: looker, aug, tollPaid: true, ...(pick !== undefined ? { pick } : {}) }, params, decl);
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

/** 면역으로 빠진 사람 표시 */
function immuneText(state: GameState, ids: string[], what = '효과에서 빠짐'): string {
  return ids.length ? ` (면역: ${ids.map((id) => nameOf(state, id)).join(', ')} ${what})` : '';
}

const SUIT_NAME: Record<string, string> = { s: '♠ 스페이드', h: '♥ 하트', d: '♦ 다이아몬드', c: '♣ 클로버' };
const SUITS = ['s', 'h', 'd', 'c'] as const;

/** 턴과 리버 사이: 다음에 나올 턴 카드와 리버 첫 카드의 보드 위치 */
function turnRiverIdx(state: GameState): number[] {
  return [state.boardRevealed, Math.min(state.board.length, state.revealPlan[1] + state.extraCards)];
}

function realMade(state: GameState, p: PlayerState): boolean {
  return isMadeHand(p.hole, evalBoard(state), rulesFor(p));
}

// ───────────────────────── 4차 공개형 공통 ─────────────────────────

/** 홀카드를 1장씩 내는 공개형의 참가자: 핸드에 남은 사람 중 면역으로 빠진 사람, 방탄조끼로 막은 사람 제외 */
function cardJoiners(ctx: Ctx, decl: Declaration, vest: boolean): PlayerState[] {
  return ctx.state.players.filter((p) => {
    if (!live(p) || !p.hole.length || decl.immune.includes(p.id)) return false;
    if (vest && p !== ctx.owner && blocksForcedFold(ctx, p)) return false;
    return true;
  });
}

/** 홀카드 1장 고르기 응답 (시간 초과면 무작위) */
const pickHoleRespond = {
  error: (_ctx: Ctx, _r: RespondState, p: PlayerState, a: RespondAnswer) => (validHoleIndex(p, a.cardIndex) ? null : '홀카드를 고르세요.'),
  fallback: (ctx: Ctx, _r: RespondState, p: PlayerState): RespondAnswer => ({ cardIndex: ctx.state.rng.int(Math.max(1, p.hole.length)) }),
};

/** 카드가 다른 사람 손으로 옮겨 가면 공개 표시·이마 카드 표시를 정리한다 */
function cardLeft(p: PlayerState, c: Card): void {
  p.exposed = p.exposed.filter((x) => x !== c);
  if (p.forehead === c) p.forehead = null;
}

/** 베팅 라운드가 시작되고 아무도 행동하기 전 */
function roundFresh(ctx: Ctx): string | null {
  const { state } = ctx;
  if (basePhase(state) !== 'betting') return '베팅 라운드 중에만 쓸 수 있습니다.';
  if (state.round.actions > 0) return '베팅 라운드가 시작되고 아무도 행동하기 전에만 선언할 수 있습니다.';
  return needLive(ctx);
}

// ───────────────────────── 연승 (폭주기관차·연승 수당 공용 카운터) ─────────────────────────

/** 핸드가 끝날 때 한 번만 연승을 센다. 연승 수당은 모든 팟 승리, 폭주기관차만 가졌으면 최종 팟 5BB 이상 */
function updateStreak(ctx: Ctx, result: HandResult): void {
  const { state, owner } = ctx;
  if (!active(owner) || owner.streakHand === result.hand) return;
  owner.streakHand = result.hand;
  const total = result.pots.reduce((s, p) => s + p.amount, 0);
  const won = (result.won[owner.id] ?? 0) > 0;
  const bonus = findAug(owner, 'winBonus');
  const counts = won && (!!bonus || total >= 5 * bbOf(state));
  owner.streak = counts ? owner.streak + 1 : 0;
  if (!counts) return;
  if (owner.streak >= 2) addLog(state, `연승: ${owner.name} ${owner.streak}연승`);
  // 연승 수당: 2연승 1BB, 3연승 2BB … 를 이번 핸드에 나에게 진 상대들이 나눠 낸다
  if (bonus && owner.streak >= 2) {
    const losers = state.players.filter((p) => p !== owner && p.inHand && (result.won[p.id] ?? 0) <= 0 && p.chips > 0);
    if (!losers.length) return;
    const amount = (owner.streak - 1) * bbOf(state);
    const share = Math.floor(amount / losers.length);
    let got = 0;
    for (const p of losers) got += transfer(state, p, owner, share);
    const text = `${owner.name}: 연승 수당 ${owner.streak}연승 — ${got}칩`;
    result.extras.push(text);
    revealPassive({ ...ctx, aug: bonus }, `— ${owner.streak}연승, ${got}칩을 진 상대들에게서`);
  }
}

// ───────────────────────── 증강 이동 (증강 셔플·대출 몰수·사냥꾼) ─────────────────────────

/** 증강 하나를 다른 사람에게 넘긴다 (남은 횟수 그대로, 받은 사람만 앎) */
export function moveAugment(from: PlayerState, to: PlayerState, aug: OwnedAugment): void {
  from.augments = from.augments.filter((a) => a !== aug);
  aug.revealed = false;
  aug.publicId = null;
  aug.hidden = false;
  aug.armed = aug.id === 'exemption' ? false : aug.armed;
  to.augments.push(aug);
}

/** 증강 셔플: ring 의 각자가 무작위 증강 1개를 왼쪽(다음 자리) 사람에게. 보유 규칙에 맞는 조합을 고른다 */
function shuffleAugments(state: GameState, ring: PlayerState[]): boolean {
  if (ring.length < 2) return false;
  const next = (i: number) => ring[(i + 1) % ring.length];
  let best: (OwnedAugment | null)[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    const out = ring.map((p) => (p.augments.length ? pickOne(p.augments, state.rng) : null));
    // 받는 사람이 (자기가 넘긴 것을 뺀) 보유 증강과 함께 가질 수 있는가
    const okFor = (i: number) => {
      const g = out[i];
      if (!g) return true;
      const r = next(i);
      const ri = (i + 1) % ring.length;
      const keeps = r.augments.filter((a) => a !== out[ri]).map((a) => a.id);
      return canHold(keeps, g.id);
    };
    const valid = out.map((g, i) => (okFor(i) ? g : null));
    if (valid.filter(Boolean).length > best.filter(Boolean).length) best = valid;
    if (out.every((_, i) => okFor(i))) break;
  }
  if (!best.some(Boolean)) return false;
  best.forEach((g, i) => {
    if (!g) return;
    const from = ring[i];
    const to = next(i);
    moveAugment(from, to, g);
    note(state, from, 'augment', `증강 셔플: ${AUGMENTS[g.id].name}을(를) ${to.name}에게 넘겼습니다`);
    note(state, to, 'augment', `증강 셔플: ${from.name}에게서 ${AUGMENTS[g.id].name}을(를) 받았습니다 (남은 횟수 ${g.usesLeft ?? '-'})`);
  });
  return true;
}

/** 다 쓴 ★·★★ 액티브 증강 중 무작위 1개를 1회 충전 (사냥꾼·재충전) */
export function rechargeable(p: PlayerState, maxStars: number): OwnedAugment[] {
  return p.augments.filter((a) => {
    const d = AUGMENTS[a.id];
    return isActiveAugment(a.id) && d.stars <= maxStars && d.uses?.per === 'game' && (a.usesLeft ?? 0) <= 0;
  });
}

// ───────────────────────── 연금술 ─────────────────────────

/** 숫자를 한 단계 올리거나(1) 내린(0) 카드 (무늬 유지, A와 2는 이어지지 않음) */
export function alchemyTarget(c: Card, up: number): Card | null {
  const r = rankOf(c) + (up ? 1 : -1);
  if (r < 2 || r > 14) return null;
  return `${'23456789TJQKA'[r - 2]}${suitOf(c)}` as Card;
}

/** viewer 가 볼 수 있는 공개된 카드 (보드·공개된 홀카드·경매·명추리·청문회 등) */
function publicSeen(state: GameState, viewer: PlayerState): Card[] {
  return [
    ...visibleBoard(state, viewer).filter((c): c is Card => !!c),
    ...publicCards(state),
    ...state.used.filter((u) => u.kind === 'shown' || u.kind === 'called').map((u) => u.card),
    ...state.players.flatMap((p) => [...p.shepherdShown, ...(p.alchemy ? [p.alchemy.from, p.alchemy.to] : [])]),
    ...(state.auctionCard && !boardBlind(state, viewer) ? [state.auctionCard] : []),
  ];
}

/** 프리플랍, 내 첫 행동 전 (교환 진열대·봉인 봉투·선불 교환·미끼 공개) */
function preflopBeforeAct(ctx: Ctx): string | null {
  const { state, owner } = ctx;
  if (basePhase(state) !== 'betting' || state.street !== 'preflop') return '프리플랍에만 쓸 수 있습니다.';
  if (!live(owner) || owner.actedPreflop) return '프리플랍 내 첫 행동 전에만 쓸 수 있습니다.';
  return null;
}

/** 이번 핸드에 쓰인 번 카드 (재활용) */
function usedBurns(state: GameState): Card[] {
  return state.used.filter((u) => u.kind === 'burn').map((u) => u.card);
}

/** 후보 카드와 홀카드 바꾸기 응답 검증 (choice -1 = 바꾸지 않음) */
function swapPickError(p: PlayerState, a: RespondAnswer, n: number): string | null {
  if (a.choice === -1) return null;
  if (!isInt(a.choice) || a.choice < 0 || a.choice >= n) return '후보 카드를 고르세요.';
  return validHoleIndex(p, a.cardIndex) ? null : '바꿀 홀카드를 고르세요.';
}

// ───────────────────────── 제안·응답 공통 ─────────────────────────

function bbOf(state: GameState): number {
  return currentBlinds(state).bb;
}

function respondBusy(state: GameState): string | null {
  return state.respond ? '다른 제안·입찰이 진행 중입니다.' : null;
}

/** 칩을 옮긴다 (to 가 null 이면 은행). 모자라면 있는 만큼. 핸드 중 칩이 0이 되면 올인 */
export function transfer(state: GameState, from: PlayerState, to: PlayerState | null, amount: number): number {
  const amt = Math.max(0, Math.min(amount, from.chips));
  from.chips -= amt;
  if (to) to.chips += amt;
  else state.stats.bankPaid += amt;
  if (from.chips === 0 && amt > 0 && live(from)) {
    from.allIn = true;
    from.wentAllIn = true;
  }
  return amt;
}

/** 입찰금을 팟(데드 머니)에 넣는다 */
function payToPot(state: GameState, p: PlayerState, amount: number): number {
  const amt = transfer(state, p, null, amount);
  state.stats.bankPaid -= amt;
  state.deadMoney += amt;
  return amt;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** 입찰 검증: 0(불참) 또는 1BB 이상 내 칩까지 */
function bidError(state: GameState, p: PlayerState, bid: unknown): string | null {
  if (!isInt(bid) || bid < 0) return '입찰가를 올바르게 정하세요.';
  if (bid === 0) return null;
  if (bid < bbOf(state)) return `입찰가는 0(불참) 또는 ${bbOf(state)} 이상이어야 합니다.`;
  if (bid > p.chips) return '보유 칩보다 많이 입찰할 수 없습니다.';
  return null;
}

/** 최고 입찰자 (동점이면 무작위) */
function topBidder(state: GameState, r: RespondState): { p: PlayerState; bid: number } | null {
  let best = 0;
  let ids: string[] = [];
  for (const id of r.participants) {
    const b = r.answers[id]?.bid ?? 0;
    const p = playerById(state, id);
    if (!p || !live(p) || b <= 0 || b > p.chips) continue;
    if (b > best) {
      best = b;
      ids = [id];
    } else if (b === best) ids.push(id);
  }
  if (!ids.length) return null;
  return { p: playerById(state, pickOne(ids, state.rng))!, bid: best };
}

/** 입찰 참여자: 핸드에 남아 1BB 이상 있고 보드를 볼 수 있는 사람 */
function bidders(state: GameState, needHole: boolean): string[] {
  return state.players.filter((p) => live(p) && p.chips >= bbOf(state) && !boardBlind(state, p) && (!needHole || p.hole.length > 0)).map((p) => p.id);
}

const truthNames = [...CATEGORY_NAMES.slice(0, 7), '포카드 이상'];

/** 명추리: 선언자가 이미 아는 대상의 카드 (공개 카드·내 정보 기록·양치기 소년·경매 카드) */
export function knownCardsFor(state: GameState, owner: PlayerState, target: PlayerState): Card[] {
  const out = new Set<Card>([...owner.hole, ...publicCards(state), ...target.shepherdShown]);
  for (const c of visibleBoard(state, owner)) if (c) out.add(c);
  if (state.auctionCard) out.add(state.auctionCard);
  for (const n of owner.notes) if (n.hand === state.handNumber && n.targetId === target.id) for (const c of n.cards ?? []) out.add(c);
  return [...out];
}

/** 명추리 대상이 될 수 있는가: 이미 내가 홀카드를 모두 아는 상대는 안 된다 */
function knownTargetError(state: GameState, owner: PlayerState, t: PlayerState): string | null {
  // 내가 아는 정보만으로 판단한다 (진짜 카드와 비교하지 않음 — 역정보 여부가 드러나지 않게)
  const about = new Set<Card>(t.shepherdShown);
  if (holeVisible(state, t, owner)) for (const c of t.hole) about.add(c);
  for (const n of owner.notes) if (n.hand === state.handNumber && n.targetId === t.id) for (const c of n.cards ?? []) about.add(c);
  return about.size >= t.hole.length ? `${t.name}의 홀카드는 이미 모두 알고 있어 지목할 수 없습니다.` : null;
}

const yesNo = (v: unknown) => (typeof v === 'boolean' ? null : '수락 여부를 정하세요.');

// ───────────────────────── 액티브 효과 ─────────────────────────

export const ACTIVE: Partial<Record<AugmentId, ActiveEffect>> = {
  thermal: {
    check: opponentInHand,
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      if (infoGate(ctx, params, t)) return;
      deliverInfo(ctx, t, 'thermal', 'thermal');
    },
  },

  clairvoyance: {
    check: opponentInHand,
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      if (infoGate(ctx, params, t) || selectGate(ctx, params, t)) return;
      deliverInfo(ctx, t, 'clairvoyance', 'clairvoyance');
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
      if (infoGate(ctx, params, t)) return;
      deliverInfo(ctx, t, 'liedetector', 'liedetector');
    },
  },

  foresight: {
    check(ctx) {
      const err = needLive(ctx) ?? needSight(ctx);
      if (err) return err;
      const { state, owner } = ctx;
      if ((state.street !== 'flop' && state.street !== 'turn') || state.boardRevealed >= state.board.length) return '플랍 이후, 리버가 나오기 전에만 쓸 수 있습니다.';
      if (owner.foreseen.includes(state.boardRevealed)) return '이미 다음 카드를 보았습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const bi = state.boardRevealed;
      const card = state.board[bi];
      owner.foreseen.push(bi);
      note(state, owner, 'foresight', `예지: 다음 보드 카드(${state.street === 'flop' ? '턴' : '리버'})는 ${cardToken(card)}`, [card]);
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
      if (infoGate(ctx, params, t)) return;
      deliverInfo(ctx, t, 'inquiry', 'inquiry');
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
      const blind = ownCardsHidden(state, owner);
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
      const blind = ownCardsHidden(state, owner);
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
      if (basePhase(state) !== 'declare' || (state.windowStage !== 'turn' && state.windowStage !== 'river')) return '턴·리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (!state.deck.length) return '덱에 남은 카드가 없습니다.';
      if (state.fixedIdx.includes(state.boardRevealed - 1)) return '예약·확정된 카드는 되감을 수 없습니다.';
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
      const label = state.street === 'turn' ? '턴' : '리버';
      const blind = boardBlindIds(state);
      addLog(state, `되감기: ${label} ${cardToken(old)} 버림 → 새 카드 ${cardToken(fresh)}`, blind.length ? { except: blind } : {});
      if (blind.length) addLog(state, `되감기: ${label} 카드가 바뀌었습니다`, { to: blind });
    },
  },

  seal: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'river') return '리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      const bi = params.boardIndex;
      if (typeof bi !== 'number' || !Number.isInteger(bi) || bi < 0 || bi >= state.boardRevealed) return '봉인할 보드 카드를 고르세요.';
      if (state.effects.sealed.includes(bi)) return '이미 봉인된 카드입니다.';
      if (state.effects.sealed.length >= 2) return '한 핸드에 보드 카드는 2장까지만 봉인할 수 있습니다.';
      return null;
    },
    resolve(ctx, params) {
      const { state } = ctx;
      const bi = params.boardIndex!;
      state.effects.sealed.push(bi);
      const card = state.board[bi];
      const blind = boardBlindIds(state);
      const fog = state.effects.fogSeers.filter((id) => !blind.includes(id));
      const foggedIdx = bi < flopCount(state) && state.effects.fogSeers.length > 0 && !state.effects.fogLifted;
      if (blind.length && !foggedIdx) {
        addLog(state, `봉인: 보드 ${bi + 1}번째 카드가 이번 핸드 족보 계산에서 빠집니다`, { to: blind });
        addLog(state, `봉인: ${cardToken(card)}가 이번 핸드 족보 계산에서 빠집니다`, { except: blind });
      } else if (foggedIdx) {
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
      if (!ctx.stolen && (!live(owner) || !owner.allIn || owner.streetBet <= 0)) return '리버에서 내가 올인한 뒤에만 쓸 수 있습니다.';
      const t = targetOf(ctx, params);
      if (!t || !live(t) || t.allIn) return '핸드에 남아 있는 상대를 고르세요.';
      const wall = targetable(t);
      if (wall) return wall;
      if (!ctx.stolen && t.chips + t.streetBet <= owner.streetBet) return '나보다 칩이 많은 상대만 지목할 수 있습니다.';
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
    resolve(ctx, _params, decl) {
      ctx.state.blackoutNext = true;
      ctx.state.blackoutBy = ctx.owner.id;
      ctx.state.blackoutImmuneNext = [...decl.immune];
      addLog(ctx.state, `암전: 다음 핸드는 모두 자기 홀카드를 보지 못한 채 진행합니다${immuneText(ctx.state, decl.immune)}`);
    },
  },

  glassTable: {
    check: (ctx) => (handInProgress(ctx.state) ? null : '핸드가 진행 중일 때만 쓸 수 있습니다.'),
    resolve(ctx, _params, decl) {
      ctx.state.effects.glass = true;
      ctx.state.effects.glassImmune = [...decl.immune];
      addLog(ctx.state, `유리 테이블: 이번 핸드는 모든 홀카드를 공개한 채 진행합니다${immuneText(ctx.state, decl.immune)}`);
    },
  },

  russianRoulette: {
    check(ctx) {
      if (!handInProgress(ctx.state)) return '핸드가 진행 중일 때만 쓸 수 있습니다.';
      if (ctx.state.players.filter(live).length < 3) return '폴드하지 않은 사람이 3명 이상일 때만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx, _params, decl) {
      const { state, ops } = ctx;
      const pool = state.players.filter((p) => live(p) && !decl.immune.includes(p.id));
      if (!pool.length) {
        addLog(state, '러시안 룰렛: 추첨할 사람이 없습니다');
        return;
      }
      const victim = pickOne(pool, state.rng);
      addLog(state, `러시안 룰렛: ${victim.name}에게 당첨!${immuneText(state, decl.immune, '추첨 제외')}`);
      if (blocksForcedFold(ctx, victim)) return;
      ops.fold(victim, true);
    },
  },

  flipTable: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'river') return '리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx) {
      const e = ctx.state.effects;
      e.flips++;
      addLog(ctx.state, invertedNow(ctx.state) ? '밥상 뒤집기: 이번 핸드는 족보가 역전되어 가장 낮은 패가 승리합니다' : '밥상 뒤집기: 족보 역전이 상쇄되어 원래 순위로 돌아갑니다');
    },
  },

  heavyFog: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.boardRevealed > 0) return '플랍이 깔리기 전(프리플랍)에만 선언할 수 있습니다.';
      if (!live(ctx.owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx, _params, decl) {
      const fog = ctx.state.effects.fogSeers;
      for (const id of [ctx.owner.id, ...decl.immune]) if (!fog.includes(id)) fog.push(id);
      addLog(ctx.state, `짙은 안개: 이번 플랍은 ${ctx.owner.name}만 보고, 다른 사람에게는 쇼다운 때 공개됩니다${immuneText(ctx.state, decl.immune, '플랍을 봄')}`);
    },
  },

  deathTax: {
    check: (ctx) => (ctx.state.taxers.includes(ctx.owner.id) ? '이미 선언했습니다.' : null),
    resolve(ctx, _params, decl) {
      const { state, owner } = ctx;
      state.taxers.push(owner.id);
      if (decl.immune.length) state.taxExempt[owner.id] = [...decl.immune];
      addLog(state, `죽음과 세금: 이제부터 게임이 끝날 때까지 ${owner.name}을(를) 뺀 모두가 액티브·공개형 증강을 쓸 때마다 은행에 1BB를 냅니다 (선언자 ${state.taxers.length}명)`);
    },
  },

  // ═════════════════════════ 2차 풀 ═════════════════════════

  thermometer: {
    check: opponentInHand,
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      if (infoGate(ctx, params, t)) return;
      deliverInfo(ctx, t, 'thermometer', 'thermometer');
    },
  },

  radar: {
    check(ctx, params) {
      const err = needLive(ctx) ?? needSight(ctx);
      if (err) return err;
      const bi = params.boardIndex;
      const vis = visibleBoard(ctx.state, ctx.owner);
      if (typeof bi !== 'number' || !Number.isInteger(bi) || !vis[bi]) return '내가 볼 수 있는 보드 카드를 고르세요.';
      return null;
    },
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const card = state.board[params.boardIndex!];
      const r = rankOf(card);
      const n = state.players.filter((p) => p !== owner && live(p) && p.hole.some((c) => rankOf(c) === r)).length;
      note(state, owner, 'radar', `레이더: ${cardToken(card)}와 같은 숫자(${rankName(r)})의 홀카드를 가진 상대 ${n}명`, [card]);
    },
  },

  colorForecast: {
    check(ctx) {
      const err = needLive(ctx) ?? needSight(ctx);
      if (err) return err;
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || (state.street !== 'flop' && state.street !== 'turn')) return '플랍·턴 베팅 라운드에서만 쓸 수 있습니다.';
      if (state.toAct !== idxOf(state, owner.id)) return '내 차례(행동 전)에만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const card = state.board[state.boardRevealed];
      note(state, owner, 'forecast', `색채 예보: 다음 보드 카드(${state.street === 'flop' ? '턴' : '리버'})의 무늬는 ${SUIT_NAME[suitOf(card)]}`);
    },
  },

  leaderboard: {
    check(ctx) {
      const err = needLive(ctx) ?? needClearSight(ctx);
      if (err) return err;
      if (ctx.state.boardRevealed < 4) return '턴이 공개된 뒤에만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx) {
      const { rank, of } = standingOf(ctx.state, ctx.owner);
      note(ctx.state, ctx.owner, 'leaderboard', `순위표: 남은 ${of}명 중 ${rank}등`);
    },
  },

  destinyDraw: {
    // 다른 사람이 가져온 카드인지는 서버만 안다: 미리 알려 주지 않도록 반응 대기 후 적용할 때 확인한다
    check(ctx, params, atResolve) {
      const err = betweenHandsCheck(ctx);
      if (err) return err;
      const { state, owner } = ctx;
      if (owner.destinyCard) return '이미 다음 핸드 카드를 골랐습니다.';
      const c = params.card;
      if (!isCard(c)) return '받을 카드를 고르세요.';
      if (owner.keptCard === c || owner.lockerStored === c) return '이미 내가 가져가는 카드입니다.';
      if (atResolve && state.players.some((p) => p !== owner && (p.keptCard === c || p.lockerStored === c || p.destinyCard === c))) return '다른 사람이 가져온 카드라 고를 수 없습니다.';
      if (state.nextHand.freezeCard === c) return '동결된 카드는 고를 수 없습니다.';
      return null;
    },
    resolve(ctx, params) {
      ctx.owner.destinyCard = params.card!;
      note(ctx.state, ctx.owner, 'info', `데스티니 드로우: 다음 핸드에 ${cardToken(params.card!)}을(를) 홀카드로 받습니다.`, [params.card!]);
    },
  },

  blindDraw: {
    check(ctx, params) {
      const err = needLive(ctx);
      if (err) return err;
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.boardRevealed < 4) return '턴 공개 이후 베팅 라운드에서만 쓸 수 있습니다.';
      if (!ownCardsHidden(state, owner) && !validHoleIndex(owner, params.cardIndex)) return '버릴 카드를 고르세요.';
      if (!state.deck.length) return '덱에 남은 카드가 없습니다.';
      return null;
    },
    detail: () => '— 홀카드 1장을 덱 맨 위 카드로 교체',
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const hidden = ownCardsHidden(state, owner);
      const ci = hidden || !validHoleIndex(owner, params.cardIndex) ? state.rng.int(owner.hole.length) : params.cardIndex!;
      const old = owner.hole[ci];
      const fresh = state.deck.shift()!;
      owner.hole[ci] = fresh;
      owner.discarded.push(old);
      state.used.push({ card: old, kind: 'discard' });
      if (hidden) note(state, owner, 'info', '블라인드 드로우: 암전 중이라 무작위 1장을 교체했습니다.');
      else note(state, owner, 'info', `블라인드 드로우: ${cardToken(old)} → ${cardToken(fresh)}`, [old, fresh]);
    },
  },

  eitherOr: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'flop') return '플랍 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      const err = needSight(ctx);
      if (err) return err;
      if (state.players.some((p) => p.eitherOr)) return '이번 턴은 이미 양자택일 중입니다.';
      if (state.fixedIdx.includes(state.boardRevealed)) return '다음 카드는 이미 확정된 카드입니다.';
      if (!state.deck.length) return '덱에 남은 카드가 없습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const cards = [state.board[state.boardRevealed], state.deck.shift()!];
      owner.eitherOr = { cards, pick: null };
      note(state, owner, 'info', `양자택일: 턴 후보 ${cardsText(cards)} — 턴이 공개되기 전에 하나를 고르세요 (고르지 않으면 첫 번째)`, cards);
    },
  },

  lastFork: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'river') return '리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (!ownCardsHidden(state, owner) && !validHoleIndex(owner, params.cardIndex)) return '버릴 카드를 고르세요.';
      if (!state.deck.length) return '덱에 남은 카드가 없습니다.';
      return null;
    },
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const ci = validHoleIndex(owner, params.cardIndex) ? params.cardIndex! : state.rng.int(owner.hole.length);
      const old = owner.hole[ci];
      const fresh = state.deck.shift()!;
      owner.hole[ci] = fresh;
      state.used.push({ card: old, kind: 'shown' });
      addLog(state, `마지막 갈림길: ${owner.name}이(가) 홀카드 ${cardToken(old)}을(를) 공개하고 버린 뒤 새 카드 1장을 받았습니다`);
      if (ownCardsHidden(state, owner)) note(state, owner, 'info', '마지막 갈림길: 새 카드를 받았습니다 (암전 중)');
      else note(state, owner, 'info', `마지막 갈림길: 새 카드 ${cardToken(fresh)}`, [fresh]);
    },
  },

  blackjack: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'river') return '리버 공개 직후(리버 베팅 전)에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      const err = needSight(ctx);
      if (err) return err;
      if (owner.blackjackOn) return '이미 발동했습니다.';
      if (!blackjackCards([...owner.hole, ...evalBoard(state)])) return '지금 카드로는 21을 만들 수 없습니다.';
      return null;
    },
    resolve(ctx) {
      ctx.owner.blackjackOn = true;
      const bj = blackjackCards([...ctx.owner.hole, ...evalBoard(ctx.state)])!;
      note(ctx.state, ctx.owner, 'info', `블랙잭: ${cardsText(bj)} = 21 — 가장 낮은 풀하우스와 동급으로 인정됩니다 (원래 족보가 더 높으면 원래 족보)`, bj);
    },
  },

  circuitBreaker: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.toAct !== idxOf(state, owner.id)) return '내 차례에만 선언할 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (state.round.raiseCap !== null) return '이미 다시 시작한 라운드입니다.';
      if (state.round.raises < 3) return `이번 라운드 레이즈가 3번 이상이어야 합니다 (지금 ${state.round.raises}번).`;
      return null;
    },
    resolve: (ctx) => ctx.ops.restartRound(),
  },

  bet: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.effects.bomb) return '프리플랍에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (owner.actedPreflop) return '프리플랍 내 첫 행동 전에만 쓸 수 있습니다.';
      const c = params.choice;
      if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > 7) return '예측할 족보 종류를 고르세요.';
      return null;
    },
    resolve(ctx, params) {
      const names = ['하이카드', '원페어', '투페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드 이상'];
      ctx.owner.betPrediction = params.choice!;
      note(ctx.state, ctx.owner, 'bet', `내기할래?: 이번 핸드 우승 족보를 「${names[params.choice!]}」(으)로 예측했습니다.`);
    },
  },

  rumor: {
    check(ctx, params) {
      if (!active(ctx.owner)) return '게임에 참여하고 있지 않습니다.';
      return isAugmentId(params.augment) ? null : '소문낼 증강을 고르세요.';
    },
    detail: (_ctx, p) => (p.augment ? `— 「${AUGMENTS[p.augment].name}」` : ''),
    resolve(ctx, params) {
      addLog(ctx.state, `📢 소문: 이 테이블 누군가 「${AUGMENTS[params.augment!].name}」 증강을 가지고 있다`);
    },
  },

  ironWall: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop') return '핸드 시작 시(프리플랍)에만 선언할 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (owner.actedPreflop) return '프리플랍 내 첫 행동 전에만 선언할 수 있습니다.';
      if (owner.ironWall) return '이미 선언했습니다.';
      return null;
    },
    resolve(ctx) {
      ctx.owner.ironWall = true;
      addLog(ctx.state, `철벽: ${ctx.owner.name}은(는) 이번 핸드 동안 지목형 증강의 대상이 될 수 없습니다`);
    },
  },

  padlock: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting') return '베팅 라운드 중에만 쓸 수 있습니다.';
      if (state.round.locked) return '이미 잠긴 라운드입니다.';
      if (state.round.actions > 0) return '베팅 라운드가 시작되고 아무도 행동하기 전에만 선언할 수 있습니다.';
      if (!active(ctx.owner)) return '게임에 참여하고 있지 않습니다.';
      return null;
    },
    resolve(ctx) {
      ctx.state.round.locked = true;
      addLog(ctx.state, '자물쇠: 이번 베팅 라운드 동안 모두 액티브·공개형 증강을 쓸 수 없습니다 (카운터 스펠 포함)');
    },
  },

  bombPot: {
    check(ctx) {
      return betweenHandsCheck(ctx) ?? (ctx.state.bombNext ? '이미 다음 핸드가 폭탄 팟입니다.' : null);
    },
    resolve(ctx) {
      ctx.state.bombNext = true;
      addLog(ctx.state, `폭탄 팟: 다음 핸드는 블라인드 대신 전원이 3BB를 내고 바로 플랍부터 시작합니다`);
    },
  },

  underdog: {
    check: betweenHandsCheck,
    resolve(ctx) {
      ctx.state.underdogLeft += 3;
      addLog(ctx.state, '언더독: 다음 핸드부터 3핸드 동안 족보 순위가 뒤바뀌어 가장 낮은 패가 승리합니다');
    },
  },

  blindDart: {
    check(ctx, params) {
      const err = preflopMyTurn(ctx);
      if (err) return err;
      const t = targetOf(ctx, params);
      if (!t || !live(t)) return '핸드에 남아 있는 상대를 고르세요.';
      return targetable(t);
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params, decl) {
      const { state } = ctx;
      const t = targetOf(ctx, params)!;
      if (decl.immune.includes(t.id)) return addLog(state, `실명 다트: ${t.name}이(가) 면역으로 막았습니다`);
      if (t.ironWall) return addLog(state, `실명 다트: ${t.name}의 철벽에 막혔습니다`);
      state.effects.blindDarted.push(t.id);
      addLog(state, `실명 다트: ${t.name}은(는) 이번 핸드 동안 보드를 볼 수 없습니다 (쇼다운 때 공개)`);
    },
  },

  getOut: {
    check(ctx, params) {
      const err = preflopMyTurn(ctx);
      if (err) return err;
      if (ctx.state.players.filter(live).length < 3) return '핸드에 3명 이상 남아 있을 때만 쓸 수 있습니다.';
      const t = targetOf(ctx, params);
      if (!t || !live(t)) return '핸드에 남아 있는 상대를 고르세요.';
      return targetable(t);
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params, decl) {
      const { state, ops } = ctx;
      const t = targetOf(ctx, params)!;
      if (decl.immune.includes(t.id)) return addLog(state, `너 나가: ${t.name}이(가) 면역으로 막았습니다`);
      if (t.ironWall) return addLog(state, `너 나가: ${t.name}의 철벽에 막혔습니다`);
      addLog(state, `너 나가: ${t.name}을(를) 이번 핸드에서 내보냅니다`);
      if (blocksForcedFold(ctx, t)) return;
      ops.fold(t, true);
    },
  },

  highCardDuel: {
    check: preflopMyTurn,
    resolve: (ctx) => ctx.ops.highCardDuel(),
  },

  restart: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.toAct !== idxOf(state, owner.id)) return '쇼다운 전, 베팅 중 내 차례에만 선언할 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (state.effects.restarted) return '다시 시작한 핸드에서는 쓸 수 없습니다.';
      return null;
    },
    resolve: (ctx) => ctx.ops.restartHand(ctx.owner),
  },

  // ═════════════════════════ 3차 풀: 시야·시간 ═════════════════════════

  glasses: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.round.actions > 0) return '프리플랍 베팅이 시작되기 전(아무도 행동하기 전)에만 선언할 수 있습니다.';
      if (!live(ctx.owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx, _params, decl) {
      const e = ctx.state.effects;
      if (!e.glasses.includes(ctx.owner.id)) e.glasses.push(ctx.owner.id);
      for (const id of decl.immune) if (!e.glassesImmune.includes(id)) e.glassesImmune.push(id);
      if (!e.glassesSeq) e.glassesSeq = ctx.state.logSeq + 1;
      addLog(ctx.state, `안경 없어서 잘 안보여: 이번 핸드 동안 ${ctx.owner.name}을(를) 뺀 모두에게 보드 무늬가 안 보이고 금액은 대략값으로 보입니다${immuneText(ctx.state, decl.immune, '또렷하게 봄')}`);
    },
  },

  heaven: {
    check: (ctx) => (active(ctx.owner) ? null : '게임에 참여하고 있지 않습니다.'),
    resolve(ctx, _params, decl) {
      const { state, owner } = ctx;
      state.heaven.push({ by: owner.id, startHand: state.handNumber, immune: [...decl.immune] });
      addLog(state, `메이드 인 헤븐: 다음 핸드부터 ${owner.name}을(를) 뺀 모두의 행동 시간이 매 핸드 5초씩 줄어듭니다 (최소 5초, 다음 블라인드 레벨까지)${immuneText(state, decl.immune, '원래 시간 유지')}`);
    },
  },

  // ═════════════════════════ 3차 풀: 보드·팟 구조 ═════════════════════════

  plusOne: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'river') return '리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (state.board.length >= 7 || state.deck.length < (state.board2 ? 2 : 1)) return '보드를 더 늘릴 수 없습니다.';
      return null;
    },
    resolve: (ctx) => ctx.ops.addBoardCard('플러스 원'),
  },

  capitalism: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'flop') return '플랍 공개 후 플랍 베팅 라운드에서만 선언할 수 있습니다.';
      if (state.effects.capitalism) return '이미 자본주의가 걸려 있습니다.';
      return needLive(ctx);
    },
    resolve(ctx) {
      ctx.state.effects.capitalism = true;
      addLog(ctx.state, '자본주의: 플랍·턴 베팅 라운드가 끝날 때마다 가장 크게 베팅·레이즈한 사람이 보드 카드를 1장 더 깔지 정합니다');
    },
  },

  reverseRiver: {
    check: (ctx) => betweenHandsCheck(ctx) ?? (ctx.state.nextHand.reverse ? '이미 다음 핸드에 걸려 있습니다.' : null),
    resolve(ctx) {
      ctx.state.nextHand.reverse = true;
      addLog(ctx.state, '거꾸로 강을 거슬러: 다음 핸드는 보드가 1장 → 1장 → 3장 순서로 공개됩니다');
    },
  },

  doubleBoard: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.boardRevealed > 0) return '플랍이 깔리기 전(프리플랍)에만 선언할 수 있습니다.';
      if (state.board2) return '이미 보드가 2세트입니다.';
      if (state.deck.length < state.board.length) return '덱에 남은 카드가 부족합니다.';
      return needLive(ctx);
    },
    resolve(ctx) {
      const { state } = ctx;
      state.board2 = state.deck.splice(0, state.board.length);
      addLog(state, '더블 보드: 보드를 2세트 깔고, 각 보드의 승자가 팟을 절반씩 나눕니다');
    },
  },

  twoFates: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'turn') return '턴 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (state.board2) return '이미 보드가 2세트입니다.';
      if (state.players.filter(live).length < 2 || state.players.filter(canAct).length > 1) return '남은 플레이어가 모두 올인해 더 베팅할 수 없을 때만 쓸 수 있습니다.';
      if (state.deck.length < state.board.length - state.boardRevealed) return '덱에 남은 카드가 부족합니다.';
      return null;
    },
    resolve(ctx) {
      const { state } = ctx;
      state.board2 = [...state.board.slice(0, state.boardRevealed), ...state.deck.splice(0, state.board.length - state.boardRevealed)];
      state.effects.twoFates = true;
      addLog(state, '두 번의 운명: 리버를 두 번 따로 뽑아 각 결과에 팟의 절반을 배정합니다');
    },
  },

  prophecy: {
    check: (ctx) => betweenHandsCheck(ctx) ?? (ctx.state.nextHand.prophecy ? '이미 다음 핸드에 걸려 있습니다.' : null),
    resolve(ctx) {
      ctx.state.nextHand.prophecy = true;
      addLog(ctx.state, '미리 온 결말: 다음 핸드 시작 때 덱에서 1장을 공개해 리버로 예약합니다');
    },
  },

  turnRiver: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'flop') return '플랍 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      const err = needSight(ctx);
      if (err) return err;
      const [a, b] = turnRiverIdx(state);
      if (b >= state.board.length) return '남은 보드 카드가 부족합니다.';
      if (state.fixedIdx.includes(a) || state.fixedIdx.includes(b) || state.players.some((p) => p.eitherOr || p.turnRiver)) return '턴·리버 카드가 이미 확정되어 있습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const idx = turnRiverIdx(state);
      const cards = idx.map((i) => state.board[i]);
      owner.turnRiver = { idx, cards, swap: null };
      for (const i of idx) state.fixedIdx.push(i);
      note(state, owner, 'info', `턴과 리버 사이: 턴 ${cardToken(cards[0])}, 리버 ${cardToken(cards[1])} — 순서를 바꿀지 정하세요 (정하지 않으면 그대로)`, cards);
    },
  },

  highLow: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.boardRevealed > 0) return '플랍이 깔리기 전(프리플랍)에만 선언할 수 있습니다.';
      if (state.effects.highLow) return '이미 하이로우입니다.';
      return needLive(ctx);
    },
    resolve(ctx) {
      ctx.state.effects.highLow = true;
      addLog(ctx.state, '하이로우: 이번 팟은 가장 높은 패와 가장 낮은 패가 반씩 나눕니다');
    },
  },

  freeze: {
    check(ctx, params, atResolve) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'handEnd' || !state.result) return '핸드가 끝난 뒤(결과 화면)에만 쓸 수 있습니다.';
      if (!active(owner)) return '게임에 참여하고 있지 않습니다.';
      const bi = params.boardIndex;
      const board = state.result.board;
      if (typeof bi !== 'number' || !Number.isInteger(bi) || bi < 0 || bi >= board.length) return '공개된 보드 카드를 고르세요.';
      const c = board[bi];
      if (state.nextHand.freezeCard) return '이미 동결된 카드가 있습니다.';
      if (atResolve && state.players.some((p) => p.keptCard === c || p.lockerStored === c || p.destinyCard === c)) return '다른 효과가 이미 가져가는 카드입니다.';
      return null;
    },
    detail: (ctx, p) => `— ${typeof p.boardIndex === 'number' && ctx.state.result ? cardToken(ctx.state.result.board[p.boardIndex]) : ''}`,
    resolve(ctx, params) {
      const c = ctx.state.result!.board[params.boardIndex!];
      ctx.state.nextHand.freezeCard = c;
      addLog(ctx.state, `동결: ${cardToken(c)}이(가) 다음 핸드 플랍에 반드시 포함됩니다`);
    },
  },

  magnet: {
    check(ctx, params) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'flop') return '플랍 공개 후 플랍 베팅 라운드에서만 쓸 수 있습니다.';
      if (state.effects.magnet) return '이미 자석이 걸려 있습니다.';
      const c = params.choice;
      if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > 3) return '무늬를 고르세요.';
      return needLive(ctx);
    },
    detail: (_ctx, p) => `— ${SUIT_NAME[SUITS[p.choice ?? 0]]}`,
    resolve(ctx, params) {
      const suit = SUITS[params.choice!];
      ctx.state.effects.magnet = { suit, used: false };
      addLog(ctx.state, `자석: ${SUIT_NAME[suit]} — 턴·리버에서 이 무늬가 아닌 카드가 처음 나오면 버리고 다시 뽑습니다`);
    },
  },

  swapBoard: {
    check(ctx, params) {
      const err = needLive(ctx);
      if (err) return err;
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || (state.street !== 'turn' && state.street !== 'river')) return '턴 공개 이후 베팅 라운드에서만 쓸 수 있습니다.';
      if (!validHoleIndex(owner, params.cardIndex)) return '바꿀 내 홀카드를 고르세요.';
      const bi = params.boardIndex;
      if (typeof bi !== 'number' || !Number.isInteger(bi) || bi < 0 || bi >= state.boardRevealed) return '바꿀 보드 카드를 고르세요.';
      return null;
    },
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const ci = params.cardIndex!;
      const bi = params.boardIndex!;
      const mine = owner.hole[ci];
      const boardCard = state.board[bi];
      owner.hole[ci] = boardCard;
      state.board[bi] = mine;
      // 보드로 나간 카드는 이마·공개 표시가 풀리고, 손에 들어온 보드 카드는 모두가 본 카드
      cardLeft(owner, mine);
      if (!state.effects.fogSeers.length && !state.effects.blindDarted.length) state.used.push({ card: boardCard, kind: 'shown' });
      logBoard(state, `맞바꾸기: ${owner.name}이(가) 홀카드 ${cardToken(mine)}와(과) 보드 ${cardToken(boardCard)}를 바꿨습니다`, `맞바꾸기: ${owner.name}이(가) 홀카드 1장과 보드 ${bi + 1}번째 카드를 바꿨습니다`, false);
    },
  },

  lastStand: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop') return '프리플랍에만 선언할 수 있습니다.';
      if (!live(owner) || owner.actedPreflop) return '프리플랍 내 첫 행동 전에만 선언할 수 있습니다.';
      if (state.effects.lastStand) return '이미 배수진입니다.';
      return null;
    },
    resolve(ctx, _params, decl) {
      ctx.state.effects.lastStand = true;
      ctx.state.effects.lastStandImmune = [...decl.immune];
      addLog(ctx.state, `배수진: 이번 핸드는 모두 폴드할 수 없고 체크·콜만 할 수 있습니다${immuneText(ctx.state, decl.immune, '폴드 가능')}`);
    },
  },

  sidePotBreaker: {
    check(ctx) {
      const { state, owner } = ctx;
      const r = state.result;
      if (basePhase(state) !== 'handEnd' || !r || !r.showdown) return '쇼다운이 끝난 뒤(결과 화면)에만 쓸 수 있습니다.';
      if (!owner.wentAllIn) return '내가 올인한 핸드에서만 쓸 수 있습니다.';
      if (!r.pots[0]?.winners.includes(owner.id)) return '메인 팟을 이겼을 때만 쓸 수 있습니다.';
      if (!r.pots.some((p, k) => k > 0 && !p.eligible.includes(owner.id) && p.amount > 0)) return '다른 플레이어들끼리 쌓은 사이드팟이 없습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const r = state.result!;
      let total = 0;
      for (const [k, pot] of r.pots.entries()) {
        if (k === 0 || pot.eligible.includes(owner.id)) continue;
        const take = Math.floor(pot.amount * 0.3);
        const each = Math.floor(take / pot.winners.length);
        pot.winners.forEach((id, i) => {
          const w = playerById(state, id)!;
          const amt = Math.min(w.chips, each + (i === 0 ? take - each * pot.winners.length : 0));
          w.chips -= amt;
          r.won[id] = (r.won[id] ?? 0) - amt;
          total += amt;
        });
      }
      owner.chips += total;
      r.won[owner.id] = (r.won[owner.id] ?? 0) + total;
      const text = `${owner.name}: 사이드 팟 브레이커 — 사이드팟의 30%인 ${total}칩을 가져옴`;
      r.extras.push(text);
      addLog(state, text);
    },
  },

  // ═════════════════════════ 3차 풀: 제안·응답 ═════════════════════════

  pickMe: {
    check(ctx, params) {
      const err = opponentInHand(ctx, params);
      if (err) return err;
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || (state.street !== 'flop' && state.street !== 'turn')) return '플랍·턴 베팅 라운드에서만 쓸 수 있습니다.';
      if (state.toAct !== idxOf(state, owner.id)) return '내 차례(행동 전)에만 쓸 수 있습니다.';
      if (!validHoleIndex(owner, params.cardIndex)) return '보여 줄 내 홀카드를 고르세요.';
      return respondBusy(state);
    },
    detail: (ctx, p) => `— ${nameOf(ctx.state, p.targetId ?? '')}에게 제안`,
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const t = targetOf(ctx, params)!;
      const card = owner.hole[params.cardIndex!];
      ctx.ops.startRespond({ kind: 'offer', augment: 'pickMe', ownerId: owner.id, participants: [t.id], params: { targetId: t.id, cardIndex: params.cardIndex, card } });
      if (!ownCardsHidden(state, owner)) addLog(state, `골라 봐: ${t.name}에게 보여 줄 카드 ${cardToken(card)}`, { to: [owner.id] });
    },
    respond: {
      error: (_ctx, _r, _p, a) => yesNo(a.accept),
      // 시간 초과는 거절
      fallback: () => ({ accept: false }),
      done(ctx, r) {
        const { state, owner } = ctx;
        const t = playerById(state, r.params.targetId)!;
        if (!r.answers[t.id]?.accept || !live(t) || !live(owner)) {
          addLog(state, `골라 봐: ${t.name}이(가) 제안을 거절했습니다`);
          return false;
        }
        const card = owner.hole.includes(r.params.card!) ? r.params.card! : owner.hole[r.params.cardIndex ?? 0];
        const paid = transfer(state, t, owner, 3 * bbOf(state));
        addLog(state, `골라 봐: ${t.name}이(가) 수락 — ${owner.name}에게 ${paid}칩을 내고 홀카드 1장을 봅니다`);
        note(state, t, 'info', `골라 봐: ${owner.name}의 홀카드 중 1장은 ${cardToken(card)}`, [card], owner.id);
        return false;
      },
    },
  },

  jointTransfer: {
    check(ctx, params) {
      const { state } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'flop') return '플랍 공개 직후 선언 기회에만 쓸 수 있습니다.';
      return opponentInHand(ctx, params) ?? respondBusy(state);
    },
    detail: (ctx, p) => `— ${nameOf(ctx.state, p.targetId ?? '')}에게 교환 제안`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      ctx.ops.startRespond({ kind: 'offer', augment: 'jointTransfer', ownerId: ctx.owner.id, participants: [t.id], params: { targetId: t.id } });
    },
    respond: {
      error(_ctx, r, p, a) {
        if (r.stage === 'offer') return yesNo(a.accept);
        return validHoleIndex(p, a.cardIndex) ? null : '건넬 홀카드를 고르세요.';
      },
      fallback: (ctx, r, p) => (r.stage === 'offer' ? { accept: false } : { cardIndex: ctx.state.rng.int(Math.max(1, p.hole.length)) }),
      done(ctx, r) {
        const { state, owner } = ctx;
        const t = playerById(state, r.params.targetId)!;
        if (r.stage === 'offer') {
          if (!r.answers[t.id]?.accept || !live(t) || !live(owner)) {
            addLog(state, `공동 환승: ${t.name}이(가) 교환을 거절했습니다`);
            return false;
          }
          addLog(state, `공동 환승: ${t.name}이(가) 수락 — 두 사람이 홀카드 1장씩을 비공개로 골라 맞바꿉니다`);
          r.stage = 'pick';
          r.participants = [owner.id, t.id];
          r.answers = {};
          return true;
        }
        if (!live(t) || !live(owner)) {
          addLog(state, '공동 환승: 한 사람이 핸드를 떠나 교환이 취소되었습니다');
          return false;
        }
        const ia = r.answers[owner.id]?.cardIndex ?? 0;
        const ib = r.answers[t.id]?.cardIndex ?? 0;
        const give = owner.hole[ia];
        const get = t.hole[ib];
        owner.hole[ia] = get;
        t.hole[ib] = give;
        note(state, owner, 'info', `공동 환승: ${cardToken(give)}을(를) 주고 ${cardToken(get)}을(를) 받았습니다`, [give, get], t.id);
        note(state, t, 'info', `공동 환승: ${cardToken(get)}을(를) 주고 ${cardToken(give)}을(를) 받았습니다`, [get, give], owner.id);
        addLog(state, `공동 환승: ${owner.name}와(과) ${t.name}이(가) 홀카드 1장씩을 맞바꿨습니다`);
        return false;
      },
    },
  },

  loanShark: {
    check(ctx, params) {
      const { state, owner } = ctx;
      const b = basePhase(state);
      if (b !== 'betting' && b !== 'discard' && b !== 'declare' && b !== 'handEnd') return '핸드 진행 중이나 핸드 결과 화면에서 쓸 수 있습니다.';
      if (!active(owner)) return '게임에 참여하고 있지 않습니다.';
      const t = targetOf(ctx, params);
      if (!t || !active(t)) return '빌려줄 상대를 고르세요.';
      if (owner.chips < 5 * bbOf(state)) return `빌려줄 칩(${5 * bbOf(state)})이 부족합니다.`;
      return respondBusy(state);
    },
    detail: (ctx, p) => `— ${nameOf(ctx.state, p.targetId ?? '')}에게 제안`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      ctx.ops.startRespond({ kind: 'offer', augment: 'loanShark', ownerId: ctx.owner.id, participants: [t.id], params: { targetId: t.id } });
    },
    respond: {
      error: (_ctx, _r, _p, a) => yesNo(a.accept),
      fallback: () => ({ accept: false }),
      done(ctx, r) {
        const { state, owner } = ctx;
        const t = playerById(state, r.params.targetId)!;
        if (!r.answers[t.id]?.accept || !active(t) || !active(owner)) {
          addLog(state, `사채업자: ${t.name}이(가) 제안을 거절했습니다`);
          return false;
        }
        const bb = bbOf(state);
        const lent = transfer(state, owner, t, 5 * bb);
        if (t.chips > 0 && !t.wentAllIn) t.allIn = false;
        // 2핸드 뒤 상환 (핸드 사이에 빌렸으면 다음 핸드부터 센다)
        const due = state.handNumber + (basePhase(state) === 'handEnd' ? 3 : 2);
        state.tasks.push({ kind: 'sharkRepay', playerId: t.id, otherId: owner.id, dueHand: due, amount: 7 * bb });
        addLog(state, `사채업자: ${t.name}이(가) ${owner.name}에게서 ${lent}칩을 빌렸습니다 (핸드 #${due} 시작 전에 ${7 * bb}칩 상환)`);
        return false;
      },
    },
  },

  infoAuction: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'flop') return '플랍 공개 후 플랍 베팅 라운드에서만 선언할 수 있습니다.';
      if (state.boardRevealed >= state.board.length) return '남은 보드 카드가 없습니다.';
      if (state.players.some((p) => p.eitherOr || p.turnRiver)) return '턴 카드가 이미 다른 효과로 정해지는 중입니다.';
      return needLive(ctx) ?? respondBusy(state);
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const ids = bidders(state, false);
      if (!ids.length) {
        addLog(state, '정보 경매: 입찰할 수 있는 사람이 없습니다');
        return;
      }
      addLog(state, `정보 경매: 턴 카드를 미리 볼 권리를 비공개로 입찰합니다 (0 = 불참, 최소 ${bbOf(state)})`);
      ctx.ops.startRespond({ kind: 'collect', augment: 'infoAuction', ownerId: owner.id, participants: ids, params: {} });
    },
    respond: {
      error: (ctx, _r, p, a) => bidError(ctx.state, p, a.bid),
      fallback: () => ({ bid: 0 }),
      done(ctx, r) {
        const { state } = ctx;
        const top = topBidder(state, r);
        if (!top) {
          addLog(state, '정보 경매: 입찰자가 없어 유찰되었습니다');
          return false;
        }
        const paid = payToPot(state, top.p, top.bid);
        const i = state.boardRevealed;
        const card = state.board[i];
        // 본 카드가 그대로 나오도록 고정 (자석·되감기 등으로 바뀌지 않음)
        if (!state.fixedIdx.includes(i)) state.fixedIdx.push(i);
        addLog(state, `정보 경매: ${top.p.name}이(가) ${paid}칩에 낙찰 (낙찰금은 팟으로)`);
        if (maskFor(state, top.p).suits) note(state, top.p, 'info', `정보 경매: 다음 보드 카드는 ${rankName(rankOf(card))} (무늬는 안 보임)`, undefined);
        else note(state, top.p, 'info', `정보 경매: 다음 보드 카드는 ${cardToken(card)}`, [card]);
        return false;
      },
    },
  },

  cardAuction: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'flop') return '플랍 공개 후 플랍 베팅 라운드에서만 선언할 수 있습니다.';
      if (state.auctionCard) return '이번 핸드에는 이미 카드 경매가 열렸습니다.';
      if (!state.deck.length) return '덱에 남은 카드가 없습니다.';
      return needLive(ctx) ?? respondBusy(state);
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const card = state.deck.shift()!;
      state.auctionCard = card;
      logBoard(state, `카드 경매: ${cardToken(card)} — 비공개로 입찰하세요 (0 = 불참, 최소 ${bbOf(state)})`, '카드 경매: 덱에서 1장이 공개되었습니다 (보드를 볼 수 없음)', false);
      const ids = bidders(state, true);
      if (!ids.length) {
        state.used.push({ card, kind: 'shown' });
        addLog(state, '카드 경매: 입찰할 수 있는 사람이 없습니다');
        return;
      }
      ctx.ops.startRespond({ kind: 'collect', augment: 'cardAuction', ownerId: owner.id, participants: ids, params: { card } });
    },
    respond: {
      error(ctx, _r, p, a) {
        const err = bidError(ctx.state, p, a.bid);
        if (err) return err;
        if (a.bid && a.cardIndex !== undefined && !validHoleIndex(p, a.cardIndex)) return '바꿀 홀카드를 고르세요.';
        return null;
      },
      fallback: () => ({ bid: 0 }),
      done(ctx, r) {
        const { state } = ctx;
        const card = r.params.card!;
        const top = topBidder(state, r);
        if (!top) {
          state.used.push({ card, kind: 'shown' });
          addLog(state, '카드 경매: 입찰자가 없어 유찰되었습니다');
          return false;
        }
        const w = top.p;
        const paid = payToPot(state, w, top.bid);
        const ci = r.answers[w.id]?.cardIndex;
        const idx = validHoleIndex(w, ci) ? ci : state.rng.int(w.hole.length);
        const old = w.hole[idx];
        w.hole[idx] = card;
        w.discarded.push(old);
        state.used.push({ card: old, kind: 'discard' });
        addLog(state, `카드 경매: ${w.name}이(가) ${paid}칩에 낙찰 — 공개된 카드를 홀카드 1장과 바꿨습니다 (낙찰금은 팟으로)`);
        note(state, w, 'info', `카드 경매: ${cardToken(old)}을(를) 버리고 ${cardToken(card)}을(를) 받았습니다`, [old, card]);
        return false;
      },
    },
  },

  truthGame: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'river') return '리버 베팅 라운드에서만 쓸 수 있습니다.';
      if (state.toAct !== idxOf(state, owner.id) || !live(owner)) return '내 차례에만 쓸 수 있습니다.';
      if (owner.truthClaim !== null) return '이미 선언했습니다.';
      const c = params.choice;
      return isInt(c) && c >= 0 && c <= 7 ? null : '족보 종류를 고르세요.';
    },
    detail: (_ctx, p) => `— "내 패는 ${truthNames[p.choice ?? 0]} 이상"`,
    resolve(ctx, params) {
      ctx.owner.truthClaim = params.choice!;
    },
  },

  staredown: {
    check(ctx, params) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'river') return '리버 베팅 라운드에서만 쓸 수 있습니다.';
      const err = opponentInHand(ctx, params);
      if (err) return err;
      if (state.staredown) return '이번 핸드에는 이미 눈싸움이 있었습니다.';
      return targetable(targetOf(ctx, params)!) ?? respondBusy(state);
    },
    detail: (ctx, p) => `— ${nameOf(ctx.state, p.targetId ?? '')}와(과) 눈싸움`,
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const t = targetOf(ctx, params)!;
      addLog(state, `눈싸움: ${owner.name}와(과) ${t.name}이(가) 상대보다 "강함/약함"을 동시에 비공개로 선언합니다`);
      ctx.ops.startRespond({ kind: 'collect', augment: 'staredown', ownerId: owner.id, participants: [owner.id, t.id], params: { targetId: t.id } });
    },
    respond: {
      error: (_ctx, _r, _p, a) => (a.choice === 0 || a.choice === 1 ? null : '"강함" 또는 "약함"을 고르세요.'),
      fallback: (ctx) => ({ choice: ctx.state.rng.int(2) }),
      done(ctx, r) {
        const { state, owner } = ctx;
        const t = playerById(state, r.params.targetId)!;
        const claims: Record<string, number> = { [owner.id]: r.answers[owner.id]?.choice ?? 0, [t.id]: r.answers[t.id]?.choice ?? 0 };
        state.staredown = { a: owner.id, b: t.id, claims };
        for (const p of [owner, t]) addLog(state, `눈싸움: 내 선언은 "${claims[p.id] ? '강함' : '약함'}" (쇼다운 때 공개)`, { to: [p.id] });
        addLog(state, '눈싸움: 두 사람 모두 선언을 마쳤습니다 (둘 다 쇼다운에 가면 공개)');
        return false;
      },
    },
  },

  sealedContract: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'river') return '리버 베팅 라운드에서만 쓸 수 있습니다.';
      if (state.toAct !== idxOf(state, owner.id) || !live(owner)) return '내 차례(베팅·레이즈 직전)에만 쓸 수 있습니다.';
      if (owner.contract !== null) return '이미 계약했습니다.';
      return params.choice === 0 || params.choice === 1 ? null : '"전원 폴드" 또는 "한 명 이상 콜"을 고르세요.';
    },
    // 고른 내용은 비공개: 공개 로그에는 계약 사실만
    resolve(ctx, params) {
      const { state, owner } = ctx;
      owner.contract = params.choice!;
      addLog(state, `밀봉 계약: 내 예측은 "${params.choice ? '한 명 이상 콜' : '전원 폴드'}" (핸드가 끝나면 공개)`, { to: [owner.id] });
    },
  },

  nameIt: {
    check(ctx, params, atResolve) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'preShowdown') return '리버 베팅이 끝난 뒤 쇼다운 직전 선언 기회에만 쓸 수 있습니다.';
      const err = opponentInHand(ctx, params);
      if (err) return err;
      const t = targetOf(ctx, params)!;
      if (state.nameItWinner) return '이미 명추리가 성공했습니다.';
      if (!isCard(params.card)) return '부를 카드를 고르세요.';
      // 대상 지목 가능 여부는 선언 시점에만 (반응 대기 중 바뀐 정보로 거절하지 않음)
      return targetable(t) ?? (atResolve ? null : knownTargetError(state, owner, t));
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const t = targetOf(ctx, params)!;
      const card = params.card!;
      const known = knownCardsFor(state, owner, t).includes(card);
      if (!known && t.hole.includes(card)) {
        state.nameItWinner = owner.id;
        // 맞힌 카드는 모두에게 공개된다
        state.used.push({ card, kind: 'called' });
        addLog(state, `명추리 성공: ${owner.name}이(가) ${t.name}의 홀카드 ${cardToken(card)}을(를) 맞혔습니다 — 참여할 수 있는 팟을 모두 가져갑니다`);
        return;
      }
      const paid = transfer(state, owner, t, 2 * bbOf(state));
      // 틀린 카드는 다른 사람의 카드일 수 있으므로 공개하지 않는다
      addLog(state, `명추리 실패: ${owner.name}이(가) 부른 카드는 ${known ? '이미 알려진 카드라 인정되지 않습니다' : `${t.name}의 카드가 아닙니다`} — 폴드하고 ${t.name}에게 ${paid}칩을 냅니다`);
      ctx.ops.fold(owner, false);
    },
  },

  // ═════════════════════════ 3차 풀: 좌석·증강 흐름 ═════════════════════════

  augShuffle: {
    check: (ctx) => betweenHandsCheck(ctx) ?? (ctx.state.players.filter(active).length < 2 ? '넘길 사람이 없습니다.' : null),
    resolve(ctx, _params, decl) {
      const { state } = ctx;
      // 면역으로 빠진 사람은 주고받지 않는다
      const ring = state.players.filter((p) => active(p) && !decl.immune.includes(p.id));
      const moved = shuffleAugments(state, ring);
      addLog(state, `증강 셔플: ${moved ? '모두 보유 증강 1개씩을 왼쪽 사람에게 넘겼습니다' : '넘길 수 있는 증강이 없습니다'}${immuneText(state, decl.immune, '주고받지 않음')}`);
    },
  },

  loan: {
    check(ctx) {
      const { state, owner } = ctx;
      if (state.phase === 'gameOver' || !active(owner)) return '게임에 참여하고 있지 않습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const bb = bbOf(state);
      owner.chips += 20 * bb;
      state.stats.bankChips += 20 * bb;
      const due = state.handNumber + (handInProgress(state) ? 5 : 6);
      state.tasks.push({ kind: 'loanRepay', playerId: owner.id, dueHand: due, amount: 25 * bb });
      addLog(state, `대출: ${owner.name}이(가) 은행에서 ${20 * bb}칩을 빌렸습니다 (핸드 #${due} 시작 전에 ${25 * bb}칩 상환)`);
    },
  },

  // ═════════════════════════ 3차 풀: 판정 공유·팀·탈취 ═════════════════════════

  destinyTeam: {
    check(ctx, params) {
      const { state, owner } = ctx;
      const err = betweenHandsCheck(ctx);
      if (err) return err;
      if (state.players.filter(active).length < 4) return '4명 이상 남았을 때만 쓸 수 있습니다.';
      if (state.teamsNext) return '다음 핸드의 팀이 이미 정해져 있습니다.';
      const t = targetOf(ctx, params);
      if (!t || !active(t) || t === owner) return '짝을 고르세요.';
      return null;
    },
    detail: (ctx, p) => `— 짝: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params, decl) {
      const { state, owner } = ctx;
      // 면역으로 빠진 사람은 혼자 플레이
      const pool = state.players.filter((p) => active(p) && !decl.immune.includes(p.id));
      const t = targetOf(ctx, params)!;
      const teams: string[][] = [];
      const rest = pool.filter((p) => p !== owner && p !== t);
      if (pool.includes(t)) teams.push([owner.id, t.id]);
      else rest.push(owner);
      const shuffled = [...rest];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      for (let i = 0; i + 1 < shuffled.length; i += 2) teams.push([shuffled[i].id, shuffled[i + 1].id]);
      state.teamsNext = teams;
      const names = teams.map((tm) => tm.map((id) => nameOf(state, id)).join(' & ')).join(', ');
      addLog(state, `운명 공동체: 다음 핸드는 팀전 — ${names} (팀원이 쇼다운에서 이기면 팟을 반씩)${immuneText(state, decl.immune, '혼자 플레이')}`);
    },
  },

  parasite: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'preShowdown') return '리버 베팅이 끝난 뒤 쇼다운 직전 선언 기회에만 쓸 수 있습니다.';
      const err = opponentInHand(ctx, params);
      if (err) return err;
      if (owner.parasite) return '이미 기생 중입니다.';
      return targetable(targetOf(ctx, params)!);
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      ctx.owner.parasite = t.id;
      addLog(ctx.state, `기생: ${ctx.owner.name}은(는) 이번 쇼다운에서 ${t.name}의 높은 홀카드 1장으로도 족보를 만들 수 있습니다`);
    },
  },

  promotion: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'river') return '리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      return owner.promoted ? '이미 승격했습니다.' : null;
    },
    resolve(ctx) {
      ctx.owner.promoted = true;
      addLog(ctx.state, `승격: ${ctx.owner.name}의 이번 핸드 족보를 한 단계 올려 판정합니다 (최대 풀하우스)`);
    },
  },

  alchemy: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'river') return '리버 공개 직후 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (owner.alchemy) return '이미 연금술을 썼습니다.';
      if (!validHoleIndex(owner, params.cardIndex)) return '바꿀 홀카드를 고르세요.';
      if (params.choice !== 0 && params.choice !== 1) return '올릴지 내릴지 고르세요.';
      const to = alchemyTarget(owner.hole[params.cardIndex], params.choice);
      if (!to) return 'A와 2는 이어지지 않습니다.';
      if (owner.hole.includes(to) || publicSeen(state, owner).includes(to)) return `${cardToken(to)}은(는) 공개된 카드와 같아 바꿀 수 없습니다.`;
      return null;
    },
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const from = owner.hole[params.cardIndex!];
      const to = alchemyTarget(from, params.choice!)!;
      owner.alchemy = { index: params.cardIndex!, from, to };
      addLog(state, `연금술: ${owner.name}의 홀카드 ${cardToken(from)}을(를) 이번 핸드 족보 계산에서 ${cardToken(to)}(으)로 바꿉니다`);
    },
  },

  // ═════════════════════════ 3차 풀: 확률·통계 ═════════════════════════

  fateThread: {
    check(ctx, params) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'flop') return '플랍 베팅 라운드에서만 쓸 수 있습니다.';
      return opponentInHand(ctx, params) ?? needSight(ctx);
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const t = targetOf(ctx, params)!;
      const eq = headsUpEquity(state, owner, t);
      note(state, owner, 'info', `운명의 실: ${t.name}와(과) 리버까지 둘이 맞붙으면 지금 내 승률은 ${(eq * 100).toFixed(1)}%`, undefined, t.id);
    },
  },

  // ═════════════════════════ 4차 풀: 정보형 ═════════════════════════

  reviewNote: {
    check(ctx, params) {
      const { state } = ctx;
      if (basePhase(state) !== 'handEnd' || !state.result) return '핸드가 끝난 뒤(결과 화면)에만 쓸 수 있습니다.';
      const t = targetOf(ctx, params);
      if (!t || !t.inHand || !t.hole.length) return '이번 핸드에 참여한 상대를 고르세요.';
      return null;
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const { state, owner, aug } = ctx;
      const t = targetOf(ctx, params)!;
      // 플랍 전에 폴드했다면 횟수는 소모하지 않는다 (포커페이스면 "정보 없음"으로 소모)
      if (state.flopCategory[t.id] === undefined && !findAug(t, 'pokerFace')) {
        aug.usesLeft = (aug.usesLeft ?? 0) + 1;
        note(state, owner, 'info', `복기 노트: ${t.name} — 플랍 전 폴드 (횟수 소모 없음)`, undefined, t.id);
        return;
      }
      if (infoGate(ctx, params, t)) return;
      deliverInfo(ctx, t, 'reviewNote', 'info');
    },
  },

  smell: {
    check: opponentInHand,
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      if (infoGate(ctx, params, t)) return;
      deliverInfo(ctx, t, 'smell', 'info');
    },
  },

  suitCheck: {
    check: opponentInHand,
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      if (infoGate(ctx, params, t)) return;
      deliverInfo(ctx, t, 'suitCheck', 'info');
    },
  },

  deadScanner: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'flop') return '프리플랍이 끝난 직후(플랍 공개 직후 선언 기회)에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      const c = params.choice;
      return isInt(c) && c >= 0 && c <= 16 ? null : '셀 숫자나 무늬를 고르세요.';
    },
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const c = params.choice!;
      const folded = state.used.filter((u) => u.kind === 'fold').map((u) => u.card);
      const match = (x: Card) => (c <= 12 ? rankOf(x) === c + 2 : suitOf(x) === SUITS[c - 13]);
      const what = c <= 12 ? rankName(c + 2) : SUIT_NAME[SUITS[c - 13]];
      note(state, owner, 'info', `데드 카드 스캐너: 폴드한 카드 중 ${what} — ${folded.filter(match).length}장 (폴드 카드 ${folded.length}장 중)`);
    },
  },

  ammoCheck: {
    check(ctx, params) {
      const t = targetOf(ctx, params);
      if (!t || !active(t)) return '대상을 고르세요.';
      return active(ctx.owner) ? null : '게임에 참여하고 있지 않습니다.';
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      if (infoGate(ctx, params, t)) return;
      deliverInfo(ctx, t, 'ammoCheck', 'info');
    },
  },

  blackBox: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'handEnd' || !state.result) return '핸드가 끝난 뒤(결과 화면)에만 쓸 수 있습니다.';
      if (!owner.inHand || !owner.hole.length) return '이번 핸드에 참여했을 때만 쓸 수 있습니다.';
      return null;
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const rest = state.board.slice(state.boardRevealed);
      const full = state.board.filter((_, i) => !state.effects.sealed.includes(i));
      // 핸드 종료 시점까지 남아 있던 사람과 나
      const field = state.players.filter((p) => p.inHand && p.hole.length && (!p.folded || p === owner));
      const inverted = invertedNow(state);
      const cs = field.map((p) => contenderFor(state, p, handEvalFor(state, p, full)));
      const best = cs.filter((a) => !cs.some((b) => b !== a && compareContenders(b, a, { inverted, board: full }).result > 0));
      const names = best.map((c) => (c.id === owner.id ? '나' : nameOf(state, c.id))).join(', ');
      note(state, owner, 'info', `블랙박스: 남은 보드 ${rest.length ? cardsText(rest) : '없음'} — 그대로 깔렸다면 1등: ${names}`, rest);
    },
  },

  link: {
    check(ctx, params) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || (state.street !== 'flop' && state.street !== 'turn')) return '플랍·턴 베팅 라운드에서만 쓸 수 있습니다.';
      return opponentInHand(ctx, params) ?? needSight(ctx);
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      if (infoGate(ctx, params, t)) return;
      deliverInfo(ctx, t, 'link', 'info');
    },
  },

  focus: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.boardRevealed > 0) return '플랍이 공개되기 전(프리플랍)에만 쓸 수 있습니다.';
      return needLive(ctx) ?? needSight(ctx);
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const flop = state.board.slice(0, flopCount(state)).map(rankOf);
      note(state, owner, 'info', `초점: 이번 플랍의 가장 높은 숫자 ${rankName(Math.max(...flop))}, 가장 낮은 숫자 ${rankName(Math.min(...flop))}`);
    },
  },

  // ═════════════════════════ 4차 풀: 카드 조작형 ═════════════════════════

  showcase: {
    check(ctx) {
      return preflopBeforeAct(ctx) ?? (ctx.state.deck.length < 2 ? '덱에 남은 카드가 부족합니다.' : respondBusy(ctx.state));
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const cards = state.deck.splice(0, 2);
      state.offerCards = cards;
      addLog(state, `교환 진열대: ${cardsText(cards)} — ${owner.name}이(가) 홀카드 1장과 바꿀지 고릅니다`);
      ctx.ops.startRespond({ kind: 'collect', augment: 'showcase', ownerId: owner.id, participants: [owner.id], params: {} });
    },
    respond: {
      error: (ctx, _r, p, a) => swapPickError(p, a, ctx.state.offerCards.length),
      fallback: () => ({ choice: -1 }),
      done(ctx, r) {
        const { state, owner } = ctx;
        const cards = state.offerCards;
        state.offerCards = [];
        const a = r.answers[owner.id];
        const pick = a?.choice ?? -1;
        if (pick < 0 || !live(owner)) {
          for (const c of cards) state.used.push({ card: c, kind: 'shown' });
          addLog(state, `교환 진열대: ${owner.name}이(가) 바꾸지 않았습니다`);
          return false;
        }
        const ci = a!.cardIndex!;
        const old = owner.hole[ci];
        owner.hole[ci] = cards[pick];
        owner.discarded.push(old);
        state.used.push({ card: old, kind: 'discard' });
        state.used.push({ card: cards[1 - pick], kind: 'shown' });
        // 가져간 카드는 모두가 본 카드 (이미 공개된 카드로 취급)
        owner.exposed.push(cards[pick]);
        addLog(state, `교환 진열대: ${owner.name}이(가) ${cardToken(cards[pick])}을(를) 가져가고 홀카드 1장을 버렸습니다`);
        note(state, owner, 'info', `교환 진열대: ${cardToken(old)} → ${cardToken(cards[pick])}`, [old, cards[pick]]);
        return false;
      },
    },
  },

  envelope: {
    check(ctx) {
      return preflopBeforeAct(ctx) ?? (ctx.state.deck.length ? null : '덱에 남은 카드가 없습니다.');
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      owner.envelope = state.deck.shift()!;
      note(state, owner, 'info', `봉인 봉투: 예비 카드 ${cardToken(owner.envelope)} — 플랍 라운드 동안 홀카드 1장과 바꾸거나 버립니다`, [owner.envelope]);
    },
  },

  prepay: {
    check(ctx, params) {
      const err = preflopBeforeAct(ctx);
      if (err) return err;
      if (ctx.owner.prepay) return '이미 선불 교환 중입니다.';
      if (ctx.owner.hole.length < 2) return '홀카드가 2장 이상일 때만 쓸 수 있습니다.';
      return validHoleIndex(ctx.owner, params.cardIndex) ? null : '버릴 홀카드를 고르세요.';
    },
    detail: () => '— 홀카드 1장 공개 후 버림',
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const [c] = owner.hole.splice(params.cardIndex!, 1);
      owner.discarded.push(c);
      state.used.push({ card: c, kind: 'shown' });
      owner.prepay = true;
      addLog(state, `선불 교환: ${owner.name}이(가) ${cardToken(c)}을(를) 버리고 홀카드 1장으로 프리플랍을 진행합니다 (플랍 직전에 1장 받음)`);
    },
  },

  coldStorage: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || (state.street !== 'flop' && state.street !== 'turn')) return '플랍·턴 베팅 라운드에서만 쓸 수 있습니다.';
      if (owner.frozen) return '이미 보관한 카드가 있습니다.';
      if (!state.deck.length) return '덱에 남은 카드가 없습니다.';
      return needLive(ctx) ?? (validHoleIndex(owner, params.cardIndex) ? null : '보관할 홀카드를 고르세요.');
    },
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const ci = params.cardIndex!;
      const old = owner.hole[ci];
      const fresh = state.deck.shift()!;
      owner.hole[ci] = fresh;
      owner.frozen = old;
      addLog(state, `냉동 보관: ${owner.name}이(가) 홀카드 1장을 보관하고 새 카드를 받았습니다`);
      note(state, owner, 'info', `냉동 보관: ${cardToken(old)} 보관, 새 카드 ${cardToken(fresh)} — 이후 원하는 핸드의 프리플랍 첫 행동 전에 꺼낼 수 있습니다`, [old, fresh]);
    },
  },

  recycle: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street === 'preflop') return '플랍 이후 베팅 라운드에서만 쓸 수 있습니다.';
      if (!usedBurns(state).length) return '확인할 번 카드가 없습니다.';
      return needLive(ctx) ?? respondBusy(state);
    },
    resolve(ctx) {
      const { state, owner } = ctx;
      const burns = usedBurns(state);
      note(state, owner, 'info', `재활용: 이번 핸드의 번 카드 ${cardsText(burns)}`, burns);
      ctx.ops.startRespond({ kind: 'collect', augment: 'recycle', ownerId: owner.id, participants: [owner.id], params: {} });
    },
    respond: {
      error: (ctx, _r, p, a) => swapPickError(p, a, usedBurns(ctx.state).length),
      fallback: () => ({ choice: -1 }),
      done(ctx, r) {
        const { state, owner } = ctx;
        const a = r.answers[owner.id];
        const burns = usedBurns(state);
        if (!a || (a.choice ?? -1) < 0 || !live(owner) || !burns[a.choice!]) {
          addLog(state, '재활용: 바꾸지 않았습니다', { to: [owner.id] });
          return false;
        }
        const take = burns[a.choice!];
        const ci = a.cardIndex!;
        const old = owner.hole[ci];
        owner.hole[ci] = take;
        // 번 카드는 내 손으로, 버린 카드는 덱으로 돌아가지 않는다
        state.used = state.used.filter((u) => !(u.kind === 'burn' && u.card === take));
        owner.discarded.push(old);
        state.used.push({ card: old, kind: 'discard' });
        addLog(state, `재활용: ${owner.name}이(가) 번 카드 1장을 홀카드와 바꿨습니다`);
        note(state, owner, 'info', `재활용: ${cardToken(old)} → ${cardToken(take)}`, [old, take]);
        return false;
      },
    },
  },

  pickpocket: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'preShowdown') return '쇼다운 직전 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      const t = targetOf(ctx, params);
      if (!t || !t.inHand || !t.folded || !t.hole.length || t.kicked) return '이번 핸드에 폴드한 플레이어를 고르세요.';
      return null;
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const t = targetOf(ctx, params)!;
      const mine = owner.hole;
      const theirs = t.hole;
      owner.hole = theirs;
      t.hole = mine;
      // 폴드한 카드 기록도 바뀐 카드로
      state.used = state.used.filter((u) => !(u.kind === 'fold' && theirs.includes(u.card)));
      for (const c of mine) state.used.push({ card: c, kind: 'fold' });
      addLog(state, `소매치기: ${owner.name}이(가) 폴드한 ${t.name}과(와) 홀카드를 통째로 바꿨습니다`);
      note(state, owner, 'info', `소매치기: ${cardsText(mine)} → ${cardsText(theirs)}`, [...mine, ...theirs], t.id);
      note(state, t, 'info', `소매치기: ${owner.name}이(가) 내 홀카드를 가져가고 ${cardsText(mine)}을(를) 남겼습니다`, [...mine], owner.id);
    },
  },

  // ═════════════════════════ 4차 풀: 경제/베팅형 ═════════════════════════

  reserveOrder: {
    check(ctx, params) {
      const err = preflopBeforeAct(ctx);
      if (err) return err;
      const c = params.choice;
      return isInt(c) && c >= 2 && c <= 14 ? null : '숫자를 고르세요.';
    },
    detail: (_ctx, p) => `— ${rankName(p.choice ?? 2)}`,
    resolve(ctx, params) {
      ctx.owner.reserveRank = params.choice!;
    },
  },

  wanted: {
    check(ctx, params) {
      const err = betweenHandsCheck(ctx);
      if (err) return err;
      const t = targetOf(ctx, params);
      if (!t || !active(t)) return '지목할 상대를 고르세요.';
      return ctx.owner.wantedNext ? '이미 지목했습니다.' : null;
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      ctx.owner.wantedNext = t.id;
      addLog(ctx.state, `현상수배: 다음 핸드에 ${ctx.owner.name}이(가) 쇼다운에서 ${t.name}을(를) 이기면 ${5 * bbOf(ctx.state)}칩을 추가로 받습니다`);
    },
  },

  nerveTest: {
    check(ctx, params) {
      const { state, owner } = ctx;
      const la = state.lastAggression;
      if (basePhase(state) !== 'betting' || state.street !== 'river') return '리버에서만 쓸 수 있습니다.';
      if (!la || la.seq !== state.betActionSeq || la.street !== 'river' || state.players[la.idx] !== owner) return '리버에서 내가 베팅·레이즈한 직후에만 쓸 수 있습니다.';
      return validHoleIndex(owner, params.cardIndex) ? null : '공개할 홀카드를 고르세요.';
    },
    // 반응 대기 중(카운터 가능)에는 어떤 카드인지 알리지 않는다
    detail: () => '— 홀카드 1장 공개',
    resolve(ctx, params) {
      const c = ctx.owner.hole[params.cardIndex!];
      if (c && !ctx.owner.exposed.includes(c)) ctx.owner.exposed.push(c);
      if (c) addLog(ctx.state, `${ctx.owner.name}: 홀카드 ${cardToken(c)} 공개`);
    },
  },

  sideBet: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (!handInProgress(state) || !owner.inHand || !owner.folded) return '내가 폴드한 핸드에서만 쓸 수 있습니다.';
      if (state.players.filter(live).length < 2) return '남은 플레이어가 2명 이상일 때만 쓸 수 있습니다.';
      if (owner.sideBetOn) return '이미 예측했습니다.';
      if (owner.chips < 2 * bbOf(state)) return `칩(${2 * bbOf(state)})이 부족합니다.`;
      const t = targetOf(ctx, params);
      return t && live(t) ? null : '이길 사람을 고르세요.';
    },
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const t = targetOf(ctx, params)!;
      const paid = Math.min(2 * bbOf(state), owner.chips);
      owner.chips -= paid;
      state.deadMoney += paid;
      owner.sideBetOn = t.id;
      addLog(state, `사이드 베팅: ${owner.name}이(가) ${paid}칩을 팟에 넣고 승자를 예측했습니다`);
      addLog(state, `사이드 베팅: 내 예측은 ${t.name}`, { to: [owner.id] });
    },
  },

  betCap: {
    check: (ctx) => betweenHandsCheck(ctx) ?? (ctx.owner.betCapNext ? '이미 다음 핸드에 걸어 두었습니다.' : null),
    resolve(ctx) {
      ctx.owner.betCapNext = true;
    },
  },

  straw: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (!handInProgress(state) || !owner.inHand || !owner.folded) return '내가 폴드한 뒤에만 쓸 수 있습니다.';
      if (state.players.filter(live).length < 2) return '핸드에 2명 이상 남아 있을 때만 쓸 수 있습니다.';
      if (owner.strawOn) return '이미 지목했습니다.';
      const t = targetOf(ctx, params);
      return t && live(t) ? null : '지목할 사람을 고르세요.';
    },
    resolve(ctx, params) {
      const t = targetOf(ctx, params)!;
      ctx.owner.strawOn = t.id;
      addLog(ctx.state, `빨대 꼽기: 내 지목은 ${t.name} (핸드가 끝나면 공개)`, { to: [ctx.owner.id] });
    },
  },

  cataclysm: {
    check: (ctx) => betweenHandsCheck(ctx) ?? (ctx.owner.augments.length < 2 ? '바꿀 증강이 없습니다.' : null),
    resolve(ctx) {
      const { state, owner } = ctx;
      const changes: string[] = [];
      const pool = poolSet(state);
      for (const old of [...owner.augments]) {
        if (old.id === 'cataclysm') continue;
        const from = AUGMENTS[old.id].stars;
        // ★ → ★★, ★★ → ★★★, ★★★ → 몰?루 상자(별부터 무작위)
        const stars = (from === 1 ? 2 : from === 2 ? 3 : 1 + state.rng.int(3)) as 1 | 2 | 3;
        // 지금 고르는 중인 선택지에 있는 증강도 피한다 (고른 뒤 겹치지 않게)
        const keep = [...owner.augments.filter((a) => a !== old).map((a) => a.id), ...(owner.pickOptions ?? [])];
        const id = rollOneAugment(stars, keep, state.rng, takenByOthers(state, owner), pool);
        if (!id) continue;
        const fresh = newOwnedAugment(state, id);
        // 잠복으로 숨긴 증강은 바뀐 뒤에도 숨김
        fresh.hidden = old.hidden;
        owner.augments[owner.augments.indexOf(old)] = fresh;
        state.stats.picks[id] = (state.stats.picks[id] ?? 0) + 1;
        changes.push(`${AUGMENTS[old.id].name} → ${AUGMENTS[id].name} ${'★'.repeat(AUGMENTS[id].stars)}${from === 3 ? ' (몰?루 상자)' : ''}`);
      }
      // 대격변은 쓰고 나면 사라진다
      owner.augments = owner.augments.filter((a) => a.id !== 'cataclysm');
      addLog(state, `대격변: ${owner.name}의 증강이 새 증강으로 바뀌었습니다`);
      note(state, owner, 'augment', `대격변: ${changes.join(', ') || '바뀐 증강 없음'}`);
    },
  },

  // ═════════════════════════ 4차 풀: 심리전형 ═════════════════════════

  bait: {
    check: (ctx, params) => preflopBeforeAct(ctx) ?? (validHoleIndex(ctx.owner, params.cardIndex) ? null : '공개할 홀카드를 고르세요.'),
    // 반응 대기 중(카운터 가능)에는 어떤 카드인지 알리지 않는다
    detail: () => '— 홀카드 1장 공개',
    resolve(ctx, params) {
      const c = ctx.owner.hole[params.cardIndex!];
      if (c && !ctx.owner.exposed.includes(c)) ctx.owner.exposed.push(c);
      if (c) addLog(ctx.state, `${ctx.owner.name}: 홀카드 ${cardToken(c)} 공개`);
      // 쇼다운 정산용 표시 (핸드가 시작되면 지워짐)
      ctx.aug.usedThisHand = true;
    },
  },

  // ═════════════════════════ 4차 풀: 공개형 ═════════════════════════

  indianPoker: {
    check: (ctx) => betweenHandsCheck(ctx) ?? (ctx.state.indianNext ? '이미 다음 핸드가 인디언 포커입니다.' : null),
    resolve(ctx, _params, decl) {
      ctx.state.indianNext = true;
      ctx.state.indianImmuneNext = [...decl.immune];
      addLog(ctx.state, `인디언 포커: 다음 핸드는 각자 홀카드 1장을 이마에 붙이고 진행합니다 (본인만 못 봄)${immuneText(ctx.state, decl.immune, '두 장 모두 봄')}`);
    },
  },

  dealerWhim: {
    check: (ctx) => betweenHandsCheck(ctx) ?? (ctx.state.whimLeft > 0 ? '이미 딜러의 변덕이 예약되어 있습니다.' : null),
    resolve(ctx) {
      ctx.state.whimLeft = 3;
      addLog(ctx.state, '딜러의 변덕: 다음 핸드부터 3핸드 동안 버튼·블라인드·베팅 순서가 반시계 방향으로 돕니다');
    },
  },

  commonWell: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street === 'preflop') return '플랍 이후 베팅 라운드에서만 쓸 수 있습니다.';
      return needLive(ctx) ?? respondBusy(state);
    },
    resolve(ctx, _params, decl) {
      const ids = cardJoiners(ctx, decl, true).map((p) => p.id);
      if (ids.length < 2) return addLog(ctx.state, `공동 우물: 카드를 낼 사람이 부족합니다${immuneText(ctx.state, decl.immune)}`);
      addLog(ctx.state, `공동 우물: ${ids.map((id) => nameOf(ctx.state, id)).join(', ')}이(가) 홀카드 1장씩 비공개로 골라 냅니다${immuneText(ctx.state, decl.immune)}`);
      ctx.ops.startRespond({ kind: 'collect', augment: 'commonWell', ownerId: ctx.owner.id, participants: ids, params: {} });
    },
    respond: {
      ...pickHoleRespond,
      done(ctx, r) {
        const { state } = ctx;
        const ps = r.participants.map((id) => playerById(state, id)!).filter((p) => live(p) && p.hole.length);
        const given = ps.map((p) => p.hole[Math.min(r.answers[p.id]?.cardIndex ?? 0, p.hole.length - 1)]);
        const mixed = shuffle([...given], state.rng);
        ps.forEach((p, k) => {
          const i = p.hole.indexOf(given[k]);
          cardLeft(p, given[k]);
          p.hole[i] = mixed[k];
          note(state, p, 'info', `공동 우물: ${cardToken(given[k])}을(를) 내고 ${cardToken(mixed[k])}을(를) 받았습니다`, [given[k], mixed[k]]);
        });
        addLog(state, '공동 우물: 낸 카드를 섞어 무작위로 다시 나눴습니다');
        return false;
      },
    },
  },

  catchThief: {
    check(ctx, params) {
      const err = roundFresh(ctx) ?? respondBusy(ctx.state);
      if (err) return err;
      return params.choice === 0 || params.choice === 1 ? null : '방향(왼쪽/오른쪽)을 고르세요.';
    },
    detail: (_ctx, p) => (p.choice === 1 ? '— 오른쪽으로' : '— 왼쪽으로'),
    resolve(ctx, params, decl) {
      const ids = cardJoiners(ctx, decl, true).map((p) => p.id);
      if (ids.length < 2) return addLog(ctx.state, `도둑잡기: 카드를 넘길 사람이 부족합니다${immuneText(ctx.state, decl.immune)}`);
      addLog(ctx.state, `도둑잡기: 각자 홀카드 1장을 골라 ${params.choice === 1 ? '오른쪽' : '왼쪽'} 사람에게 넘깁니다${immuneText(ctx.state, decl.immune)}`);
      ctx.ops.startRespond({ kind: 'collect', augment: 'catchThief', ownerId: ctx.owner.id, participants: ids, params: { extra: { dir: params.choice } } });
    },
    respond: {
      ...pickHoleRespond,
      done(ctx, r) {
        const { state } = ctx;
        // 좌석 순서(시계 방향), 오른쪽이면 반대로 넘긴다
        const ps = state.players.filter((p) => r.participants.includes(p.id) && live(p) && p.hole.length);
        const n = ps.length;
        if (n < 2) return false;
        const step = r.params.extra?.dir === 1 ? -1 : 1;
        const given = ps.map((p) => p.hole[Math.min(r.answers[p.id]?.cardIndex ?? 0, p.hole.length - 1)]);
        const slots = ps.map((p, k) => p.hole.indexOf(given[k]));
        ps.forEach((p, k) => cardLeft(p, given[k]));
        ps.forEach((p, k) => {
          const from = (((k - step) % n) + n) % n;
          p.hole[slots[k]] = given[from];
          note(state, p, 'info', `도둑잡기: ${cardToken(given[k])}을(를) ${ps[(k + step + n) % n].name}에게 주고 ${ps[from].name}에게서 ${cardToken(given[from])}을(를) 받았습니다`, [given[k], given[from]]);
        });
        addLog(state, '도둑잡기: 고른 카드를 동시에 옆 사람에게 넘겼습니다');
        return false;
      },
    },
  },

  silentRiver: {
    check(ctx) {
      if (basePhase(ctx.state) !== 'declare' || ctx.state.windowStage !== 'turnEnd') return '턴 베팅이 끝난 뒤 선언 기회에만 쓸 수 있습니다.';
      return ctx.state.effects.silentRiver ? '이미 선언되었습니다.' : null;
    },
    resolve(ctx) {
      ctx.state.effects.silentRiver = true;
      addLog(ctx.state, '침묵의 리버: 리버를 공개한 뒤 리버 베팅 없이 바로 쇼다운으로 갑니다');
    },
  },

  truce: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || (state.street !== 'flop' && state.street !== 'turn')) return '플랍·턴 베팅 라운드에서만 쓸 수 있습니다.';
      if (state.toAct !== idxOf(state, owner.id)) return '내 차례에만 선언할 수 있습니다.';
      if (state.currentBet > 0) return '이번 라운드에 베팅이 없을 때(체크할 수 있을 때)만 쓸 수 있습니다.';
      return needLive(ctx);
    },
    resolve(ctx) {
      const { state } = ctx;
      for (const p of state.players) {
        if (!canAct(p)) continue;
        p.acted = true;
        p.actedLevel = state.currentBet;
        p.lastAction = '체크';
      }
      addLog(state, '휴전: 이번 라운드는 모두 체크한 것으로 처리합니다');
    },
  },

  sharedCard: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop') return '프리플랍(플랍이 깔리기 전)에만 쓸 수 있습니다.';
      if (state.effects.shared.length) return '이번 핸드에는 이미 공용 카드가 있습니다.';
      return needLive(ctx) ?? respondBusy(state);
    },
    resolve(ctx, _params, decl) {
      const ids = cardJoiners(ctx, decl, false).filter((p) => p.hole.length >= 2).map((p) => p.id);
      if (!ids.length) return addLog(ctx.state, `공용 카드: 카드를 낼 사람이 없습니다${immuneText(ctx.state, decl.immune)}`);
      addLog(ctx.state, `공용 카드: 각자 홀카드 1장을 비공개로 골라 공용 카드로 냅니다${immuneText(ctx.state, decl.immune, '카드를 내지 않음')}`);
      ctx.ops.startRespond({ kind: 'collect', augment: 'sharedCard', ownerId: ctx.owner.id, participants: ids, params: {} });
    },
    respond: {
      ...pickHoleRespond,
      done(ctx, r) {
        const { state } = ctx;
        const shown: string[] = [];
        for (const id of r.participants) {
          const p = playerById(state, id)!;
          if (!live(p) || p.hole.length < 2) continue;
          const i = Math.min(r.answers[id]?.cardIndex ?? 0, p.hole.length - 1);
          const c = p.hole[i];
          cardLeft(p, c);
          p.hole.splice(i, 1);
          state.effects.shared.push(c);
          state.used.push({ card: c, kind: 'shown' });
          shown.push(`${p.name} ${cardToken(c)}`);
        }
        addLog(state, `공용 카드: ${shown.join(', ')} — 모두가 보드처럼 씁니다`);
        return false;
      },
    },
  },

  halfSecret: {
    check(ctx) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop' || state.round.actions > 0) return '프리플랍 베팅 전(아무도 행동하기 전)에만 쓸 수 있습니다.';
      return needLive(ctx) ?? respondBusy(state);
    },
    resolve(ctx, _params, decl) {
      const ids = cardJoiners(ctx, decl, false).filter((p) => p.hole.some((c) => !p.exposed.includes(c))).map((p) => p.id);
      if (!ids.length) return addLog(ctx.state, '반쪽짜리 비밀: 공개할 사람이 없습니다');
      addLog(ctx.state, `반쪽짜리 비밀: 각자 홀카드 1장을 비공개로 골라 동시에 공개합니다${immuneText(ctx.state, decl.immune, '공개하지 않음')}`);
      ctx.ops.startRespond({ kind: 'collect', augment: 'halfSecret', ownerId: ctx.owner.id, participants: ids, params: {} });
    },
    respond: {
      ...pickHoleRespond,
      done(ctx, r) {
        const { state } = ctx;
        const shown: string[] = [];
        for (const id of r.participants) {
          const p = playerById(state, id)!;
          if (!p.inHand || !p.hole.length) continue;
          const c = p.hole[Math.min(r.answers[id]?.cardIndex ?? 0, p.hole.length - 1)];
          if (!p.exposed.includes(c)) p.exposed.push(c);
          shown.push(`${p.name} ${cardToken(c)}`);
        }
        addLog(state, `반쪽짜리 비밀: ${shown.join(', ')}`);
        return false;
      },
    },
  },

  oneMore: {
    check(ctx) {
      const err = roundFresh(ctx);
      if (err) return err;
      return ctx.state.round.raiseCap !== null ? '이번 라운드에는 이미 레이즈 제한이 걸려 있습니다.' : null;
    },
    resolve(ctx) {
      ctx.state.round.raiseCap = 1;
      ctx.state.round.oneMore = true;
      addLog(ctx.state, '한 번만 더: 이번 라운드는 첫 베팅 이후 레이즈를 한 번만 허용합니다');
    },
  },

  switcheroo: {
    check(ctx, params) {
      const { state } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop') return '프리플랍 베팅 중에만 쓸 수 있습니다.';
      const err = opponentInHand(ctx, params);
      if (err) return err;
      return targetable(targetOf(ctx, params)!);
    },
    detail: (ctx, p) => `— 대상: ${nameOf(ctx.state, p.targetId ?? '')}`,
    resolve(ctx, params, decl) {
      const { state, owner } = ctx;
      const t = targetOf(ctx, params)!;
      if (decl.immune.includes(t.id)) return addLog(state, `바꿔치기: ${t.name}의 면역으로 효과가 사라졌습니다`);
      if (t.ironWall) return addLog(state, `바꿔치기: ${t.name}의 철벽에 막혔습니다`);
      if (!live(t) || !live(owner)) return;
      if (blocksForcedFold(ctx, t)) return;
      const mine = owner.hole;
      owner.hole = t.hole;
      t.hole = mine;
      // 공개된 카드는 카드를 따라 공개 상태 유지, 이마 카드는 풀린다
      [owner.exposed, t.exposed] = [t.exposed, owner.exposed];
      owner.forehead = null;
      t.forehead = null;
      addLog(state, `바꿔치기: ${owner.name}와(과) ${t.name}이(가) 홀카드를 통째로 바꿨습니다`);
      note(state, owner, 'info', `바꿔치기: ${cardsText(t.hole)}을(를) 주고 ${cardsText(owner.hole)}을(를) 받았습니다`, [...t.hole, ...owner.hole]);
      note(state, t, 'info', `바꿔치기: ${cardsText(owner.hole)}을(를) 주고 ${cardsText(t.hole)}을(를) 받았습니다`, [...owner.hole, ...t.hole]);
    },
  },

  timeBomb: {
    check(ctx) {
      if (basePhase(ctx.state) !== 'declare' || ctx.state.windowStage !== 'flop') return '플랍 공개 직후 선언 기회에만 쓸 수 있습니다.';
      return ctx.state.effects.timeBomb ? '이미 선언되었습니다.' : null;
    },
    resolve(ctx, _params, decl) {
      ctx.state.effects.timeBomb = true;
      ctx.state.effects.timeBombImmune = [...decl.immune];
      addLog(ctx.state, `시한폭탄: 이번 핸드는 체크하면 즉시 폴드됩니다 (베팅하거나 폴드)${immuneText(ctx.state, decl.immune, '체크 가능')}`);
    },
  },

  lastChoice: {
    check(ctx) {
      if (basePhase(ctx.state) !== 'declare' || ctx.state.windowStage !== 'turnEnd') return '턴 베팅이 끝난 뒤 선언 기회에만 쓸 수 있습니다.';
      if (!ctx.state.deck.length) return '덱에 남은 카드가 없습니다.';
      return respondBusy(ctx.state);
    },
    resolve(ctx) {
      const ids = ctx.state.players.filter((p) => live(p) && p.hole.length).map((p) => p.id);
      addLog(ctx.state, '마지막 선택: 각자 홀카드를 그대로 둘지 1장 바꿀지 비공개로 고릅니다');
      ctx.ops.startRespond({ kind: 'collect', augment: 'lastChoice', ownerId: ctx.owner.id, participants: ids, params: {} });
    },
    respond: {
      error: (_ctx, _r, p, a) => (a.choice === -1 || validHoleIndex(p, a.cardIndex) ? null : '바꿀 카드를 고르거나 유지를 고르세요.'),
      fallback: () => ({ choice: -1 }),
      done(ctx, r) {
        const { state } = ctx;
        const swap = r.participants.map((id) => playerById(state, id)!).filter((p) => r.answers[p.id]?.choice !== -1 && validHoleIndex(p, r.answers[p.id]?.cardIndex));
        const keep = r.participants.filter((id) => !swap.some((p) => p.id === id)).map((id) => nameOf(state, id));
        addLog(state, `마지막 선택: 바꿈 — ${swap.map((p) => p.name).join(', ') || '없음'} / 유지 — ${keep.join(', ') || '없음'}`);
        // 바꾸는 사람은 딜러 왼쪽부터 차례로 새 카드를 받는다
        const order = seatOrderFromDealer(state).map((i) => state.players[i]).filter((p) => swap.includes(p));
        for (const p of order) {
          if (!state.deck.length) break;
          const i = r.answers[p.id]!.cardIndex!;
          const old = p.hole[i];
          cardLeft(p, old);
          state.used.push({ card: old, kind: 'discard' });
          p.hole[i] = state.deck.shift()!;
          note(state, p, 'info', `마지막 선택: ${cardToken(old)}을(를) 버리고 ${cardToken(p.hole[i])}을(를) 받았습니다`, [old, p.hole[i]]);
        }
        return false;
      },
    },
  },

  // ═════════════════════════ 4차 풀: 족보 변형형 ═════════════════════════

  shadow: {
    check(ctx, params) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'preShowdown') return '쇼다운 직전 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner)) return '핸드에 참여 중일 때만 쓸 수 있습니다.';
      if (!validHoleIndex(owner, params.cardIndex)) return '무늬를 바꿀 홀카드를 고르세요.';
      const bi = params.boardIndex;
      const board = visibleBoard(state, owner);
      if (!isInt(bi) || !board[bi]) return '같은 숫자의 보드 카드를 고르세요.';
      const h = owner.hole[params.cardIndex];
      const b = board[bi]!;
      if (rankOf(h) !== rankOf(b) || suitOf(h) === suitOf(b)) return '숫자가 같고 무늬가 다른 보드 카드를 골라야 합니다.';
      return null;
    },
    resolve(ctx, params) {
      const { state, owner } = ctx;
      const h = owner.hole[params.cardIndex!];
      const b = state.board[params.boardIndex!];
      owner.shadow = { index: params.cardIndex!, to: b };
      addLog(state, `그림자 분신: ${owner.name}의 홀카드 1장을 ${cardToken(b)}의 무늬로 판정합니다`);
      addLog(state, `그림자 분신: ${cardToken(h)} → ${cardToken(b)}`, { to: [owner.id] });
    },
  },

  omahaBlood: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'declare' || state.windowStage !== 'preShowdown') return '쇼다운 직전 선언 기회에만 쓸 수 있습니다.';
      if (!live(owner) || owner.hole.length < 2) return '홀카드 2장으로 핸드에 참여 중일 때만 쓸 수 있습니다.';
      return owner.omaha ? '이미 발동했습니다.' : null;
    },
    resolve(ctx) {
      ctx.owner.omaha = true;
      addLog(ctx.state, `오마하의 피: ${ctx.owner.name}은(는) 홀카드 2장을 모두 쓰는 족보를 한 단계 올려 판정합니다`);
    },
  },

  colorBlind: {
    check(ctx) {
      const { state, owner } = ctx;
      if (basePhase(state) !== 'betting' || state.street !== 'preflop') return '프리플랍에만 선언할 수 있습니다.';
      if (!live(owner) || owner.actedPreflop) return '핸드 시작 시(프리플랍 내 첫 행동 전)에만 선언할 수 있습니다.';
      return owner.colorBlindOn ? '이미 선언했습니다.' : null;
    },
    resolve(ctx) {
      ctx.owner.colorBlindOn = true;
      addLog(ctx.state, `색맹: 이번 핸드 동안 ${ctx.owner.name}은(는) 색(빨강/검정)으로 플러시를 판정합니다`);
    },
  },

  // ═════════════════════════ 4차 풀: 방어/카운터형 ═════════════════════════

  // 정보 통행료·선택적 노출: 패시브지만 응답 창을 쓰므로 응답 처리만 등록한다 (선언하지 않음)
  infoToll: {
    check: () => '자동으로 발동하는 증강입니다.',
    resolve() {},
    respond: {
      error: (_ctx, _r, _p, a) => yesNo(a.accept),
      // 응답이 없으면 취소
      fallback: () => ({ accept: false }),
      done(ctx, r) {
        const { state, owner } = ctx;
        const looker = playerById(state, r.params.targetId)!;
        const augment = r.params.extra!.augment as AugmentId;
        const params = r.params.extra!.params as ActiveParams;
        if (r.answers[looker.id]?.accept) {
          const paid = transfer(state, looker, owner, 2 * bbOf(state));
          addLog(state, `정보 통행료: ${looker.name}이(가) ${owner.name}에게 ${paid}칩을 내고 확인합니다`);
          rerunInfo(ctx, looker, augment, params);
          return false;
        }
        // 취소: 사용 횟수를 돌려준다
        const a = findAug(looker, augment);
        if (a) {
          if (AUGMENTS[augment].uses?.per === 'game') a.usesLeft = (a.usesLeft ?? 0) + 1;
          if (AUGMENTS[augment].uses?.per === 'hand') a.usedThisHand = false;
        }
        addLog(state, `정보 통행료: ${looker.name}이(가) 확인을 취소했습니다`);
        addLog(state, `${AUGMENTS[augment].name} 사용을 취소해 횟수를 돌려받았습니다`, { to: [looker.id] });
        return false;
      },
    },
  },

  selectiveReveal: {
    check: () => '자동으로 발동하는 증강입니다.',
    resolve() {},
    respond: {
      error: (_ctx, _r, p, a) => (validHoleIndex(p, a.cardIndex) ? null : '보여 줄 홀카드를 고르세요.'),
      fallback: (ctx, _r, p) => ({ cardIndex: ctx.state.rng.int(Math.max(1, p.hole.length)) }),
      done(ctx, r) {
        const looker = playerById(ctx.state, r.params.targetId)!;
        rerunInfo(ctx, looker, 'clairvoyance', r.params.extra!.params as ActiveParams, r.answers[ctx.owner.id]?.cardIndex ?? 0);
        return false;
      },
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
      const paid = putChips(ctx.owner, params.blind === 'SB' ? sb : bb);
      ctx.owner.blindPosted += paid;
      ctx.state.round.startBets[ctx.owner.id] = ctx.owner.streetBet;
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
      const fromDead = Math.min(refund - fromBets, Math.max(0, state.deadMoney));
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
      for (const f of folded) {
        // 포커페이스: 관찰자에 잡히지 않는다
        if (findAug(f, 'pokerFace')) note(state, owner, 'observer', `관찰자: ${f.name} — 정보 없음`, undefined, f.id);
        else note(state, owner, 'observer', `관찰자: ${f.name}의 폴드한 홀카드 ${cardsText(f.hole)}`, [...f.hole], f.id);
      }
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
    onInfoExposed(ctx, looker, kind) {
      const { state, owner, aug } = ctx;
      if (!FAKEABLE.includes(kind) || (aug.usesLeft ?? 0) <= 0) return;
      aug.usesLeft = 0;
      countUse(state, 'disinfo');
      addLog(state, `역정보 발동: ${looker.name}의 정보형 증강에 가짜 결과를 보여 줬습니다.`, { to: [owner.id] });
      return 'fake';
    },
  },

  mirror: {
    onInfoExposed(ctx, looker, kind) {
      const { state, owner } = ctx;
      if (!FAKEABLE.includes(kind) || !looker.hole.length) return;
      countUse(state, 'mirror');
      const info = infoAbout(state, looker, kind, owner);
      note(state, owner, 'mirror', `거울: ${looker.name}이(가) 「${INFO_NAME[kind]}」으로 나를 확인했습니다. ${looker.name}${info.text}`, info.cards, looker.id);
    },
  },

  traceback: {
    onInfoExposed(ctx, looker, kind) {
      countUse(ctx.state, 'traceback');
      note(ctx.state, ctx.owner, 'traceback', `역추적: ${looker.name}이(가) 나에게 「${INFO_NAME[kind]}」을(를) 썼습니다.`, undefined, looker.id);
    },
  },

  locker: {
    onFold(ctx) {
      if (ctx.owner.hole.length) {
        ctx.owner.lockerPending = true;
        addLog(ctx.state, '보관함: 핸드가 끝나면 보관할 홀카드 1장을 고르세요.', { to: [ctx.owner.id] });
      }
    },
  },

  lateBloomer: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      if (!active(owner)) return;
      const won = result.won[owner.id] ?? 0;
      if (won <= 0) {
        if (result.showdown && result.entries.some((e) => e.id === owner.id)) owner.lateLosses++;
        return;
      }
      if (owner.lateLosses < 3) {
        owner.lateLosses = 0;
        return;
      }
      const bonus = Math.min(Math.floor(won * 0.5), 20 * currentBlinds(state).bb);
      const payers = state.players.filter((p) => p !== owner && active(p) && p.chips > 0);
      const share = payers.length ? Math.floor(bonus / payers.length) : 0;
      let got = 0;
      for (const p of payers) {
        const pay = Math.min(share, p.chips);
        p.chips -= pay;
        got += pay;
      }
      owner.chips += got;
      owner.lateLosses = 0;
      result.extras.push(`${owner.name}: 왕귀 +${got} (남은 플레이어가 나눠 냄)`);
      revealPassive(ctx, `— 3번 진 뒤 첫 승리: ${got}칩을 남은 플레이어에게서 받음`);
    },
  },

  totem: {
    onHandEnd(ctx, result) {
      const { state, owner, aug } = ctx;
      if (!result.showdown || owner.chips > 0 || !owner.wentAllIn || (aug.usesLeft ?? 0) <= 0) return;
      if (!result.entries.some((e) => e.id === owner.id)) return;
      const need = 10 * currentBlinds(state).bb;
      let got = 0;
      const winners = Object.entries(result.won)
        .filter(([id, w]) => id !== owner.id && w > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => playerById(state, id)!);
      for (const w of winners) {
        const take = Math.min(need - got, w.chips);
        w.chips -= take;
        got += take;
        if (got >= need) break;
      }
      if (got <= 0) return;
      owner.chips += got;
      aug.usesLeft = 0;
      result.extras.push(`${owner.name}: 불사의 토템 — 탈락하지 않고 ${got}칩을 남김`);
      revealPassive(ctx, `— 승자의 몫에서 ${got}칩을 남겨 받고 계속합니다`);
    },
  },

  // 진실 게임: 콜한 상대(쇼다운 참가자) 각각과 3BB 정산
  truthGame: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      const claim = owner.truthClaim;
      const me = result.entries.find((e) => e.id === owner.id);
      if (claim === null || !result.showdown || !me) return;
      const others = result.entries.filter((e) => e.id !== owner.id).map((e) => playerById(state, e.id)!);
      if (!others.length) return;
      const cat = Math.min(Category.Quads, me.score[0]);
      const truth = cat >= claim;
      const amt = 3 * bbOf(state);
      let total = 0;
      for (const o of others) total += truth ? transfer(state, o, owner, amt) : transfer(state, owner, o, amt);
      const text = `${owner.name}: 진실 게임 "${truthNames[claim]} 이상" — ${truth ? `진실, ${total}칩을 받음` : `거짓, ${total}칩을 냄`}`;
      result.extras.push(text);
      addLog(state, text);
    },
  },

  // 눈싸움: 둘 다 쇼다운에 가면 공개, 한 명만 정직했다면 2BB
  staredown: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      const sd = state.staredown;
      if (!sd || sd.a !== owner.id || !result.showdown) return;
      const a = playerById(state, sd.a)!;
      const b = playerById(state, sd.b)!;
      if (!result.entries.some((e) => e.id === a.id) || !result.entries.some((e) => e.id === b.id)) return;
      const board = evalBoard(state);
      const cmp = compareContenders(contenderFor(state, a, handEvalFor(state, a, board)), contenderFor(state, b, handEvalFor(state, b, board)), { inverted: invertedNow(state), board }).result;
      const honest = (p: PlayerState, sign: number) => (sd.claims[p.id] === 1 ? sign > 0 : sign < 0);
      const ha = honest(a, cmp);
      const hb = honest(b, -cmp);
      const word = (p: PlayerState) => (sd.claims[p.id] ? '강함' : '약함');
      let tail = '둘 다 정직하거나 둘 다 정직하지 않아 정산 없음';
      if (ha !== hb) {
        const [w, l] = ha ? [a, b] : [b, a];
        const paid = transfer(state, l, w, 2 * bbOf(state));
        tail = `${w.name}만 정직 — ${l.name}이(가) ${paid}칩을 냄`;
      }
      const text = `눈싸움 공개: ${a.name} "${word(a)}", ${b.name} "${word(b)}" — ${tail}`;
      result.extras.push(text);
      addLog(state, text);
    },
  },

  // 밀봉 계약: 핸드가 끝나면 공개, 맞히면 은행에서 3BB
  sealedContract: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      const c = owner.contract;
      if (c === null || !owner.inHand || owner.folded) return;
      const outcome = result.showdown ? 1 : (result.won[owner.id] ?? 0) > 0 ? 0 : null;
      if (outcome === null) return;
      const hit = outcome === c;
      const bonus = hit ? 3 * bbOf(state) : 0;
      owner.chips += bonus;
      state.stats.bankChips += bonus;
      const text = `${owner.name}: 밀봉 계약 "${c ? '한 명 이상 콜' : '전원 폴드'}" — ${hit ? `적중, 은행에서 ${bonus}칩` : '빗나감'}`;
      result.extras.push(text);
      addLog(state, text);
    },
  },

  comeBack: {
    onBust(ctx) {
      const { state, owner, aug } = ctx;
      if ((aug.usesLeft ?? 0) <= 0) return false;
      aug.usesLeft = 0;
      owner.out = true;
      owner.outAtHand = state.handNumber;
      owner.sittingOut = false;
      // 3핸드가 지난 뒤 원래 자리로
      owner.dormant = state.handNumber + 4;
      state.tasks.push({ kind: 'revive', playerId: owner.id, dueHand: owner.dormant, amount: 10 * bbOf(state) });
      revealPassive(ctx, `— 탈락 대신 부활 대기 (핸드 #${owner.dormant}에 돌아옴)`);
      return true;
    },
  },

  runaway: {
    onHandEnd: (ctx, result) => updateStreak(ctx, result),
    onPickRound(ctx) {
      const { state, owner } = ctx;
      if (owner.streak < 3 || !owner.pickOptions) return;
      owner.pickExtra = owner.streak >= 5 ? 2 : 1;
      revealPassive(ctx, `— ${owner.streak}연승: 이번 증강 선택에서 ${owner.pickExtra + 1}개를 가져갑니다`);
      owner.streak = 0;
    },
  },

  lurk: {
    onAcquire(ctx, got) {
      const { state, owner } = ctx;
      if (got.id === 'lurk') {
        const others = owner.augments.filter((a) => a.id !== 'lurk');
        if (!others.length) {
          owner.lurkWaiting = true;
          addLog(state, '잠복: 숨길 증강이 없어 다음에 얻는 증강을 숨깁니다', { to: [owner.id] });
          return;
        }
        const pick = pickOne(others, state.rng);
        pick.hidden = true;
        owner.lurkChoose = true;
        addLog(state, `잠복: ${AUGMENTS[pick.id].name}을(를) 숨겼습니다 (다음 핸드 시작 전까지 바꿀 수 있음)`, { to: [owner.id] });
        return;
      }
      if (owner.lurkWaiting) {
        owner.lurkWaiting = false;
        got.hidden = true;
        addLog(state, `잠복: ${AUGMENTS[got.id].name}을(를) 숨겼습니다`, { to: [owner.id] });
      }
    },
  },

  hunter: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      if (!active(owner) || (result.won[owner.id] ?? 0) <= 0) return;
      const victims = (result.busted ?? []).filter((id) => id !== owner.id);
      for (const v of victims) {
        const list = rechargeable(owner, 2);
        if (!list.length) return;
        const a = pickOne(list, state.rng);
        a.usesLeft = 1;
        revealPassive(ctx, `— ${nameOf(state, v)}을(를) 탈락시킴`);
        addLog(state, `사냥꾼: ${AUGMENTS[a.id].name}을(를) 1회 충전했습니다`, { to: [owner.id] });
      }
    },
  },

  // 공개 청문회: 정보형 증강으로 나를 보면 확인은 허용하되, 쓴 사람의 같은 종류 정보를 테이블 전원에게
  publicHearing: {
    onInfoExposed(ctx, looker, kind) {
      const { state, aug } = ctx;
      if ((aug.usesLeft ?? 0) <= 0 || !looker.hole.length) return;
      aug.usesLeft = 0;
      const info = infoAbout(state, looker, kind, looker);
      // 공개된 카드는 이미 공개된 카드로 기록 (카운팅·명추리)
      for (const c of info.cards ?? []) state.used.push({ card: c, kind: 'called' });
      revealPassive(ctx, `— ${looker.name}이(가) 「${INFO_NAME[kind]}」으로 확인함`);
      addLog(state, `공개 청문회: ${looker.name}${info.text}`);
    },
  },

  winBonus: {
    onHandEnd: (ctx, result) => updateStreak(ctx, result),
  },

  savings: {
    onFold(ctx) {
      if (ctx.state.street === 'preflop') ctx.owner.savings++;
    },
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      if ((result.won[owner.id] ?? 0) <= 0 || owner.savings <= 0) return;
      const amt = Math.floor((owner.savings * bbOf(state)) / 10);
      owner.savings = 0;
      if (amt <= 0) return;
      owner.chips += amt;
      state.stats.bankChips += amt;
      result.extras.push(`${owner.name}: 적금 ${amt}칩 (은행)`);
      revealPassive(ctx, `— 적립한 ${amt}칩을 은행에서`);
    },
  },

  smallPot: {
    onHandEnd(ctx, result) {
      const { state, owner, aug } = ctx;
      if ((aug.usesLeft ?? 0) <= 0) return;
      const total = result.pots.reduce((s, p) => s + p.amount, 0);
      const winners = Object.entries(result.won).filter(([, w]) => w > 0).map(([id]) => id);
      if (winners.length !== 1 || winners[0] !== owner.id || total > 6 * bbOf(state)) return;
      aug.usesLeft = (aug.usesLeft ?? 0) - 1;
      owner.chips += bbOf(state);
      state.stats.bankChips += bbOf(state);
      result.extras.push(`${owner.name}: 소액 전문 ${bbOf(state)}칩 (은행)`);
      revealPassive(ctx, `— 작은 팟 단독 승리 (남은 ${aug.usesLeft}회)`);
    },
  },

  regroup: {
    onHandEnd(ctx, result) {
      const { state, owner, aug } = ctx;
      if ((aug.usesLeft ?? 0) <= 0 || !result.showdown || !result.entries.some((e) => e.id === owner.id)) return;
      if ((result.won[owner.id] ?? 0) > 0 || owner.chips <= 0) return;
      aug.usesLeft = (aug.usesLeft ?? 0) - 1;
      owner.chips += 2 * bbOf(state);
      state.stats.bankChips += 2 * bbOf(state);
      result.extras.push(`${owner.name}: 재정비 ${2 * bbOf(state)}칩 (은행)`);
      revealPassive(ctx, '— 쇼다운에서 지고 살아남아 2BB');
    },
  },

  coHarvest: {
    onHandEnd(ctx, result) {
      const { state, owner, aug } = ctx;
      if ((aug.usesLeft ?? 0) <= 0 || !result.showdown) return;
      // 같은 팟(같은 판정 단위)을 동점으로 나눠 받았을 때만
      const tie = result.pots.some((p) => (p.units ? p.units.some((u) => u.winners.length >= 2 && u.winners.includes(owner.id)) : p.winners.length >= 2 && p.winners.includes(owner.id)));
      if (!tie) return;
      aug.usesLeft = (aug.usesLeft ?? 0) - 1;
      owner.chips += 2 * bbOf(state);
      state.stats.bankChips += 2 * bbOf(state);
      result.extras.push(`${owner.name}: 공동 수확 ${2 * bbOf(state)}칩 (은행)`);
      revealPassive(ctx, '— 동점으로 나눠 받음');
    },
  },

  revenge: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      if (!result.showdown || !result.entries.some((e) => e.id === owner.id)) return;
      const won = (result.won[owner.id] ?? 0) > 0;
      const foe = playerById(state, owner.nemesis);
      if (won && foe && result.entries.some((e) => e.id === foe.id) && (result.won[foe.id] ?? 0) <= 0) {
        const total = result.pots.reduce((s, p) => s + p.amount, 0);
        const paid = transfer(state, foe, owner, Math.floor(total * 0.15));
        const text = `${owner.name}: 복수 — ${foe.name}에게서 팟의 15%인 ${paid}칩`;
        result.extras.push(text);
        revealPassive(ctx, `— ${foe.name}에게 복수 (${paid}칩)`);
      }
      // 다음 복수 대상: 이번 쇼다운에서 나를 이긴 사람 (이겼으면 없음)
      owner.nemesis = won ? null : (result.pots[0]?.winners.find((id) => id !== owner.id) ?? null);
    },
  },

  wanted: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      const t = playerById(state, owner.wanted);
      if (!t || !result.showdown) return;
      if (!result.entries.some((e) => e.id === owner.id) || !result.entries.some((e) => e.id === t.id)) return;
      if ((result.won[owner.id] ?? 0) <= 0 || (result.won[t.id] ?? 0) > 0) return;
      // 지목형: 철벽이면 막힌다
      if (t.ironWall) return addLog(state, `현상수배: ${t.name}의 철벽에 막혔습니다`);
      const paid = transfer(state, t, owner, 5 * bbOf(state));
      result.extras.push(`${owner.name}: 현상수배 — ${t.name}에게서 ${paid}칩`);
      addLog(state, result.extras.at(-1)!);
    },
  },

  nerveTest: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      if (result.showdown || (result.won[owner.id] ?? 0) <= 0 || !owner.exposed.length || !findAug(owner, 'nerveTest')?.revealed) return;
      const folder = playerById(state, state.lastFolderId);
      if (!folder || folder === owner) return;
      const paid = transfer(state, folder, owner, 3 * bbOf(state));
      result.extras.push(`${owner.name}: 배짱 시험 성공 — ${folder.name}에게서 ${paid}칩`);
      addLog(state, result.extras.at(-1)!);
    },
  },

  straw: {
    onHandEnd(ctx, result) {
      const { state, owner } = ctx;
      const t = playerById(state, owner.strawOn);
      if (!t) return;
      addLog(state, `빨대 꼽기: ${owner.name}의 지목은 ${t.name}이었습니다`);
      const tw = result.won[t.id] ?? 0;
      if (tw <= 0) return;
      // 이번 핸드에 낸 칩을 승자의 몫에서 (보험 환급분과 합쳐 100%까지)
      const paid = transfer(state, t, owner, Math.min(owner.contributed, tw));
      result.won[t.id] = tw - paid;
      result.extras.push(`${owner.name}: 빨대 꼽기 적중 — ${t.name}의 몫에서 ${paid}칩`);
      addLog(state, result.extras.at(-1)!);
    },
  },

  sideBet: {
    onHandEnd(ctx) {
      const { state, owner } = ctx;
      if (owner.sideBetOn) addLog(state, `사이드 베팅: ${owner.name}의 예측은 ${nameOf(state, owner.sideBetOn)}이었습니다`);
    },
  },

  bait: {
    onHandEnd(ctx, result) {
      const { state, owner, aug } = ctx;
      // 이번 핸드에 미끼를 던졌고 쇼다운에서 이겼으면, 끝까지 따라온 상대마다 1BB
      if (!aug.usedThisHand || !result.showdown || (result.won[owner.id] ?? 0) <= 0) return;
      const callers = result.entries.map((e) => playerById(state, e.id)!).filter((p) => p !== owner && (result.won[p.id] ?? 0) <= 0);
      let got = 0;
      for (const p of callers) got += transfer(state, p, owner, bbOf(state));
      if (got <= 0) return;
      result.extras.push(`${owner.name}: 미끼 공개 — 따라온 상대들에게서 ${got}칩`);
      addLog(state, result.extras.at(-1)!);
    },
  },

  afterimage: {
    onBurn(ctx, card) {
      if (!active(ctx.owner) || boardBlind(ctx.state, ctx.owner)) return;
      countUse(ctx.state, 'afterimage');
      note(ctx.state, ctx.owner, 'info', `잔상: 번 카드 ${cardToken(card)}`, [card]);
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

// ───────────────────────── 예약 작업 (사채·대출 상환, 부활) ─────────────────────────

export const TASKS: Record<ScheduledTask['kind'], (state: GameState, t: ScheduledTask) => void> = {
  sharkRepay(state, t) {
    const borrower = playerById(state, t.playerId);
    const lender = playerById(state, t.otherId);
    if (!borrower || !active(borrower)) return;
    if (!lender || !active(lender)) {
      addLog(state, `사채업자: 빌려준 사람이 자리에 없어 ${borrower.name}의 빚이 사라졌습니다`);
      return;
    }
    const paid = transfer(state, borrower, lender, t.amount);
    countUse(state, 'loanShark');
    addLog(state, `사채업자: ${borrower.name}이(가) ${lender.name}에게 ${paid}칩을 갚았습니다${paid < t.amount ? ' (모자라 있는 만큼)' : ''}`);
  },
  loanRepay(state, t) {
    const p = playerById(state, t.playerId);
    if (!p || !active(p)) return;
    const paid = transfer(state, p, null, t.amount);
    countUse(state, 'loan');
    if (paid >= t.amount) {
      addLog(state, `대출: ${p.name}이(가) 은행에 ${paid}칩을 갚았습니다`);
      return;
    }
    // 모자라면 있는 만큼 내고 보유 증강 1개 몰수
    const lost = p.augments.length ? pickOne(p.augments, state.rng) : null;
    if (lost) p.augments = p.augments.filter((a) => a !== lost);
    addLog(state, `대출: ${p.name}이(가) ${paid}칩만 갚아${lost ? ' 보유 증강 1개를 몰수당했습니다' : ''}`);
    if (lost) note(state, p, 'augment', `대출: ${AUGMENTS[lost.id].name}을(를) 몰수당했습니다`);
  },
  revive(state, t) {
    const p = playerById(state, t.playerId);
    if (!p || p.dormant === null || p.kicked) return;
    // 돌아올 때의 10BB는 남은 플레이어가 똑같이 나눠 낸다
    const payers = state.players.filter((x) => active(x) && x !== p);
    const share = payers.length ? Math.floor(t.amount / payers.length) : 0;
    let got = 0;
    for (const x of payers) got += transfer(state, x, p, share);
    p.out = false;
    p.dormant = null;
    p.outAtHand = null;
    p.place = null;
    addLog(state, `3일 안에 오리라: ${p.name}이(가) 원래 자리로 돌아왔습니다 (${got}칩, 남은 플레이어가 ${share}칩씩)`);
  },
};

/** 선언 기회 판단용 대상 후보 (지목형 창 증강: 공동 환승·명추리·기생) */
function windowSamples(state: GameState, p: PlayerState, id: AugmentId): ActiveParams[] {
  if (id === 'seal') return [{ boardIndex: [0, 1, 2, 3, 4].find((i) => !state.effects.sealed.includes(i)) }];
  if (id === 'lastFork') return [{ cardIndex: 0 }];
  if (id === 'deadScanner') return [{ choice: 0 }];
  if (id === 'shadow') return p.hole.flatMap((_, ci) => [0, 1, 2, 3, 4, 5, 6].map((bi) => ({ cardIndex: ci, boardIndex: bi })));
  if (id === 'alchemy') return p.hole.flatMap((_, i) => [{ cardIndex: i, choice: 0 }, { cardIndex: i, choice: 1 }]);
  if (!AUGMENTS[id].target) return [{}];
  return state.players.filter((t) => t !== p).map((t) => {
    // 명추리: 이미 아는 카드가 아닌 아무 카드 (판단용)
    const known = id === 'nameIt' ? new Set(knownCardsFor(state, p, t)) : null;
    return { targetId: t.id, ...(known ? { card: fullDeck().find((c) => !known.has(c)) } : {}) };
  });
}

/** 선언 기회에 이 증강으로 고를 수 있는 인자 조합 (연금술의 카드·방향 등) */
export function windowValidParams(state: GameState, ops: EngineOps, p: PlayerState, id: AugmentId): ActiveParams[] {
  const a = findAug(p, id);
  if (!a) return [];
  return windowSamples(state, p, id).filter((params) => !ACTIVE[id]?.check({ state, ops, owner: p, aug: a }, params, false));
}

/** 선언 기회에 이 증강으로 지목할 수 있는 대상 */
export function windowTargets(state: GameState, ops: EngineOps, p: PlayerState, id: AugmentId): string[] {
  const a = findAug(p, id);
  if (!a || !AUGMENTS[id].target) return [];
  return windowSamples(state, p, id)
    .filter((params) => !ACTIVE[id]?.check({ state, ops, owner: p, aug: a }, params, false))
    .map((params) => params.targetId!);
}

/** 정해진 선언 기회에 쓸 수 있는 증강 (되감기·봉인·밥상 뒤집기 등) */
export function windowOptions(state: GameState, ops: EngineOps, p: PlayerState): AugmentId[] {
  const out: AugmentId[] = [];
  if (taxError(state, p)) return out;
  for (const a of p.augments) {
    const def = AUGMENTS[a.id];
    if (def.trigger !== 'window' || !ACTIVE[a.id]) continue;
    if (def.uses?.per === 'hand' ? a.usedThisHand : (a.usesLeft ?? 0) <= 0) continue;
    const ctx = { state, ops, owner: p, aug: a };
    if (windowSamples(state, p, a.id).some((params) => !ACTIVE[a.id]?.check(ctx, params, false))) out.push(a.id);
  }
  return out;
}

export { findAug };
