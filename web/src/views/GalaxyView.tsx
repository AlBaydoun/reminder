import { motion } from 'framer-motion';
import { Orbit, Sparkles } from 'lucide-react';
import { Suspense, lazy, useMemo, useState } from 'react';
import { EmptyState, Spinner } from '../components/ui';
import { buildTree, findNode, useData } from '../store/data';
import { useTranslation, useUi } from '../store/ui';

// The WebGL bundle is large and only this view needs it, so it loads on demand.
const GalaxyScene = lazy(() =>
  import('../three/GalaxyScene').then((module) => ({ default: module.GalaxyScene })),
);

export function GalaxyView() {
  const { dict } = useTranslation();
  const items = useData((s) => s.items);
  const effects = useUi((s) => s.effects);
  const motionLevel = useUi((s) => s.motion);
  const theme = useUi((s) => s.theme);
  const openDetail = useUi((s) => s.openDetail);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rootId, setRootId] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(items), [items]);
  const nodes = useMemo(() => {
    if (!rootId) return tree;
    return findNode(tree, rootId)?.children ?? tree;
  }, [tree, rootId]);

  const rootNode = rootId ? findNode(tree, rootId) : null;

  if (!effects.threeD) {
    return (
      <div className="view view--galaxy">
        <EmptyState
          icon={<Orbit size={34} />}
          title={dict.galaxy.title}
          hint={dict.settings.motionHint}
        />
      </div>
    );
  }

  if (!nodes.length) {
    return (
      <div className="view view--galaxy">
        <EmptyState icon={<Sparkles size={34} />} title={dict.galaxy.empty} />
      </div>
    );
  }

  return (
    <div className="view view--galaxy">
      <div className="galaxy-canvas">
        <Suspense
          fallback={
            <div className="galaxy-loading">
              <Spinner size={26} />
            </div>
          }
        >
          <GalaxyScene
            nodes={nodes}
            focusedId={selectedId}
            quality={motionLevel === 'full' ? 'full' : 'balanced'}
            theme={theme}
            onSelect={(id) => setSelectedId(id || null)}
            onEnter={(id) => {
              const node = findNode(tree, id);
              if (node?.children.length) setRootId(id);
              else openDetail(id);
            }}
          />
        </Suspense>

        <motion.div
          className="galaxy-overlay"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="galaxy-overlay__bar glass">
            {rootNode ? (
              <button className="btn btn-sm btn-ghost" onClick={() => setRootId(null)}>
                ← {dict.galaxy.back}
              </button>
            ) : (
              <span className="faint">{dict.galaxy.hint}</span>
            )}
            {rootNode && <strong className="truncate">{rootNode.item.title}</strong>}
          </div>
        </motion.div>

        {selectedId && (
          <motion.div
            className="galaxy-selection glass"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <SelectionCard id={selectedId} onOpen={() => openDetail(selectedId)} onEnter={() => setRootId(selectedId)} />
          </motion.div>
        )}
      </div>
    </div>
  );
}

function SelectionCard({ id, onOpen, onEnter }: { id: string; onOpen(): void; onEnter(): void }) {
  const { dict } = useTranslation();
  const items = useData((s) => s.items);
  const tree = useMemo(() => buildTree(items), [items]);
  const node = findNode(tree, id);
  if (!node) return null;

  return (
    <>
      <span className="galaxy-selection__icon">{node.item.icon || '🌐'}</span>
      <div className="grow">
        <strong className="truncate">{node.item.title}</strong>
        {node.totalDescendants > 0 && (
          <p className="faint mono">
            {dict.item.progress
              .replace('{done}', String(node.doneDescendants))
              .replace('{total}', String(node.totalDescendants))}
          </p>
        )}
      </div>
      {node.children.length > 0 && (
        <button className="btn btn-sm" onClick={onEnter}>
          {dict.galaxy.enter}
        </button>
      )}
      <button className="btn btn-sm btn-primary" onClick={onOpen}>
        {dict.common.edit}
      </button>
    </>
  );
}
