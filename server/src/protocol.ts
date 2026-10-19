// 서버 ↔ 클라이언트 메시지 형식과 설정 상수. 클라이언트도 이 파일을 가져다 쓴다(엔진 런타임 코드는 참조하지 않음).

import type { PlayerView, DebugView, PendingKind, PoolPreset } from '../../engine/src/index.js';

export type BlindSchedule = 'standard' | 'x1.5';
export type LevelMode = 'auto' | 'fixed';
export const AUTO_KICK_CHOICES = [0, 3, 5, 10] as const;

export interface RoomSettings {
  maxPlayers: number;
  fillBots: boolean;
  botCount: number;
  /** 행동 제한 시간 (15~60초) */
  turnSeconds: number;
  /** 시작 칩 (200~10,000) */
  startingChips: number;
  /** 시작 빅블라인드 (2~1,000). 스몰블라인드는 절반 */
  bigBlind: number;
  /** 블라인드 상승 주기: 자동(레벨 시작 시 남은 인원 × 2) / 고정 */
  levelMode: LevelMode;
  /** 고정 주기의 핸드 수 (4~30) */
  levelHands: number;
  /** 블라인드 상승 방식: 기본 표 / 1.5배씩 */
  blindSchedule: BlindSchedule;
  /** 중도 참여 허용 */
  midJoin: boolean;
  /** 연결 끊긴 플레이어 자동 추방 (분, 0 = 끄기) */
  autoKickMinutes: number;
  /** 증강 선택에 재충전 카드 (기본 끄기, 시작 후 변경 불가) */
  recharge: boolean;
  /** 플레이어당 게임 전체 증강 리롤 횟수 (0~3, 기본 2, 시작 후 변경 불가) */
  rerolls: number;
  /** 증강 풀: 1차만 / 1~2차 / 1~3차 / 전체(기본) / 직접 고르기 (시작 후 변경 불가) */
  augPool: PoolPreset;
  /** 직접 고르기에서 켠 증강 */
  augCustom: string[];
}

/** 게임이 시작된 뒤에도 바꿀 수 있는 설정 (+ 공개 여부). 상승 주기는 다음 레벨부터 적용 */
export const IN_GAME_SETTINGS: (keyof RoomSettings)[] = ['maxPlayers', 'turnSeconds', 'midJoin', 'autoKickMinutes', 'levelMode', 'levelHands'];

/** 공개 방 목록의 한 줄: 방 이름, 인원, 진행 상태, 설정값만 (게임 내용은 절대 포함하지 않는다) */
export interface RoomListItem {
  code: string;
  name: string;
  players: number;
  maxPlayers: number;
  status: 'waiting' | 'playing';
  midJoin: boolean;
  /** 지금 입장할 수 있는가 (꽉 찼거나 중도 참여가 꺼진 게임 중인 방은 false) */
  joinable: boolean;
  startingChips: number;
  smallBlind: number;
  bigBlind: number;
  /** 증강 풀 표시 ("전체", "1~2차", "직접 고름(12개)") */
  augPool: string;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  connected: boolean;
  isHost: boolean;
}

export interface RoomInfo {
  name: string;
  isPublic: boolean;
}

export interface LobbyState extends RoomInfo {
  code: string;
  youId: string;
  hostId: string;
  settings: RoomSettings;
  players: LobbyPlayer[];
  debug: boolean;
}

export interface GameEnvelope extends RoomInfo {
  code: string;
  view: PlayerView;
  settings: RoomSettings;
  /** 연결 상태 (중도 참여 대기자 포함) */
  connected: Record<string, boolean>;
  /** 현재 결정의 마감 시각 (서버 시계, ms) */
  deadline: number | null;
  deadlineKind: PendingKind | null;
  serverNow: number;
  youAreHost: boolean;
  debug: boolean;
}

export type Ack<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface JoinResult {
  code: string;
  token: string;
  playerId: string;
}

/** 채팅 메시지 (방 안의 모두에게 공개되는 정보) */
export interface ChatMessage {
  id: number;
  fromId: string;
  name: string;
  text: string;
  ts: number;
}

export interface ServerToClient {
  lobby: (s: LobbyState) => void;
  game: (s: GameEnvelope) => void;
  'debug:state': (s: DebugView | null) => void;
  kicked: (reason: string) => void;
  rooms: (list: RoomListItem[]) => void;
  chat: (m: ChatMessage) => void;
  'chat:history': (list: ChatMessage[]) => void;
}

export type { PlayerView, DebugView };
