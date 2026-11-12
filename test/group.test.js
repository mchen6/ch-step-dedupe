'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('./support');
const {groupFailures} = require('../lib/group');
const group = require('../handlers/dedupeService/group');

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
let n = 0;
// A run at minute `m` of the day, on `branch`, at `commit`.
const run = (m, conclusion, signature, {commit = String(m).padStart(7, '0'), branch = 'main'} = {}) => ({
  runId: String(1000 + m),
  conclusion,
  commit,
  branch,
  createdAt: `2026-11-11T10:${String(m).padStart(2, '0')}:00Z`,
  ...(signature ? {signature} : {})
});

test('groups by signature with counts and first/last seen in time order', () => {
  const runs = [run(5, 'failure', A), run(1, 'failure', A), run(3, 'success'), run(4, 'failure', B), run(2, 'failure', A, {branch: 'dev'})];
  const out = groupFailures(50, runs);
  assert.deepStrictEqual(out.groups.map((g) => [g.signature, g.count, g.runIds]), [
    [A, 3, ['1001', '1002', '1005']],
    [B, 1, ['1004']]
  ]);
  assert.deepStrictEqual(out.groups[0].firstSeen, {runId: '1001', commit: '0000001', createdAt: '2026-11-11T10:01:00Z'});
  assert.deepStrictEqual(out.groups[0].lastSeen, {runId: '1005', commit: '0000005', createdAt: '2026-11-11T10:05:00Z'});
  assert.deepStrictEqual(out.latest, {runId: '1005', signature: A});
});

test('groups are ordered most recently seen first', () => {
  const out = groupFailures(50, [run(1, 'failure', A), run(2, 'failure', B), run(3, 'failure', C), run(4, 'failure', A)]);
  assert.deepStrictEqual(out.groups.map((g) => g.signature), [A, C, B]);
});

test('new: seen only in the latest failed run', () => {
  const out = groupFailures(50, [run(1, 'failure', A), run(2, 'success'), run(3, 'failure', B), run(4, 'success')]);
  const verdict = Object.fromEntries(out.groups.map((g) => [g.signature, g.verdict]));
  assert.strictEqual(verdict[B], 'new');
  assert.strictEqual(verdict[A], 'recurring'); // seen once, but not in the latest failure
  assert.deepStrictEqual(out.latest, {runId: '1004', signature: null}); // the latest run passed
});

test('flaky: same commit passed elsewhere', () => {
  const out = groupFailures(50, [run(1, 'failure', A, {commit: 'abc0000'}), run(2, 'success', null, {commit: 'abc0000', branch: 'dev'}), run(3, 'failure', A, {commit: 'def0000'})]);
  assert.strictEqual(out.groups[0].verdict, 'flaky');
});

test('flaky: alternates with passes on the branch', () => {
  // fail, pass, fail on main: two alternations.
  const out = groupFailures(50, [run(1, 'failure', A), run(2, 'success'), run(3, 'failure', B), run(4, 'failure', A), run(5, 'failure', C)]);
  assert.strictEqual(out.groups.find((g) => g.signature === A).verdict, 'flaky');
});

test('recurring otherwise: a regression that was fixed is not flaky', () => {
  // pass, fail, fail, pass, then something else fails: one alternation for A.
  const out = groupFailures(50, [run(1, 'success'), run(2, 'failure', A), run(3, 'failure', A), run(4, 'success'), run(5, 'failure', B)]);
  assert.strictEqual(out.groups.find((g) => g.signature === A).verdict, 'recurring');
  assert.strictEqual(out.groups.find((g) => g.signature === B).verdict, 'new');
  // alternation counts per branch: a pass on another branch does not count.
  const other = groupFailures(50, [run(1, 'failure', A), run(2, 'success', null, {branch: 'dev'}), run(3, 'failure', A), run(4, 'failure', B)]);
  assert.strictEqual(other.groups.find((g) => g.signature === A).verdict, 'recurring');
});

test('runs without a signature are counted in the window but not grouped', () => {
  const out = groupFailures(3, [run(1, 'failure', A), run(2, 'failure'), run(3, 'other'), run(4, 'failure', A)]);
  assert.deepStrictEqual(out.groups.map((g) => [g.signature, g.count]), [[A, 1]]); // run 1 fell out of the window of 3
  assert.strictEqual(out.groups[0].verdict, 'new');
});

test('the window keeps only the most recent runs', () => {
  const runs = Array.from({length: 60}, (_, i) => run(i, 'failure', A));
  const out = groupFailures(50, runs);
  assert.strictEqual(out.groups[0].count, 50);
  assert.strictEqual(out.groups[0].firstSeen.runId, '1010');
});

test('no run, or no failure, gives no group', () => {
  assert.deepStrictEqual(groupFailures(50, []), {groups: [], latest: null});
  assert.deepStrictEqual(groupFailures(50, [run(1, 'success')]), {groups: [], latest: {runId: '1001', signature: null}});
});

// From /code-review medium on PR #7.
test('a failure that passed on a rerun of the same commit is flaky, not new', () => {
  const out = groupFailures(50, [run(1, 'failure', A, {commit: 'abc0000'}), run(2, 'success', null, {commit: 'abc0000'})]);
  assert.strictEqual(out.groups[0].verdict, 'flaky');
});

test('new needs the latest failed run itself: an unreadable latest failure makes an older signature not new', () => {
  const out = groupFailures(50, [run(1, 'failure', A), run(2, 'failure')]);
  assert.strictEqual(out.groups[0].verdict, 'recurring');
});

test('a signature on a run that did not fail is not grouped', () => {
  assert.deepStrictEqual(groupFailures(50, [run(1, 'success', A), run(2, 'other', B)]).groups, []);
});

test('handler validates its input', async () => {
  const invalid = (err) => err.code === 'ARGUMENTS_INVALID';
  const good = run(1, 'failure', A);
  for (const bad of [
    {}, null, {window: 0, runs: []}, {window: 101, runs: []}, {window: 50},
    {window: 50, runs: [{...good, conclusion: 'cancelled'}]},
    {window: 50, runs: [{...good, runId: 1001}]},
    {window: 50, runs: [{...good, signature: 'not-a-hash'}]},
    {window: 50, runs: [{...good, createdAt: 'yesterday'}]},
    {window: 50, runs: [{...good, createdAt: '2026-02-30T00:00:00Z'}]},
    {window: 50, runs: [{...good, createdAt: '2026-11-11T24:00:00Z'}]},
    {window: 50, runs: [good, {...good}]},
    {window: 50, runs: [{...good, commit: ''}]},
    {window: 50, runs: [{...good, commit: 'not-hex'}]},
    {window: 50, runs: [{...good, runId: 'b'}]},
    {window: 50, runs: [{...run(2, 'success'), signature: A}]}
  ]) {
    await assert.rejects(group(bad), invalid, JSON.stringify(bad));
  }
  const {output} = await group({window: 50, runs: [good]});
  assert.deepStrictEqual(output, groupFailures(50, [good]));
});

test('the module is a part: never listed', () => {
  assert.deepStrictEqual(require('../package.json').countinghouse, {role: 'part'});
});
