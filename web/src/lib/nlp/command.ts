import type { BatchOp, Item, Locale, Recurrence } from '../types';
import { similarity } from '../text';
import { iconForTitle } from '../text';
import { lexiconFor, type Lexicon } from './lexicon';
import { normalize } from './numbers';
import { parseWhen, stripSpans } from './datetime';

/**
 * Turns one spoken utterance into an ordered list of server operations.
 *
 * The hard part is not recognising a single command — it is splitting
 * "add oil change under cars corolla and remind me tomorrow at eight and add
 * cleaning" into three, working out that the reminder belongs to the thing
 * just created, and resolving "cars corolla" to a real node in the user's own
 * tree. All of that happens here, on the client, so the confirmation sheet can
 * show exactly what is about to happen before anything is sent.
 */

export type Intent =
  | 'create'
  | 'remind'
  | 'complete'
  | 'delete'
  | 'move'
  | 'pin'
  | 'open'
  | 'search'
  | 'undo'
  | 'unknown';

export interface ParsedCommand {
  intent: Intent;
  raw: string;
  op?: BatchOp;
  /** Everything the confirmation UI needs, already resolved. */
  summary: {
    title?: string;
    parentId?: string | null;
    parentLabel?: string;
    createsPath?: string[];
    when?: Date | null;
    recurrence?: Recurrence | null;
    priority?: number;
    targetId?: string;
    targetLabel?: string;
    query?: string;
  };
  confidence: number;
  /** Present when the command cannot become an op — shown to the user. */
  problem?: string;
}

export interface ParseContext {
  items: Item[];
  locale: Locale;
  now?: Date;
  defaultHour?: number;
}

export interface ParseResult {
  commands: ParsedCommand[];
  ops: BatchOp[];
  transcript: string;
}

/** Root-to-node label used for fuzzy path matching ("cars corolla"). */
function pathLabel(item: Item, byId: Map<string, Item>): string {
  const parts: string[] = [];
  let cursor: Item | undefined = item;
  let guard = 0;
  while (cursor && guard++ < 12) {
    parts.unshift(cursor.title);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return parts.join(' ');
}

export interface ItemMatch {
  item: Item;
  score: number;
  label: string;
}

/**
 * Resolve a spoken phrase to an item. Matching considers both the item's own
 * title and its full path, so "cars corolla" and "corolla" both land on the
 * same node.
 */
export function matchItem(phrase: string, items: Item[], minScore = 0.42): ItemMatch | null {
  const needle = phrase.trim().toLowerCase();
  if (!needle) return null;
  const byId = new Map(items.map((i) => [i.id, i]));

  let best: ItemMatch | null = null;
  for (const item of items) {
    if (item.deletedAt) continue;
    const title = item.title.toLowerCase();
    const path = pathLabel(item, byId).toLowerCase();

    let score = Math.max(similarity(needle, title), similarity(needle, path));
    if (title === needle || path === needle) score = 1;
    else if (title.includes(needle) || needle.includes(title)) score = Math.max(score, 0.82);
    else if (path.includes(needle)) score = Math.max(score, 0.7);

    if (!best || score > best.score) best = { item, score, label: pathLabel(item, byId) };
  }
  return best && best.score >= minScore ? best : null;
}

/** Strip leading verbs, fillers and connectors from a fragment. */
function stripLeading(text: string, phrases: string[]): { text: string; matched: string | null } {
  const sorted = [...phrases].sort((a, b) => b.length - a.length);
  for (const phrase of sorted) {
    if (!phrase) continue;
    if (text === phrase) return { text: '', matched: phrase };
    if (text.startsWith(`${phrase} `)) {
      return { text: text.slice(phrase.length + 1).trim(), matched: phrase };
    }
  }
  return { text, matched: null };
}

const INTENT_ORDER = (lex: Lexicon): Array<[Intent, string[]]> => [
  ['undo', lex.verbs.undo],
  ['remind', lex.verbs.remind],
  ['complete', lex.verbs.complete],
  ['delete', lex.verbs.delete],
  ['move', lex.verbs.move],
  ['pin', lex.verbs.pin],
  ['search', lex.verbs.search],
  ['open', lex.verbs.open],
  ['create', lex.verbs.create],
];

function detectIntent(text: string, lex: Lexicon): { intent: Intent; rest: string } {
  for (const [intent, phrases] of INTENT_ORDER(lex)) {
    const { text: rest, matched } = stripLeading(text, phrases);
    if (matched) return { intent, rest };
  }

  // Arabic and Russian happily put the time first — "بعد ساعتين ذكرني بالاجتماع",
  // "через 20 минут напомни …" — so fall back to finding the verb anywhere.
  let best: { intent: Intent; index: number; phrase: string } | null = null;
  for (const [intent, phrases] of INTENT_ORDER(lex)) {
    for (const phrase of phrases) {
      if (!phrase) continue;
      const index = text.indexOf(` ${phrase} `);
      const at = index === -1 ? (text.endsWith(` ${phrase}`) ? text.length - phrase.length - 1 : -1) : index;
      if (at === -1) continue;
      if (!best || at < best.index || (at === best.index && phrase.length > best.phrase.length)) {
        best = { intent, index: at, phrase };
      }
    }
  }
  if (best) {
    const rest = (text.slice(0, best.index) + ' ' + text.slice(best.index + best.phrase.length + 1))
      .replace(/\s+/gu, ' ')
      .trim();
    return { intent: best.intent, rest };
  }

  return { intent: 'unknown', rest: text };
}

/**
 * Split an utterance on connector words — but only where the next fragment
 * actually starts a new instruction. Without that guard, "buy bread and
 * butter" would become two tasks.
 */
/**
 * Arabic writes "and" as a "و" glued to the following word ("وذكرني" = "and
 * remind me"), so the connector never appears as a standalone token. Detach it
 * wherever the remainder is a known verb, and the normal splitter takes over.
 */
function detachArabicWaw(text: string, lex: Lexicon): string {
  const verbs = Object.values(lex.verbs).flat();
  return text.replace(/(^|\s)و([\p{L}]+)/gu, (match, lead: string, word: string) =>
    verbs.some((v) => v === word || v.startsWith(word) || word.startsWith(v)) ? `${lead}و ${word}` : match,
  );
}

export function splitCommands(text: string, lex: Lexicon, locale?: string): string[] {
  const prepared = locale === 'ar' ? detachArabicWaw(text, lex) : text;
  const connectors = [...lex.connectors].sort((a, b) => b.length - a.length);
  const allVerbs = Object.values(lex.verbs).flat();

  const startsCommand = (fragment: string) => {
    const trimmed = fragment.trim();
    if (!trimmed) return false;
    return allVerbs.some((v) => trimmed === v || trimmed.startsWith(`${v} `));
  };

  const pieces: string[] = [];
  let remaining = ` ${prepared} `;

  let guard = 0;
  while (guard++ < 40) {
    let cutAt = -1;
    let cutLength = 0;
    for (const connector of connectors) {
      // Scan every occurrence — the first "and" may be inside a title.
      let from = 1;
      for (;;) {
        const index = remaining.indexOf(connector, from);
        if (index === -1) break;
        if (startsCommand(remaining.slice(index + connector.length))) {
          if (cutAt === -1 || index < cutAt) {
            cutAt = index;
            cutLength = connector.length;
          }
          break;
        }
        from = index + 1;
      }
    }
    if (cutAt === -1) break;
    pieces.push(remaining.slice(0, cutAt).trim());
    remaining = ` ${remaining.slice(cutAt + cutLength).trim()} `;
  }

  pieces.push(remaining.trim());
  return pieces.map((p) => p.trim()).filter(Boolean);
}

/** Pull "under cars corolla" out of a fragment and resolve it to a real node. */
function extractParent(
  text: string,
  lex: Lexicon,
  items: Item[],
): { rest: string; parentId: string | null; parentLabel?: string; createsPath?: string[] } {
  const words = [...lex.underWords].sort((a, b) => b.length - a.length);
  for (const word of words) {
    const marker = ` ${word} `;
    const index = text.indexOf(marker);
    if (index === -1) continue;
    const before = text.slice(0, index).trim();
    const after = text.slice(index + marker.length).trim();
    if (!after || !before) continue;

    // The phrase after the marker may itself carry a path: "cars, corolla".
    const segments = after.split(/\s*(?:,|،|>|\/|then|ثم|потом)\s*/u).filter(Boolean);
    const match = matchItem(after, items) ?? matchItem(segments[segments.length - 1], items);
    if (match) return { rest: before, parentId: match.item.id, parentLabel: match.label };
    return { rest: before, parentId: null, createsPath: segments };
  }
  return { rest: text, parentId: null };
}

function extractPriority(text: string, lex: Lexicon): { rest: string; priority?: number } {
  const table: Array<[number, string[]]> = [
    [4, lex.priority.critical],
    [3, lex.priority.high],
    [1, lex.priority.low],
  ];
  for (const [priority, phrases] of table) {
    for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
      if (!phrase) continue;
      const pattern = new RegExp(`(^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'u');
      if (pattern.test(text)) return { rest: text.replace(pattern, ' ').replace(/\s+/g, ' ').trim(), priority };
    }
  }
  return { rest: text };
}

function cleanTitle(text: string, lex: Lexicon): string {
  let out = text;
  // Day-part and am/pm words are time modifiers. Once a time has been parsed
  // out, any that survive at the edges are residue, not part of the title.
  const danglers = [
    ...lex.fillers,
    ...lex.atWords,
    ...lex.onWords,
    ...lex.inWords,
    ...lex.underWords,
    ...Object.keys(lex.dayParts),
    ...lex.amWords,
    ...lex.pmWords,
  ];

  for (let i = 0; i < 6; i++) {
    const { text: next, matched } = stripLeading(out, danglers);
    if (!matched) break;
    out = next;
  }

  // …and the same words left stranded at the end once a date was removed.
  for (let i = 0; i < 4; i++) {
    const before = out;
    for (const word of [...danglers].sort((a, b) => b.length - a.length)) {
      if (!word) continue;
      if (out === word) out = '';
      else if (out.endsWith(` ${word}`)) out = out.slice(0, -(word.length + 1)).trim();
    }
    if (out === before) break;
  }

  return out.replace(/\s+/gu, ' ').replace(/^[,،.\s-]+|[,،.\s-]+$/gu, '').trim();
}

export function parseUtterance(rawTranscript: string, ctx: ParseContext): ParseResult {
  const locale = ctx.locale;
  const lex = lexiconFor(locale);
  const now = ctx.now ?? new Date();
  const transcript = normalize(rawTranscript, locale);
  const commands: ParsedCommand[] = [];

  if (!transcript) return { commands, ops: [], transcript: rawTranscript };

  const fragments = splitCommands(transcript, lex, locale);
  let createdSomethingEarlier = false;

  for (const fragment of fragments) {
    const { intent, rest } = detectIntent(fragment, lex);
    const command = buildCommand(intent, rest, fragment, {
      lex,
      locale,
      items: ctx.items,
      now,
      defaultHour: ctx.defaultHour ?? 9,
      allowUseLast: createdSomethingEarlier,
    });
    if (command.op?.op === 'create_item') createdSomethingEarlier = true;
    commands.push(command);
  }

  return {
    commands,
    ops: commands.map((c) => c.op).filter((op): op is BatchOp => Boolean(op)),
    transcript: rawTranscript,
  };
}

interface BuildContext {
  lex: Lexicon;
  locale: Locale;
  items: Item[];
  now: Date;
  defaultHour: number;
  allowUseLast: boolean;
}

function buildCommand(intent: Intent, rest: string, raw: string, ctx: BuildContext): ParsedCommand {
  const { lex, locale, items, now, defaultHour } = ctx;

  switch (intent) {
    case 'undo':
      return { intent, raw, summary: {}, confidence: 0.9 };

    case 'create':
    case 'unknown': {
      // An unrecognised fragment is treated as "add this" — the single most
      // likely meaning when someone talks to a to-do app.
      const when = parseWhen(rest, locale, now, { defaultHour });
      const withoutTime = stripSpans(rest, when.spans);
      const parent = extractParent(withoutTime, lex, items);
      const priorityInfo = extractPriority(parent.rest, lex);
      const title = cleanTitle(priorityInfo.rest, lex);

      if (!title) {
        return {
          intent: 'unknown',
          raw,
          summary: {},
          confidence: 0.1,
          problem: 'no_title',
        };
      }

      const op: BatchOp = {
        op: 'create_item',
        title,
        icon: iconForTitle(title),
        ...(parent.parentId ? { parentId: parent.parentId } : {}),
        ...(parent.createsPath?.length
          ? { parentPath: parent.createsPath, createMissingPath: true }
          : {}),
        ...(when.at ? { dueAt: when.at.toISOString() } : {}),
        ...(when.recurrence ? { recurrence: when.recurrence } : {}),
        ...(priorityInfo.priority !== undefined ? { priority: priorityInfo.priority } : {}),
      };

      return {
        intent: 'create',
        raw,
        op,
        summary: {
          title,
          parentId: parent.parentId,
          parentLabel: parent.parentLabel,
          createsPath: parent.createsPath,
          when: when.at,
          recurrence: when.recurrence,
          priority: priorityInfo.priority,
        },
        confidence: intent === 'create' ? 0.92 : 0.6,
      };
    }

    case 'remind': {
      const when = parseWhen(rest, locale, now, { defaultHour });
      const withoutTime = stripSpans(rest, when.spans);
      const subject = cleanTitle(withoutTime, lex);

      if (!when.at) {
        return { intent, raw, summary: { title: subject }, confidence: 0.3, problem: 'no_time' };
      }

      // "remind me tomorrow at 8" right after creating something attaches to it.
      const existing = subject ? matchItem(subject, items, 0.55) : null;

      if (!subject && ctx.allowUseLast) {
        return {
          intent,
          raw,
          op: { op: 'create_reminder', target: { useLast: true }, fireAt: when.at.toISOString(), rrule: when.recurrence },
          summary: { when: when.at, recurrence: when.recurrence, targetLabel: '' },
          confidence: 0.85,
        };
      }

      if (existing && existing.score >= 0.55) {
        return {
          intent,
          raw,
          op: {
            op: 'create_reminder',
            target: { id: existing.item.id },
            fireAt: when.at.toISOString(),
            rrule: when.recurrence,
          },
          summary: {
            when: when.at,
            recurrence: when.recurrence,
            targetId: existing.item.id,
            targetLabel: existing.label,
          },
          confidence: 0.88,
        };
      }

      // Nothing matched — create the task and its alarm in one go.
      if (subject) {
        return {
          intent,
          raw,
          op: {
            op: 'create_item',
            title: subject,
            icon: iconForTitle(subject),
            dueAt: when.at.toISOString(),
            recurrence: when.recurrence,
          },
          summary: { title: subject, when: when.at, recurrence: when.recurrence },
          confidence: 0.75,
        };
      }

      return { intent, raw, summary: { when: when.at }, confidence: 0.2, problem: 'no_target' };
    }

    case 'complete':
    case 'delete':
    case 'pin': {
      const query = cleanTitle(rest, lex);
      if (!query) return { intent, raw, summary: {}, confidence: 0.15, problem: 'no_target' };
      const match = matchItem(query, items, 0.45);
      if (!match) {
        return { intent, raw, summary: { query }, confidence: 0.3, problem: 'not_found' };
      }
      const op: BatchOp =
        intent === 'complete'
          ? { op: 'complete_item', target: { id: match.item.id }, done: true }
          : intent === 'delete'
            ? { op: 'delete_item', target: { id: match.item.id } }
            : { op: 'update_item', target: { id: match.item.id }, pinned: !match.item.pinned };
      return {
        intent,
        raw,
        op,
        summary: { targetId: match.item.id, targetLabel: match.label, query },
        confidence: 0.6 + match.score * 0.35,
      };
    }

    case 'move': {
      const parent = extractParent(rest, lex, items);
      const query = cleanTitle(parent.rest, lex);
      const match = query ? matchItem(query, items, 0.45) : null;
      if (!match) return { intent, raw, summary: { query }, confidence: 0.25, problem: 'not_found' };
      if (!parent.parentId && !parent.createsPath?.length) {
        return { intent, raw, summary: { targetLabel: match.label }, confidence: 0.3, problem: 'no_destination' };
      }
      return {
        intent,
        raw,
        op: {
          op: 'move_item',
          target: { id: match.item.id },
          ...(parent.parentId ? { parentId: parent.parentId } : { parentPath: parent.createsPath, createMissingPath: true }),
        },
        summary: {
          targetId: match.item.id,
          targetLabel: match.label,
          parentId: parent.parentId,
          parentLabel: parent.parentLabel,
          createsPath: parent.createsPath,
        },
        confidence: 0.8,
      };
    }

    case 'open':
    case 'search': {
      const query = cleanTitle(rest, lex);
      const match = intent === 'open' && query ? matchItem(query, items, 0.45) : null;
      return {
        intent,
        raw,
        summary: { query, targetId: match?.item.id, targetLabel: match?.label },
        confidence: query ? 0.7 : 0.2,
        ...(query ? {} : { problem: 'no_target' }),
      };
    }

    default:
      return { intent: 'unknown', raw, summary: {}, confidence: 0 };
  }
}
