/**
 * Changes made with no connection, and what happens when it comes back.
 *
 * The queue itself is easy. What is not easy is that something created offline
 * has no real id: a task made on a plane gets a temporary one, and every later
 * change — a rename, an alarm, a subtask — points at that temporary id. When
 * the server finally issues the real one, every reference still queued has to
 * be rewritten or the replay sends edits for a task that does not exist.
 *
 * These are the cases that go wrong, so they are the ones pinned down here.
 */
import {
  clearOutbox,
  enqueue,
  hasUnresolvedIds,
  isTempId,
  newTempId,
  pendingCount,
  pendingOps,
  removeOp,
  resolveTempId,
  substituteIds,
  useOutboxStorage,
  type OutboxStorage,
} from '../web/src/lib/offline/outbox';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? ' ok  ' : 'FAIL '} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

function memoryStorage(): OutboxStorage & { dump(): string | null } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    dump: () => map.get('nexus.outbox') ?? null,
  };
}

console.log('working with no connection\n');

let store = memoryStorage();
useOutboxStorage(store);
clearOutbox();

// A plane journey: make a category, put a task in it, give the task an alarm,
// then rename the task. Only the first has an id the server has ever seen.
const categoryId = newTempId();
const taskId = newTempId();
const reminderId = newTempId();

enqueue('createItem', [{ title: 'Trip' }], categoryId);
enqueue('createItem', [{ title: 'Book the hotel', parentId: categoryId }], taskId);
enqueue('createReminder', [{ itemId: taskId, fireAt: '2026-09-01T09:00:00.000Z' }], reminderId);
enqueue('updateItem', [taskId, { title: 'Book the hotel and the car' }]);
enqueue('completeItem', [taskId, true, false]);

check('everything done offline is queued', pendingCount() === 5, `${pendingCount()} operations`);
check('the queue keeps the order it happened in',
  pendingOps().map((o) => o.kind).join(',') ===
    'createItem,createItem,createReminder,updateItem,completeItem');

// Nothing after the first can be sent yet: they all point at ids that are not real.
const ops = pendingOps();
check('a temporary id is recognisable', isTempId(categoryId) && !isTempId('abc123'));
check('the first operation is ready to send', !hasUnresolvedIds(ops[0].args));
check('the ones behind it are not', hasUnresolvedIds(ops[1].args) && hasUnresolvedIds(ops[3].args));

// The server answers for the category. Its children become sendable, and only them.
resolveTempId(categoryId, 'srv-category-1');
check('resolving a parent unblocks the task under it',
  !hasUnresolvedIds(substituteIds(pendingOps()[1].args)));
check('but not the alarm on a task that still has no id',
  hasUnresolvedIds(substituteIds(pendingOps()[2].args)));

const rewritten = substituteIds(pendingOps()[1].args) as [{ title: string; parentId: string }];
check('the real parent id is substituted in', rewritten[0].parentId === 'srv-category-1',
  rewritten[0].parentId);

resolveTempId(taskId, 'srv-task-9');
const remaining = pendingOps().slice(2).map((o) => substituteIds(o.args));
check('every later reference is rewritten too', !remaining.some((args) => hasUnresolvedIds(args)));
check('including one nested in an object',
  (remaining[0] as [{ itemId: string }])[0].itemId === 'srv-task-9');
check('and one that is a bare argument',
  (remaining[1] as [string, unknown])[0] === 'srv-task-9');

// Substitution must not damage anything else.
const shapes = substituteIds([
  { itemId: taskId, tags: ['a', taskId], nested: { deep: [taskId, 42, null, true] } },
]) as [{ itemId: string; tags: string[]; nested: { deep: unknown[] } }];
check('ids inside arrays and nesting are found', shapes[0].nested.deep[0] === 'srv-task-9');
check('non-strings are left alone',
  shapes[0].nested.deep[1] === 42 && shapes[0].nested.deep[2] === null && shapes[0].nested.deep[3] === true);
check('unrelated strings are untouched', shapes[0].tags[0] === 'a');

// Sending removes it from the queue, and the queue survives a restart.
removeOp(pendingOps()[0].id);
check('a sent operation leaves the queue', pendingCount() === 4);

const saved = store.dump();
const restarted = memoryStorage();
if (saved) restarted.setItem('nexus.outbox', saved);
useOutboxStorage(restarted);
check('the queue survives the app being closed', pendingCount() === 4, `${pendingCount()} still waiting`);
check('and so does the id mapping',
  (substituteIds([taskId]) as string[])[0] === 'srv-task-9');

// An id that was never resolved must stay put, so the operation is still
// recognisable as not-yet-sendable rather than being sent with a broken id.
const orphan = newTempId();
check('an unresolved id is left as it was', (substituteIds([orphan]) as string[])[0] === orphan);
check('and is still reported as unresolved', hasUnresolvedIds([orphan]));

console.log(failed ? `\n${failed} check(s) failed` : '\noffline changes replay in order, with the right ids');
process.exit(failed ? 1 : 0);
