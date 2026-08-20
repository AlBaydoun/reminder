export type Locale = 'en' | 'ar' | 'ru';

export interface User {
  id: string;
  email: string;
  name: string;
  locale: Locale;
  timezone: string;
  settings: UserSettings;
  createdAt: string;
}

export interface UserSettings {
  theme?: 'dark' | 'light';
  motion?: 'full' | 'balanced' | 'calm';
  dailyCapacityMinutes?: number;
  workStartHour?: number;
  workEndHour?: number;
  defaultSoundId?: string;
  voiceAutoApply?: boolean;
  voiceContinuous?: boolean;
  voiceLocale?: Locale;
  notificationsAsked?: boolean;
  [key: string]: unknown;
}

export type ItemStatus = 'open' | 'done' | 'archived';

export interface Recurrence {
  freq: 'minutely' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  byWeekday?: number[];
  byMonthDay?: number[];
  byMonth?: number[];
  at?: Array<{ hour: number; minute: number }>;
  count?: number;
  until?: string;
  exceptions?: string[];
}

export interface Item {
  id: string;
  parentId: string | null;
  title: string;
  notes: string;
  icon: string;
  color: string;
  status: ItemStatus;
  priority: number;
  energy: number;
  effortMinutes: number;
  dueAt: string | null;
  startAt: string | null;
  recurrence: Recurrence | null;
  tags: string[];
  blockedBy: string[];
  meta: Record<string, unknown>;
  position: number;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
}

export interface Reminder {
  id: string;
  itemId: string;
  label: string;
  fireAt: string;
  nextFireAt: string | null;
  rrule: Recurrence | null;
  soundId: string | null;
  volume: number;
  vibrate: boolean;
  leadMinutes: number[];
  snoozeMinutes: number;
  snoozedUntil: string | null;
  escalate: boolean;
  ringSeconds: number;
  status: 'scheduled' | 'snoozed' | 'fired' | 'dismissed' | 'done';
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DueReminder extends Reminder {
  item: { id: string; title: string; icon: string; color: string; status: ItemStatus };
}

export interface BuiltinSound {
  key: string;
  name: string;
  character: string;
}

export interface CustomSound {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt?: string;
  url: string;
}

export interface StrokePoint {
  x: number;
  y: number;
  p?: number;
  tx?: number;
  ty?: number;
  t?: number;
}

export interface Stroke {
  points: StrokePoint[];
  color?: string;
  width?: number;
  tool?: 'pen' | 'marker' | 'pencil' | 'highlighter' | 'eraser';
  pointerType?: 'pen' | 'touch' | 'mouse';
}

export interface Drawing {
  id: string;
  itemId: string | null;
  title: string;
  strokes: Stroke[];
  width: number;
  height: number;
  thumbnail: string;
  recognizedText: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScoreReason {
  code: string;
  weight: number;
  detail?: string;
}

export interface ScoredItem {
  item: Item;
  score: number;
  urgency: number;
  importance: number;
  reasons: ScoreReason[];
  blocked: boolean;
  blockingCount: number;
}

export interface DayLoad {
  date: string;
  minutes: number;
  count: number;
  overdue: number;
  capacity: number;
  overloaded: boolean;
}

export interface Insight {
  code: string;
  severity: 'info' | 'warn' | 'urgent';
  values: Record<string, string | number>;
  itemIds?: string[];
}

export interface StreakReport {
  current: number;
  longest: number;
  completedToday: number;
  last30: Array<{ date: string; count: number }>;
}

export interface Overview {
  focus: ScoredItem[];
  insights: Insight[];
  forecast: DayLoad[];
  streak: StreakReport;
  dependencies: { cycles: string[][]; readyNow: string[]; longestChain: string[] };
  totals: { open: number; blocked: number; overdue: number };
  timeZone: string;
  serverTime: string;
}

export interface BackupRecord {
  id: string;
  kind: 'nightly' | 'manual' | 'pre-restore';
  filename: string;
  size: number;
  itemCount: number;
  createdAt: string;
  available: boolean;
}

export interface CategorySuggestion {
  id: string;
  title: string;
  confidence: number;
  matchedTerms: string[];
}

export interface DuplicateGroup {
  ids: string[];
  titles: string[];
  similarity: number;
}

/** One instruction produced by the voice parser, mirroring the server's batch ops. */
export type BatchOp =
  | {
      op: 'create_item';
      title: string;
      notes?: string;
      icon?: string;
      color?: string;
      parentId?: string | null;
      parentPath?: string[];
      createMissingPath?: boolean;
      dueAt?: string | null;
      priority?: number;
      energy?: number;
      effortMinutes?: number;
      recurrence?: Recurrence | null;
      tags?: string[];
      pinned?: boolean;
    }
  | { op: 'complete_item'; target: TargetRef; done?: boolean; cascade?: boolean }
  | { op: 'delete_item'; target: TargetRef }
  | {
      op: 'update_item';
      target: TargetRef;
      title?: string;
      notes?: string;
      dueAt?: string | null;
      priority?: number;
      pinned?: boolean;
      tags?: string[];
      icon?: string;
      color?: string;
    }
  | {
      op: 'move_item';
      target: TargetRef;
      parentPath?: string[];
      parentId?: string | null;
      createMissingPath?: boolean;
    }
  | {
      op: 'create_reminder';
      target: TargetRef;
      fireAt: string;
      label?: string;
      rrule?: Recurrence | null;
      soundId?: string | null;
      escalate?: boolean;
      leadMinutes?: number[];
    };

export interface TargetRef {
  id?: string;
  query?: string;
  useLast?: boolean;
}
