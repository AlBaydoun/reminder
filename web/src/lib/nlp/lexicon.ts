import type { Locale } from '../types';

/** Per-language vocabulary the date parser and command parser both draw on. */
export interface Lexicon {
  weekdays: Record<string, number>;
  months: Record<string, number>;
  /** Offset in days from today. */
  relativeDays: Record<string, number>;
  /** Word → default hour of day. */
  dayParts: Record<string, number>;
  amWords: string[];
  pmWords: string[];
  units: Record<string, 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'>;
  /** Words that already imply a plural count of two ("ساعتين" = two hours). */
  dualUnits: Record<string, { unit: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'; count: number }>;
  every: string[];
  inWords: string[];
  atWords: string[];
  onWords: string[];
  nextWords: string[];
  thisWords: string[];
  /** Phrases that split one utterance into several commands. */
  connectors: string[];
  /** Phrases meaning "inside this category". */
  underWords: string[];
  verbs: {
    create: string[];
    remind: string[];
    complete: string[];
    delete: string[];
    move: string[];
    open: string[];
    search: string[];
    undo: string[];
    pin: string[];
  };
  priority: { high: string[]; critical: string[]; low: string[] };
  fillers: string[];
  /** "every day" style shorthands mapping straight to a frequency. */
  frequencyWords: Record<string, 'daily' | 'weekly' | 'monthly' | 'yearly'>;
  weekdayShorthand: Record<string, number[]>;
}

const EN: Lexicon = {
  weekdays: {
    sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
    thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
  },
  months: {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
    june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
    october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  },
  relativeDays: { today: 0, tonight: 0, tomorrow: 1, tmr: 1, tmrw: 1, 'day after tomorrow': 2, yesterday: -1 },
  dayParts: {
    morning: 9, noon: 12, midday: 12, afternoon: 15, evening: 19, tonight: 20, night: 21,
    midnight: 0, dawn: 6, 'end of day': 17, lunch: 13, lunchtime: 13, breakfast: 8, dinner: 20,
  },
  amWords: ['am', 'a.m', 'a.m.', 'in the morning'],
  pmWords: ['pm', 'p.m', 'p.m.', 'in the evening', 'in the afternoon', 'at night'],
  units: {
    minute: 'minute', minutes: 'minute', min: 'minute', mins: 'minute',
    hour: 'hour', hours: 'hour', hr: 'hour', hrs: 'hour',
    day: 'day', days: 'day', week: 'week', weeks: 'week',
    month: 'month', months: 'month', year: 'year', years: 'year',
  },
  dualUnits: {},
  every: ['every', 'each', 'evry'],
  inWords: ['in', 'after', 'within'],
  atWords: ['at', 'around', '@'],
  onWords: ['on', 'this coming'],
  nextWords: ['next', 'coming', 'upcoming'],
  thisWords: ['this'],
  connectors: [
    ' and then ', ' and also ', ' then also ', ' after that ', ' also ', ' and ', ' then ',
    ' plus ', '; ', ' , and ',
  ],
  underWords: ['under', 'inside', 'in the', 'into', 'to the list', 'in category', 'in my'],
  verbs: {
    create: ['add', 'create', 'new', 'make', 'put', 'note', 'jot down', 'start'],
    remind: ['remind me', 'remind', 'set an alarm', 'set alarm', 'alarm', 'wake me', 'alert me', 'ping me'],
    complete: ['complete', 'finish', 'done', 'mark done', 'check off', 'tick off', 'completed'],
    delete: ['delete', 'remove', 'drop', 'get rid of', 'cancel'],
    move: ['move', 'put'],
    open: ['open', 'show', 'go to', 'take me to'],
    search: ['find', 'search', 'look for', 'where is'],
    undo: ['undo', 'never mind', 'nevermind', 'scratch that'],
    pin: ['pin', 'star', 'favourite', 'favorite'],
  },
  priority: {
    high: ['high priority', 'important', 'priority high'],
    critical: ['urgent', 'critical', 'asap', 'right away', 'emergency'],
    low: ['low priority', 'whenever', 'someday', 'not urgent'],
  },
  fillers: ['please', 'can you', 'could you', 'i want to', 'i need to', 'to', 'the', 'a', 'an', 'my'],
  frequencyWords: { daily: 'daily', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly', annually: 'yearly' },
  weekdayShorthand: {
    weekday: [1, 2, 3, 4, 5],
    weekdays: [1, 2, 3, 4, 5],
    weekend: [0, 6],
    weekends: [0, 6],
  },
};

// Arabic entries are written in their normalized form (no diacritics,
// أإآ → ا, ى → ي, ة → ه) because the parser normalizes input the same way.
const AR: Lexicon = {
  weekdays: {
    'الاحد': 0, 'احد': 0, 'الاثنين': 1, 'اثنين': 1, 'الاتنين': 1, 'التنين': 1,
    'الثلاثاء': 2, 'ثلاثاء': 2, 'التلات': 2, 'الاربعاء': 3, 'اربعاء': 3, 'الاربعا': 3,
    'الخميس': 4, 'خميس': 4, 'الجمعه': 5, 'جمعه': 5, 'السبت': 6, 'سبت': 6,
  },
  months: {
    'يناير': 1, 'كانون الثاني': 1, 'فبراير': 2, 'شباط': 2, 'مارس': 3, 'اذار': 3,
    'ابريل': 4, 'نيسان': 4, 'مايو': 5, 'ايار': 5, 'يونيو': 6, 'حزيران': 6,
    'يوليو': 7, 'تموز': 7, 'اغسطس': 8, 'اب': 8, 'سبتمبر': 9, 'ايلول': 9,
    'اكتوبر': 10, 'تشرين الاول': 10, 'نوفمبر': 11, 'تشرين الثاني': 11,
    'ديسمبر': 12, 'كانون الاول': 12,
  },
  relativeDays: { 'اليوم': 0, 'الليله': 0, 'غدا': 1, 'غد': 1, 'بكره': 1, 'بكرا': 1, 'بعد غد': 2, 'امس': -1, 'مبارح': -1 },
  dayParts: {
    'الصباح': 9, 'صباحا': 9, 'الفجر': 6, 'الظهر': 12, 'بعد الظهر': 15, 'العصر': 16,
    'المساء': 19, 'مساء': 19, 'الليل': 21, 'منتصف الليل': 0, 'الغدا': 13, 'العشا': 20,
  },
  amWords: ['صباحا', 'ص', 'الصباح', 'بالصباح'],
  pmWords: ['مساء', 'م', 'المساء', 'بالليل', 'بعد الظهر', 'ليلا'],
  units: {
    'دقيقه': 'minute', 'دقائق': 'minute', 'ساعه': 'hour', 'ساعات': 'hour',
    'يوم': 'day', 'ايام': 'day', 'اسبوع': 'week', 'اسابيع': 'week',
    'شهر': 'month', 'اشهر': 'month', 'شهور': 'month', 'سنه': 'year', 'سنوات': 'year', 'اعوام': 'year',
  },
  dualUnits: {
    'دقيقتين': { unit: 'minute', count: 2 },
    'ساعتين': { unit: 'hour', count: 2 },
    'يومين': { unit: 'day', count: 2 },
    'اسبوعين': { unit: 'week', count: 2 },
    'شهرين': { unit: 'month', count: 2 },
    'سنتين': { unit: 'year', count: 2 },
  },
  every: ['كل'],
  inWords: ['بعد', 'خلال'],
  atWords: ['الساعه', 'على الساعه', 'عند'],
  onWords: ['يوم', 'في'],
  nextWords: ['القادم', 'الجاي', 'المقبل', 'القادمه', 'الجايه'],
  thisWords: ['هذا', 'هذه', 'هالـ'],
  connectors: [' وبعدين ', ' وكمان ', ' وايضا ', ' بعد ذلك ', ' ثم ', ' و '],
  underWords: ['تحت', 'داخل', 'ضمن', 'في فئه', 'في قائمه', 'في'],
  verbs: {
    create: ['اضف', 'اضافه', 'ضيف', 'انشئ', 'سجل', 'اكتب', 'حط'],
    remind: ['ذكرني', 'نبهني', 'ضع منبه', 'منبه', 'صحيني', 'نبه'],
    complete: ['انه', 'انهي', 'خلص', 'تم', 'اكمل', 'انجز'],
    delete: ['احذف', 'امسح', 'شيل', 'الغي'],
    move: ['انقل', 'حرك', 'حول'],
    open: ['افتح', 'اعرض', 'روح على', 'وريني'],
    search: ['ابحث', 'دور على', 'وين'],
    undo: ['تراجع', 'الغي الامر', 'خلاص لا'],
    pin: ['ثبت', 'نجمه'],
  },
  priority: {
    high: ['اولويه عاليه', 'مهم', 'مهمه'],
    critical: ['عاجل', 'ضروري', 'حرج', 'فورا'],
    low: ['اولويه منخفضه', 'مش مستعجل', 'وقت ما يكون'],
  },
  fillers: ['من فضلك', 'لو سمحت', 'ان', 'ال', 'يا'],
  frequencyWords: { 'يوميا': 'daily', 'اسبوعيا': 'weekly', 'شهريا': 'monthly', 'سنويا': 'yearly' },
  weekdayShorthand: {
    'ايام العمل': [1, 2, 3, 4, 5],
    'ايام الاسبوع': [1, 2, 3, 4, 5],
    'عطله الاسبوع': [0, 6],
    'نهايه الاسبوع': [0, 6],
  },
};

const RU: Lexicon = {
  weekdays: {
    'воскресенье': 0, 'воскресение': 0, 'вс': 0, 'понедельник': 1, 'понедельника': 1, 'пн': 1,
    'вторник': 2, 'вторника': 2, 'вт': 2, 'среда': 3, 'среду': 3, 'среды': 3, 'ср': 3,
    'четверг': 4, 'четверга': 4, 'чт': 4, 'пятница': 5, 'пятницу': 5, 'пятницы': 5, 'пт': 5,
    'суббота': 6, 'субботу': 6, 'субботы': 6, 'сб': 6,
  },
  months: {
    'январь': 1, 'января': 1, 'февраль': 2, 'февраля': 2, 'март': 3, 'марта': 3,
    'апрель': 4, 'апреля': 4, 'май': 5, 'мая': 5, 'июнь': 6, 'июня': 6,
    'июль': 7, 'июля': 7, 'август': 8, 'августа': 8, 'сентябрь': 9, 'сентября': 9,
    'октябрь': 10, 'октября': 10, 'ноябрь': 11, 'ноября': 11, 'декабрь': 12, 'декабря': 12,
  },
  relativeDays: { 'сегодня': 0, 'завтра': 1, 'послезавтра': 2, 'вчера': -1 },
  dayParts: {
    'утром': 9, 'утра': 9, 'полдень': 12, 'днем': 15, 'днём': 15, 'вечером': 19,
    'ночью': 21, 'полночь': 0, 'рассвет': 6, 'обед': 13, 'ужин': 20,
  },
  amWords: ['утра', 'ночи'],
  pmWords: ['вечера', 'дня'],
  units: {
    'минута': 'minute', 'минуту': 'minute', 'минуты': 'minute', 'минут': 'minute', 'мин': 'minute',
    'час': 'hour', 'часа': 'hour', 'часов': 'hour', 'ч': 'hour',
    'день': 'day', 'дня': 'day', 'дней': 'day', 'сутки': 'day',
    'неделя': 'week', 'неделю': 'week', 'недели': 'week', 'недель': 'week',
    'месяц': 'month', 'месяца': 'month', 'месяцев': 'month',
    'год': 'year', 'года': 'year', 'лет': 'year',
  },
  dualUnits: {},
  every: ['каждый', 'каждую', 'каждое', 'каждые', 'ежедневно'],
  inWords: ['через', 'спустя'],
  atWords: ['в', 'во', 'около'],
  onWords: ['в', 'во'],
  nextWords: ['следующий', 'следующую', 'следующее', 'будущую', 'на следующей'],
  thisWords: ['этот', 'эту', 'это'],
  connectors: [' а потом ', ' и потом ', ' а также ', ' затем ', ' потом ', ' и ещё ', ' и еще ', ' и '],
  underWords: ['в категорию', 'внутрь', 'внутри', 'под', 'в'],
  verbs: {
    create: ['добавь', 'добавить', 'создай', 'создать', 'запиши', 'новая', 'новый'],
    remind: ['напомни', 'напомнить', 'поставь будильник', 'будильник', 'разбуди'],
    complete: ['выполни', 'выполнить', 'заверши', 'завершить', 'готово', 'сделано', 'отметь'],
    delete: ['удали', 'удалить', 'убери', 'отмени'],
    move: ['перемести', 'перенеси'],
    open: ['открой', 'покажи', 'перейди'],
    search: ['найди', 'поиск', 'где'],
    undo: ['отмени действие', 'откати', 'не надо'],
    pin: ['закрепи', 'звезда'],
  },
  priority: {
    high: ['высокий приоритет', 'важно', 'важное'],
    critical: ['срочно', 'критично', 'немедленно'],
    low: ['низкий приоритет', 'когда-нибудь', 'не срочно'],
  },
  fillers: ['пожалуйста', 'мне', 'надо', 'нужно'],
  frequencyWords: { 'ежедневно': 'daily', 'еженедельно': 'weekly', 'ежемесячно': 'monthly', 'ежегодно': 'yearly' },
  weekdayShorthand: {
    'будни': [1, 2, 3, 4, 5],
    'рабочие дни': [1, 2, 3, 4, 5],
    'выходные': [0, 6],
  },
};

export const LEXICONS: Record<Locale, Lexicon> = { en: EN, ar: AR, ru: RU };
export const lexiconFor = (locale: Locale): Lexicon => LEXICONS[locale] ?? EN;
