import { motion, AnimatePresence } from 'framer-motion';
import { CornerDownLeft, Plus, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { formatWhen } from '../lib/format';
import { parseUtterance } from '../lib/nlp/command';
import { iconForTitle } from '../lib/text';
import type { CategorySuggestion, Item } from '../lib/types';
import { useAuth } from '../store/auth';
import { useData, itemPath } from '../store/data';
import { useTranslation, useUi } from '../store/ui';

/**
 * The typed twin of the voice bar. It runs the *same* parser, so
 * "oil change under cars corolla tomorrow at 8" typed by hand behaves exactly
 * like the spoken version, and shows what it understood before you commit.
 */
export function QuickAdd({ parentId = null, autoFocus }: { parentId?: string | null; autoFocus?: boolean }) {
  const { dict, locale } = useTranslation();
  const toast = useUi((s) => s.toast);
  const items = useData((s) => s.items);
  const createItem = useData((s) => s.createItem);
  const refresh = useData((s) => s.refresh);
  const settings = useAuth((s) => s.user?.settings);

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<CategorySuggestion[]>([]);
  const [chosenParent, setChosenParent] = useState<string | null>(parentId);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setChosenParent(parentId), [parentId]);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Live preview of what the parser makes of the text.
  const preview = useMemo(() => {
    if (text.trim().length < 2) return null;
    const { commands } = parseUtterance(text, {
      items,
      locale,
      defaultHour: Number(settings?.workStartHour ?? 9),
    });
    return commands[0] ?? null;
  }, [text, items, locale, settings?.workStartHour]);

  // Ask the server where this probably belongs, but only once typing settles.
  useEffect(() => {
    const title = preview?.summary.title;
    if (!title || title.length < 3 || preview?.summary.parentId || parentId) {
      setSuggestions([]);
      return;
    }
    const timer = window.setTimeout(() => {
      api
        .categorize(title)
        .then((results) => setSuggestions(results.filter((r) => r.confidence >= 0.35).slice(0, 3)))
        .catch(() => setSuggestions([]));
    }, 320);
    return () => window.clearTimeout(timer);
  }, [preview?.summary.title, preview?.summary.parentId, parentId]);

  const parentLabel = (id: string | null): string => {
    if (!id) return dict.item.root;
    const path = itemPath(items, id);
    return path.map((p) => p.title).join(' › ');
  };

  async function submit() {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const { commands, ops } = parseUtterance(value, {
        items,
        locale,
        defaultHour: Number(settings?.workStartHour ?? 9),
      });
      const usable = ops.length ? ops : null;

      if (usable && (commands.length > 1 || commands[0]?.intent !== 'create')) {
        // Multi-part or non-create input goes through the same batch endpoint
        // the voice pipeline uses, undo included.
        const result = await api.runBatch(usable as any, value);
        await refresh({ silent: true });
        toast(dict.voice.applied.replace('{n}', String(result.applied)), 'success', {
          action: {
            label: dict.common.undo,
            run: () => void api.undoBatch(result.undoId).then(() => refresh({ silent: true })),
          },
        });
      } else {
        const parsed = commands[0];
        const title = parsed?.summary.title ?? value;
        const created = await createItem({
          title,
          icon: iconForTitle(title),
          parentId: chosenParent ?? parsed?.summary.parentId ?? null,
          dueAt: parsed?.summary.when ? parsed.summary.when.toISOString() : null,
          recurrence: parsed?.summary.recurrence ?? null,
          priority: parsed?.summary.priority ?? 2,
        } as Partial<Item> & { title: string });
        if (created) toast(`${created.icon || '✓'} ${created.title}`, 'success');
      }
      setText('');
      setSuggestions([]);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const showPreview =
    preview && (preview.summary.when || preview.summary.parentLabel || preview.summary.recurrence);

  return (
    <div className="quick-add">
      <div className="quick-add__field glass">
        <Plus size={18} className="quick-add__icon" />
        <input
          ref={inputRef}
          className="quick-add__input"
          value={text}
          placeholder={
            parentId ? dict.item.newIn.replace('{name}', parentLabel(parentId)) : dict.item.titlePlaceholder
          }
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
            if (event.key === 'Escape') setText('');
          }}
          aria-label={dict.item.newItem}
        />
        <button className="btn btn-primary btn-sm" onClick={() => void submit()} disabled={!text.trim() || busy}>
          <CornerDownLeft size={15} />
          {dict.common.add}
        </button>
      </div>

      <AnimatePresence>
        {showPreview && (
          <motion.div
            className="quick-add__preview"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
          >
            <Sparkles size={13} />
            <strong>{preview.summary.title}</strong>
            {preview.summary.parentLabel && <span className="chip">{preview.summary.parentLabel}</span>}
            {preview.summary.when && (
              <span className="chip">{formatWhen(preview.summary.when, locale, dict)}</span>
            )}
            {preview.summary.recurrence && <span className="chip">{dict.item.repeats}</span>}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {suggestions.length > 0 && (
          <motion.div
            className="quick-add__suggestions"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
          >
            <span className="faint">{dict.item.parent}:</span>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.id}
                className={`chip chip--action ${chosenParent === suggestion.id ? 'is-active' : ''}`}
                onClick={() => setChosenParent(chosenParent === suggestion.id ? null : suggestion.id)}
                title={suggestion.matchedTerms.join(', ')}
              >
                {suggestion.title}
                <span className="faint mono">{Math.round(suggestion.confidence * 100)}%</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
