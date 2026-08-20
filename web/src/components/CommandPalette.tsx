import { motion } from 'framer-motion';
import { CornerDownLeft, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { itemPath, useData } from '../store/data';
import { useTranslation, useUi } from '../store/ui';
import { Modal } from './ui';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: string;
  run(): void;
}

/** Ctrl/Cmd-K: jump anywhere, or search every item on the server. */
export function CommandPalette() {
  const { dict } = useTranslation();
  const open = useUi((s) => s.commandPaletteOpen);
  const setOpen = useUi((s) => s.setCommandPalette);
  const setVoiceOpen = useUi((s) => s.setVoiceOpen);
  const openDetail = useUi((s) => s.openDetail);
  const items = useData((s) => s.items);
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<Array<{ id: string; title: string; icon: string }>>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      window.setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [open]);

  // Local matching is instant; the server search fills in anything the client
  // has not loaded (notes, tags) once typing pauses.
  useEffect(() => {
    if (query.trim().length < 2) {
      setRemote([]);
      return;
    }
    const timer = window.setTimeout(() => {
      api
        .search(query.trim())
        .then((results) => setRemote(results.map((r) => ({ id: r.id, title: r.title, icon: r.icon }))))
        .catch(() => setRemote([]));
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  const navigationCommands = useMemo<Command[]>(
    () => [
      { id: 'nav-today', label: dict.nav.today, icon: '☀️', run: () => navigate('/') },
      { id: 'nav-galaxy', label: dict.nav.galaxy, icon: '🪐', run: () => navigate('/galaxy') },
      { id: 'nav-list', label: dict.nav.list, icon: '🗂️', run: () => navigate('/list') },
      { id: 'nav-focus', label: dict.nav.focus, icon: '🎯', run: () => navigate('/focus') },
      { id: 'nav-timeline', label: dict.nav.timeline, icon: '📊', run: () => navigate('/timeline') },
      { id: 'nav-canvas', label: dict.nav.canvas, icon: '✏️', run: () => navigate('/draw') },
      { id: 'nav-alarms', label: dict.nav.alarms, icon: '⏰', run: () => navigate('/alarms') },
      { id: 'nav-insights', label: dict.nav.insights, icon: '📈', run: () => navigate('/insights') },
      { id: 'nav-settings', label: dict.nav.settings, icon: '⚙️', run: () => navigate('/settings') },
      { id: 'nav-trash', label: dict.nav.trash, icon: '🗑️', run: () => navigate('/trash') },
      { id: 'voice', label: dict.voice.title, icon: '🎙️', run: () => setVoiceOpen(true) },
    ],
    [dict, navigate, setVoiceOpen],
  );

  const results = useMemo<Command[]>(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return navigationCommands;

    const local = items
      .filter((item) => !item.deletedAt && item.title.toLowerCase().includes(needle))
      .slice(0, 12)
      .map((item) => ({
        id: `item-${item.id}`,
        label: item.title,
        icon: item.icon || '•',
        hint: itemPath(items, item.id).slice(0, -1).map((p) => p.title).join(' › '),
        run: () => openDetail(item.id),
      }));

    const localIds = new Set(local.map((c) => c.id));
    const extra = remote
      .filter((r) => !localIds.has(`item-${r.id}`))
      .slice(0, 8)
      .map((r) => ({
        id: `remote-${r.id}`,
        label: r.title,
        icon: r.icon || '•',
        run: () => openDetail(r.id),
      }));

    const navMatches = navigationCommands.filter((c) => c.label.toLowerCase().includes(needle));
    return [...local, ...extra, ...navMatches];
  }, [query, items, remote, navigationCommands, openDetail]);

  const activate = (command: Command | undefined) => {
    if (!command) return;
    command.run();
    setOpen(false);
  };

  return (
    <Modal open={open} onClose={() => setOpen(false)} width={620}>
      <div className="palette">
        <div className="palette__search">
          <Search size={18} className="faint" />
          <input
            ref={inputRef}
            className="palette__input"
            placeholder={dict.common.searchPlaceholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setCursor((c) => Math.min(results.length - 1, c + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (event.key === 'Enter') {
                activate(results[cursor]);
              }
            }}
          />
          <kbd className="palette__kbd">esc</kbd>
        </div>

        <ul className="palette__list" role="listbox">
          {results.map((command, index) => (
            <li key={command.id}>
              <button
                role="option"
                aria-selected={index === cursor}
                className={`palette__item ${index === cursor ? 'is-active' : ''}`}
                onMouseEnter={() => setCursor(index)}
                onClick={() => activate(command)}
              >
                <span className="palette__icon">{command.icon}</span>
                <span className="grow truncate">{command.label}</span>
                {command.hint && <span className="faint truncate">{command.hint}</span>}
                {index === cursor && <CornerDownLeft size={14} className="faint" />}
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="palette__empty muted">{dict.common.empty}</li>}
        </ul>

        {index_hint(results.length) && (
          <motion.p className="palette__footer faint" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            ↑ ↓ · ⏎
          </motion.p>
        )}
      </div>
    </Modal>
  );
}

const index_hint = (count: number) => count > 0;
