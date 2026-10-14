// Tests for the per-chat "which Xero org?" question queue (lib/pickerQueue).
// Run: node scripts/test-picker-queue.js
const assert = require('assert');
const q = require('../lib/pickerQueue');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}

const bill = (id, supplier) => ({
  pendingBillId: id,
  supplier,
  invoiceNo: `INV-${id}`,
  billedTo: 'Ayu Borneo KW',
  total: 1272,
  currency: 'MYR',
  candidates: [
    { tenantId: 't1', tenantName: 'Ayu Borneo Sdn Bhd' },
    { tenantId: 't2', tenantName: 'Ayu Borneo (KW) Sdn. Bhd.' }
  ]
});

console.log('picker queue');

// The case that was silently broken: 5 bills, #2 and #4 need an org.
test('5-bill batch with two needing a pick asks both, one at a time', () => {
  let queue = [];
  // bills 1,3,5 match cleanly — they never touch the queue at all.
  const a = q.enqueue(queue, bill('b2', 'VIEWNET'));          // bill 2
  queue = a.queue;
  assert.ok(a.ask, 'first pending bill must be asked immediately');
  assert.strictEqual(a.ask.pendingBillId, 'b2');

  const b = q.enqueue(queue, bill('b4', 'PT. BUMI MAS'));     // bill 4
  queue = b.queue;
  assert.strictEqual(b.ask, null, 'second question must wait its turn');
  assert.strictEqual(queue.length, 2);

  // user answers the first
  const after = q.advance(queue, 'b2');
  queue = after.queue;
  assert.ok(after.next, 'answering must hand back the next question');
  assert.strictEqual(after.next.pendingBillId, 'b4');
  assert.strictEqual(after.next.remaining, 1);

  // user answers the second — queue empties
  const done = q.advance(queue, 'b4');
  assert.strictEqual(done.next, null);
  assert.strictEqual(done.queue.length, 0);
});

test('a second question never overwrites the first', () => {
  let queue = q.enqueue([], bill('b1', 'A')).queue;
  queue = q.enqueue(queue, bill('b2', 'B')).queue;
  queue = q.enqueue(queue, bill('b3', 'C')).queue;
  assert.deepStrictEqual(queue.map((x) => x.pendingBillId), ['b1', 'b2', 'b3']);
  assert.strictEqual(q.head(queue).pendingBillId, 'b1', 'head stays the first asked');
});

test('two files arriving together produce exactly one question', () => {
  // Both see the same starting queue; the lock serialises them, so the second
  // transition runs on the first one's output.
  const first = q.enqueue([], bill('b1', 'A'));
  const second = q.enqueue(first.queue, bill('b2', 'B'));
  const asks = [first.ask, second.ask].filter(Boolean);
  assert.strictEqual(asks.length, 1, 'only one question may go out');
});

test('an undelivered question is retried, not skipped', () => {
  // Head queued but never marked asked (e.g. the WhatsApp send failed).
  const stale = [{ ...bill('b1', 'A'), asked: false, queuedAt: new Date().toISOString() }];
  const res = q.enqueue(stale, bill('b2', 'B'));
  assert.ok(res.ask, 'must ask again');
  assert.strictEqual(res.ask.pendingBillId, 'b1', 'retries the head, not the new bill');
});

test('cancelling one moves to the next', () => {
  let queue = q.enqueue([], bill('b1', 'A')).queue;
  queue = q.enqueue(queue, bill('b2', 'B')).queue;
  const res = q.advance(queue, 'b1');
  assert.strictEqual(res.next.pendingBillId, 'b2');
  assert.strictEqual(res.queue.length, 1);
});

test('the same bill cannot be queued twice', () => {
  const first = q.enqueue([], bill('b1', 'A'));
  const again = q.enqueue(first.queue, bill('b1', 'A'));
  assert.strictEqual(again.queue.length, 1);
  assert.strictEqual(again.ask, null);
});

test('questions expire after the TTL', () => {
  const old = new Date(Date.now() - q.TTL_MS - 60000).toISOString();
  const queue = [{ ...bill('b1', 'A'), asked: true, queuedAt: old }];
  assert.strictEqual(q.prune(queue).length, 0);
  assert.strictEqual(q.head(queue), null);
  // ...and a fresh bill behind an expired one gets asked
  const res = q.enqueue(queue, bill('b2', 'B'));
  assert.ok(res.ask);
  assert.strictEqual(res.ask.pendingBillId, 'b2');
});

test('the queue is capped', () => {
  let queue = [];
  for (let i = 0; i < q.MAX + 5; i++) queue = q.enqueue(queue, bill('b' + i, 'S' + i)).queue;
  assert.strictEqual(queue.length, q.MAX);
});

test('legacy awaitingPicker state is migrated and stays answerable', () => {
  const entry = {
    awaitingPicker: { pendingBillId: 'old1', candidates: bill('old1', 'X').candidates },
    updatedAt: new Date().toISOString()
  };
  const queue = q.read(entry);
  assert.strictEqual(queue.length, 1);
  assert.strictEqual(queue[0].pendingBillId, 'old1');
  assert.strictEqual(queue[0].asked, true, 'the user was already asked before the deploy');
  // a new bill queues behind it instead of clobbering it
  const res = q.enqueue(queue, bill('new1', 'Y'));
  assert.strictEqual(res.ask, null);
  assert.deepStrictEqual(res.queue.map((x) => x.pendingBillId), ['old1', 'new1']);
});

test('read() handles an empty / unknown chat', () => {
  assert.deepStrictEqual(q.read(null), []);
  assert.deepStrictEqual(q.read({}), []);
});

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
