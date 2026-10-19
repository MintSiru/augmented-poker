// 간단한 효과음: 파일 없이 Web Audio 로 합성한다. 첫 클릭·키 입력 뒤에 소리가 나기 시작한다(브라우저 자동 재생 정책).

export type Sfx = 'turn' | 'check' | 'chip' | 'raise' | 'allin' | 'fold' | 'deal' | 'win' | 'augment' | 'tick' | 'reveal';

const MUTE_KEY = 'ah.mute';
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = readMuted();

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(v: boolean): void {
  muted = v;
  try {
    localStorage.setItem(MUTE_KEY, v ? '1' : '0');
  } catch {
    /* 저장 불가 */
  }
}

function audio(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

// 사용자의 첫 입력에서 오디오를 깨운다
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => audio(), { once: true, capture: true });
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', vol = 0.6, slideTo?: number): void {
  const c = ctx!;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(master!);
  o.start(start);
  o.stop(start + dur + 0.02);
}

function noise(start: number, dur: number, vol = 0.4, highpass = 1500): void {
  const c = ctx!;
  const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = highpass;
  const g = c.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(master!);
  src.start(start);
}

/** 칩 소리: 짧고 높은 딸깍 소리 n번 */
function chips(t: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const s = t + i * 0.045;
    tone(2400 + Math.random() * 900, s, 0.05, 'triangle', 0.35);
    noise(s, 0.03, 0.15, 4000);
  }
}

export function play(kind: Sfx): void {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + 0.01;
  switch (kind) {
    case 'turn':
      tone(660, t, 0.16, 'sine', 0.5);
      tone(990, t + 0.13, 0.24, 'sine', 0.45);
      break;
    case 'check':
      tone(180, t, 0.07, 'square', 0.25);
      tone(160, t + 0.09, 0.07, 'square', 0.22);
      break;
    case 'chip':
      chips(t, 2);
      break;
    case 'raise':
      chips(t, 4);
      tone(520, t, 0.12, 'triangle', 0.25, 780);
      break;
    case 'allin':
      tone(110, t, 0.35, 'sawtooth', 0.35, 70);
      chips(t + 0.05, 7);
      break;
    case 'fold':
      noise(t, 0.22, 0.25, 900);
      break;
    case 'deal':
      noise(t, 0.06, 0.3, 2500);
      noise(t + 0.09, 0.06, 0.3, 2500);
      break;
    case 'reveal':
      noise(t, 0.05, 0.25, 2000);
      tone(880, t, 0.08, 'triangle', 0.15);
      break;
    case 'win':
      [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.09, 0.22, 'triangle', 0.4));
      chips(t + 0.3, 5);
      break;
    case 'augment':
      tone(400, t, 0.35, 'sine', 0.3, 1600);
      tone(1200, t + 0.08, 0.25, 'triangle', 0.18, 2400);
      break;
    case 'tick':
      tone(1500, t, 0.04, 'square', 0.15);
      break;
  }
}

/** 로그 한 줄을 효과음 종류로 (없으면 null) */
export function sfxForLog(text: string): Sfx | null {
  if (text.startsWith('── 핸드')) return 'deal';
  if (/^(플랍|턴|리버|추가 보드|플러스 원)/.test(text)) return 'reveal';
  if (/칩 획득/.test(text)) return 'win';
  if (/▸|비공개 증강을 사용|📢/.test(text)) return 'augment';
  if (/: (강제 )?폴드$/.test(text)) return 'fold';
  if (/: 체크$/.test(text)) return 'check';
  if (/: 올인/.test(text)) return 'allin';
  if (/: (레이즈|베팅)/.test(text)) return 'raise';
  if (/: (무임승차 )?콜/.test(text)) return 'chip';
  return null;
}
