// 화면 도우미: HTML 이스케이프, 카드 그리기, 로그 문장 안의 [As] 토큰·증강 이름 변환

import { AUGMENTS } from '../../engine/src/augments.js';

const SUIT_SYMBOL: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function rankLabel(r: string): string {
  return r === 'T' ? '10' : r;
}

export function cardHtml(card: string, opts: { size?: 'sm' | 'md' | 'lg'; extra?: string; attrs?: string } = {}): string {
  const r = rankLabel(card[0]);
  const s = card[1];
  const red = s === 'h' || s === 'd';
  return `<span class="card ${opts.size ?? 'md'} ${red ? 'red' : 'black'} ${opts.extra ?? ''}" ${opts.attrs ?? ''}><b>${r}</b><i>${SUIT_SYMBOL[s] ?? '?'}</i></span>`;
}

export function cardBack(size: 'sm' | 'md' | 'lg' = 'sm'): string {
  return `<span class="card back ${size}"></span>`;
}

/**
 * 서버 로그 문장(이미 신뢰할 수 없는 이름이 섞여 있음)을 이스케이프한 뒤
 * 카드 토큰([As], 무늬를 가린 [A?])은 카드 모양으로, 증강 이름(「유리 테이블 ★★」)은 마우스를 올리면 설명이 보이게 바꾼다.
 */
export function richText(text: string): string {
  return esc(text)
    .replace(/\[([2-9TJQKA][shdc?])\]/g, (_, c: string) => cardHtml(c, { size: 'sm', extra: 'inline' }))
    .replace(/「([^」]+?) (★{1,3})」/g, (m, name: string) => {
      const tip = augTip(name.replace(/\(.*\)$/, ''));
      return tip ? `<span class="aug-ref" data-tip="${esc(tip)}">${m}</span>` : m;
    });
}

const AUG_BY_NAME = new Map(Object.values(AUGMENTS).map((d) => [d.name, d]));

/** 증강 이름 → 툴팁 문장 (이름·별·분류·설명, 모두 공개된 정의) */
export function augTip(name: string): string | null {
  const d = AUG_BY_NAME.get(name);
  return d ? `${d.name} ${'★'.repeat(d.stars)} · ${d.category}\n${d.description}` : null;
}

export function stars(n: number): string {
  return '★'.repeat(n);
}

export function fmt(n: number): string {
  return n.toLocaleString('ko-KR');
}

/** 같은 HTML 이면 DOM 을 건드리지 않는다 (슬라이더 조작 중 끊김 방지) */
const lastHtml = new WeakMap<Element, string>();
export function patch(el: Element | null, html: string): boolean {
  if (!el) return false;
  if (lastHtml.get(el) === html) return false;
  lastHtml.set(el, html);
  el.innerHTML = html;
  return true;
}

/** 화면 뼈대를 새로 끼울 때: 내용을 바꾸고 patch 캐시를 비운다 (이후 patch 가 반드시 다시 그리도록) */
export function mount(el: Element | null, html: string): void {
  if (!el) return;
  el.innerHTML = html;
  lastHtml.delete(el);
}

export function $(sel: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector(sel) as HTMLElement | null;
}
