import { db, newId, nowIso } from '../db.js';

interface SeedNode {
  title: string;
  icon: string;
  color: string;
  notes?: string;
  children?: SeedNode[];
}

/**
 * A brand new account starts with a couple of shapes that demonstrate the
 * core idea: "Cars" holds children so it reads as a category, while "Clean
 * the kitchen" has none so it reads as a plain task. Both are the same row.
 */
const SEED: SeedNode[] = [
  {
    title: 'Cars',
    icon: '🚗',
    color: '#4cc2ff',
    notes: 'One child per vehicle. Each vehicle holds its own maintenance list.',
    children: [
      {
        title: 'Land Cruiser',
        icon: '🛻',
        color: '#4cc2ff',
        children: [
          { title: 'Oil change', icon: '🛢️', color: '#4cc2ff' },
          { title: 'Renew insurance', icon: '📄', color: '#4cc2ff' },
        ],
      },
      {
        title: 'Corolla',
        icon: '🚙',
        color: '#4cc2ff',
        children: [{ title: 'Replace front tyres', icon: '🛞', color: '#4cc2ff' }],
      },
    ],
  },
  {
    title: 'Home',
    icon: '🏠',
    color: '#8b7bff',
    children: [
      { title: 'Fix the balcony light', icon: '💡', color: '#8b7bff' },
      { title: 'Water the plants', icon: '🪴', color: '#8b7bff' },
    ],
  },
  // No children — so this row *is* the to-do item.
  { title: 'Clean the kitchen', icon: '🧽', color: '#3ddc97' },
  { title: 'Call the dentist', icon: '🦷', color: '#ff8a5c' },
];

export function seedWorkspace(userId: string) {
  const insert = db.prepare(
    `INSERT INTO items (id, user_id, parent_id, title, notes, icon, color, position, created_at, updated_at)
     VALUES (@id, @user_id, @parent_id, @title, @notes, @icon, @color, @position, @ts, @ts)`,
  );
  const ts = nowIso();

  const walk = (nodes: SeedNode[], parentId: string | null) => {
    nodes.forEach((node, index) => {
      const id = newId();
      insert.run({
        id,
        user_id: userId,
        parent_id: parentId,
        title: node.title,
        notes: node.notes ?? '',
        icon: node.icon,
        color: node.color,
        position: index * 1000,
        ts,
      });
      if (node.children?.length) walk(node.children, id);
    });
  };

  db.transaction(() => walk(SEED, null))();
}
