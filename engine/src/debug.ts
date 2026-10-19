// 개발용 디버그 기능. state.options.debug 가 true 인 게임에서만 동작한다.
// 서버는 DEBUG=true 일 때만 이 함수들을 호출할 수 있는 이벤트를 등록한다 (이중 차단).

import { Card, isCard, rankName } from './cards.js';
import { AUGMENTS, AugmentId, isAugmentId } from './augments.js';
import { findAug, grantAugment, getPlayer } from './game.js';
import type { ActionResult, DebugDeal, GameState } from './types.js';

function guard(state: GameState): ActionResult | null {
  return state.options.debug ? null : { ok: false, error: '디버그 모드가 꺼져 있습니다.' };
}

/** 특정 증강을 강제로 지급 */
export function debugGiveAugment(state: GameState, playerId: string, augment: AugmentId, wildRank?: number): ActionResult {
  const g = guard(state);
  if (g) return g;
  const p = getPlayer(state, playerId);
  if (!p) return { ok: false, error: '플레이어 없음' };
  if (!isAugmentId(augment)) return { ok: false, error: '알 수 없는 증강' };
  if (findAug(p, augment)) return { ok: false, error: '이미 보유한 증강' };
  const wr = typeof wildRank === 'number' && wildRank >= 2 && wildRank <= 14 ? wildRank : undefined;
  grantAugment(state, p, augment, wr);
  return { ok: true };
}

/** 다음 핸드의 보드/홀카드 지정 (지정하지 않은 카드는 무작위) */
export function debugSetNextDeal(state: GameState, deal: DebugDeal): ActionResult {
  const g = guard(state);
  if (g) return g;
  const all: Card[] = [...(deal.board ?? []), ...(deal.burns ?? []), ...(deal.deck ?? []), ...Object.values(deal.hands ?? {}).flat()];
  if (!all.every(isCard)) return { ok: false, error: '카드 형식이 올바르지 않습니다 (예: As, Td, 7c)' };
  if (new Set(all).size !== all.length) return { ok: false, error: '같은 카드가 두 번 지정되었습니다.' };
  if ((deal.board ?? []).length > 5) return { ok: false, error: '보드는 최대 5장' };
  if ((deal.burns ?? []).length > 3) return { ok: false, error: '번 카드는 최대 3장' };
  for (const id of Object.keys(deal.hands ?? {})) if (!getPlayer(state, id)) return { ok: false, error: `플레이어 없음: ${id}` };
  state.nextDeal = {
    board: deal.board ? [...deal.board] : undefined,
    hands: deal.hands ? { ...deal.hands } : undefined,
    burns: deal.burns ? [...deal.burns] : undefined,
    deck: deal.deck ? [...deal.deck] : undefined,
  };
  return { ok: true };
}

/** 칩 수 강제 지정 (탈락·올인 상황을 빨리 만들기 위함) */
export function debugSetChips(state: GameState, playerId: string, chips: number): ActionResult {
  const g = guard(state);
  if (g) return g;
  const p = getPlayer(state, playerId);
  if (!p || p.out) return { ok: false, error: '플레이어 없음' };
  if (!Number.isInteger(chips) || chips < 1) return { ok: false, error: '칩은 1 이상의 정수' };
  p.chips = chips;
  if (p.inHand) p.allIn = false;
  return { ok: true };
}

/** 블라인드 레벨 즉시 올리기: 다음 핸드부터 한 단계 높은 블라인드와 증강 선택 */
export function debugLevelUp(state: GameState): ActionResult {
  const g = guard(state);
  if (g) return g;
  state.forceLevelUp = true;
  return { ok: true };
}

export interface DebugView {
  board: Card[];
  burns: Card[];
  boardRevealed: number;
  sealed: number[];
  deck: Card[];
  used: { card: Card; kind: string }[];
  nextDeal: DebugDeal | null;
  forceLevelUp: boolean;
  taxers: string[];
  reaction: { owner: string; augment: string; countered: boolean }[];
  players: {
    id: string;
    name: string;
    chips: number;
    hole: Card[];
    discarded: Card[];
    keptCard: Card | null;
    shepherdLied: boolean;
    augments: { id: AugmentId; name: string; usesLeft: number | null; usedThisHand: boolean; revealed: boolean; publicName: string | null; wildRank: string | null; armed: boolean | null; fakeId: AugmentId | null }[];
  }[];
}

/** 모든 비공개 정보를 담은 뷰. 디버그 모드에서만. */
export function getDebugView(state: GameState): DebugView | null {
  if (!state.options.debug) return null;
  return {
    board: [...state.board],
    burns: [...state.burns],
    boardRevealed: state.boardRevealed,
    sealed: [...state.effects.sealed],
    deck: [...state.deck],
    used: state.used.map((u) => ({ ...u })),
    nextDeal: state.nextDeal,
    forceLevelUp: state.forceLevelUp,
    taxers: [...state.taxers],
    reaction: (state.reaction?.queue ?? []).map((d) => ({ owner: d.ownerId, augment: AUGMENTS[d.augment].name, countered: d.countered })),
    players: [...state.players, ...state.joiners.map((j) => j.player)].map((p) => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      hole: [...p.hole],
      discarded: [...p.discarded],
      keptCard: p.keptCard,
      shepherdLied: p.shepherdLied,
      augments: p.augments.map((a) => ({
        id: a.id,
        name: AUGMENTS[a.id].name,
        usesLeft: a.usesLeft,
        usedThisHand: a.usedThisHand,
        revealed: a.revealed,
        publicName: a.publicId ? AUGMENTS[a.publicId].name : null,
        wildRank: a.wildRank ? rankName(a.wildRank) : null,
        armed: a.armed ?? null,
        fakeId: a.fakeId ?? null,
      })),
    })),
  };
}
