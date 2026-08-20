/** Small text utilities shared by the voice parser, search and the UI. */

export function trigrams(text: string): Set<string> {
  const padded = ` ${text.toLowerCase().replace(/\s+/g, ' ').trim()} `;
  const out = new Set<string>();
  for (let i = 0; i < Math.max(1, padded.length - 2); i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Jaccard similarity over character trigrams — 0 (nothing alike) to 1 (identical). */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const g of ta) if (tb.has(g)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export function titleCase(text: string): string {
  return text.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

/**
 * Deterministic colour for a title, so untinted categories still feel distinct.
 * The comma form of `hsl()` is deliberate: Three.js's colour parser does not
 * understand the space-separated CSS Color 4 syntax and silently returns white,
 * which turned every untinted world in the Galaxy view grey.
 */
export function colorFromString(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue}, 72%, 62%)`;
}

/** Pick a readable emoji for a new item based on words it contains. */
const ICON_HINTS: Array<[RegExp, string]> = [
  [/car|vehicle|drive|tyre|tire|oil|سياره|سيارات|машин|авто/iu, '🚗'],
  [/clean|wash|tidy|نظف|تنظيف|убор|мыть/iu, '🧽'],
  [/home|house|بيت|منزل|дом/iu, '🏠'],
  [/work|office|meeting|عمل|اجتماع|работ|встреч/iu, '💼'],
  [/buy|shop|grocer|market|شراء|تسوق|купить|магазин/iu, '🛒'],
  [/call|phone|اتصل|звон|позвон/iu, '📞'],
  [/mail|email|بريد|почт|письм/iu, '✉️'],
  [/doctor|dentist|health|طبيب|صحه|врач|здоров/iu, '🩺'],
  [/gym|run|sport|exercise|رياضه|спорт|трениров/iu, '🏋️'],
  [/pay|bill|bank|money|فاتوره|دفع|بنك|плат|счет|банк/iu, '💳'],
  [/study|read|book|learn|دراسه|كتاب|قراءه|учеб|книг/iu, '📚'],
  [/travel|flight|trip|سفر|رحله|поезд|полет/iu, '✈️'],
  [/food|cook|eat|dinner|طبخ|اكل|еда|готов/iu, '🍳'],
  [/plant|water|garden|نبات|حديقه|раст|полив|сад/iu, '🪴'],
  [/birthday|gift|عيد|هديه|подарок|день рожд/iu, '🎁'],
  [/insurance|document|paper|تامين|وثيقه|страхов|документ/iu, '📄'],
];

export function iconForTitle(title: string): string {
  for (const [pattern, icon] of ICON_HINTS) if (pattern.test(title)) return icon;
  return '';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
