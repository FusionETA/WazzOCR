// Per-chat queue of bills waiting for the user to pick a Xero organisation.
//
// A batch can contain several bills that each need a decision. Before this, the
// chat held ONE awaiting question: a second bill overwrote the first, and any
// bill that matched cleanly wiped whatever question was open — so in a 5-bill
// batch where bills 2 and 4 needed a pick, the user was asked nothing and both
// bills silently stayed in Pending.
//
// These are pure state transitions over the queue array. The caller owns reading
// and writing whatsapp-state.json (see withPickerQueue in server.js) so every
// mutation happens inside one file lock — which is what stops two files that
// arrive together from both asking.
//
// Entry shape:
//   { pendingBillId, candidates, supplier, invoiceNo, billedTo, total,
//     currency, asked, queuedAt }
// `asked` marks the question as already sent, so only one is ever in flight.

const MAX = 20;                              // a runaway batch can't bury the chat
const TTL_MS = 24 * 60 * 60 * 1000;          // stale questions stop ambushing the user a day later

// Pull the queue out of a chat-state entry, migrating the legacy single-slot
// `awaitingPicker` so questions armed before this deploy stay answerable.
function read(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.pickerQueue)) return entry.pickerQueue;
  if (entry.awaitingPicker && entry.awaitingPicker.pendingBillId) {
    return [{ ...entry.awaitingPicker, asked: true, queuedAt: entry.updatedAt || new Date().toISOString() }];
  }
  return [];
}

function prune(queue, now = Date.now()) {
  const cutoff = now - TTL_MS;
  return (queue || []).filter((q) => {
    const t = Date.parse(q && q.queuedAt);
    return Number.isNaN(t) ? true : t >= cutoff;
  });
}

function withRemaining(queue) {
  return queue.length ? { ...queue[0], remaining: queue.length } : null;
}

// The question currently open, if any.
function head(queue) {
  return withRemaining(prune(queue));
}

// Add a bill needing a decision. Returns `{ queue, ask }` where `ask` is the
// question to send NOW — null when another bill's question is already open.
// It is the HEAD that comes back, not the item just added, so a question whose
// delivery failed earlier is retried rather than skipped.
function enqueue(queue, item, queuedAt = new Date().toISOString()) {
  const current = prune(queue);
  if (!item || !item.pendingBillId) return { queue: current, ask: null };
  if (current.some((q) => q.pendingBillId === item.pendingBillId)) {
    return { queue: current, ask: null };
  }
  const next = current.length >= MAX
    ? current
    : [...current, { ...item, asked: false, queuedAt }];
  const first = next[0];
  if (!first || first.asked) return { queue: next, ask: null };
  // Mark it sent inside the same transition, so a concurrent upload sees it taken.
  const marked = [{ ...first, asked: true }, ...next.slice(1)];
  return { queue: marked, ask: withRemaining(marked) };
}

// Drop an answered/cancelled entry and hand back the next question to ask.
// Without an id, drops the head.
function advance(queue, pendingBillId = null) {
  const current = prune(queue);
  const next = pendingBillId
    ? current.filter((q) => q.pendingBillId !== pendingBillId)
    : current.slice(1);
  if (!next.length) return { queue: next, next: null };
  const marked = [{ ...next[0], asked: true }, ...next.slice(1)];
  return { queue: marked, next: withRemaining(marked) };
}

module.exports = { MAX, TTL_MS, read, prune, head, enqueue, advance };
