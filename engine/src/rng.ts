// 난수 원천. 실제 게임은 Web Crypto(getRandomValues)를 쓰는 cryptoRng 를 사용한다.
// 테스트에서만 재현 가능한 seededRng 를 주입한다.

export interface Rng {
  /** 0 이상 max 미만의 균등 분포 정수 */
  int(max: number): number;
}

const UINT32_RANGE = 0x1_0000_0000;

export const cryptoRng: Rng = {
  int(max: number): number {
    if (!Number.isInteger(max) || max <= 0 || max > UINT32_RANGE) throw new Error(`invalid range ${max}`);
    // 모듈로 편향을 없애기 위한 거절 샘플링
    const limit = UINT32_RANGE - (UINT32_RANGE % max);
    const buf = new Uint32Array(1);
    for (;;) {
      globalThis.crypto.getRandomValues(buf);
      if (buf[0] < limit) return buf[0] % max;
    }
  },
};

/** 테스트 전용: 시드 고정 난수 (mulberry32). 실제 게임 코드에서는 사용하지 않는다. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  };
  return { int: (max: number) => Math.floor(next() * max) };
}

/** Fisher–Yates 셔플 (제자리) */
export function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function pickOne<T>(arr: readonly T[], rng: Rng): T {
  return arr[rng.int(arr.length)];
}

/** 순서를 유지하지 않는 무작위 k개 추출 */
export function sample<T>(arr: readonly T[], k: number, rng: Rng): T[] {
  return shuffle([...arr], rng).slice(0, k);
}
