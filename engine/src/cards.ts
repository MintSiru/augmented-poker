// 카드 표현: 'As'(스페이드 A), 'Td'(다이아 10), '2c'(클럽 2) 처럼 2글자 문자열.
// 로그 문장 안에서는 '[As]' 형태의 토큰으로 넣고, 화면이 이를 카드 모양으로 그린다.

export type Suit = 's' | 'h' | 'd' | 'c';
export type Card = string;

export const RANK_CHARS = '23456789TJQKA';
export const SUITS: readonly Suit[] = ['s', 'h', 'd', 'c'];

/** 2..14 (A = 14) */
export function rankOf(card: Card): number {
  return RANK_CHARS.indexOf(card[0]) + 2;
}

export function suitOf(card: Card): Suit {
  return card[1] as Suit;
}

export function makeCard(rank: number, suit: Suit): Card {
  return RANK_CHARS[rank - 2] + suit;
}

export function isCard(value: unknown): value is Card {
  return typeof value === 'string' && /^[2-9TJQKA][shdc]$/.test(value);
}

export function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push(makeCard(r, s));
  return deck;
}

const RANK_NAMES: Record<number, string> = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10', 1: 'A' };

export function rankName(rank: number): string {
  return RANK_NAMES[rank] ?? String(rank);
}

export function cardToken(card: Card): string {
  return `[${card}]`;
}
