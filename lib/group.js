'use strict';
// A window of CI runs, failures grouped by signature, each group with a
// verdict. A pure function of its input.
//
// The window is the `window` most recent runs given (by createdAt, then run id).
// Verdicts:
//   flaky      a commit it failed on also has a success in the window (a rerun
//              that passed counts, so this is checked before new; so does a
//              failure marked passedOnRerun: "Re-run jobs" keeps the run id,
//              so the run that passed is that failure's own), or on
//              one branch it alternates with successes at least twice (fail,
//              pass, fail: counted from its first failure on, so a regression
//              that was fixed, pass-fail-pass, is one alternation, not flaky);
//   new        the signature is seen once, and no failure after it lacks a
//              signature (one whose log could not be read could have been
//              the same): the latest failed run, or an older one picked by
//              run id whose failure has not recurred since (it is never
//              "recurring" seen once: the final pass on the packs, A12);
//   recurring  otherwise.
// Only failures are grouped: runs with no signature (successes, other
// conclusions, failures whose log could not be read) count in the window and
// are in no group, and a signature on a run that did not fail is ignored.

// Oldest first: createdAt, then the run id as a number (ids are digit strings).
function byTime(a, b) {
  const t = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (t !== 0) return t;
  return (a.runId.length - b.runId.length) || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);
}

const seen = (r) => ({runId: r.runId, commit: r.commit, createdAt: r.createdAt});

// Alternations between this signature's failures and successes on one branch,
// counted from the signature's first failure there.
function alternations(branchRuns, signature) {
  let count = 0;
  let last = null;
  for (const r of branchRuns) {
    const own = r.conclusion === 'failure' && r.signature === signature ? 'F' : r.conclusion === 'success' ? 'S' : null;
    // (a failure that passed on its rerun: its own mark, then a pass)
    for (const mark of r.passedOnRerun === true ? [own, 'S'] : [own]) {
      if (mark === null || (last === null && mark === 'S')) continue;
      if (last !== null && mark !== last) count++;
      last = mark;
    }
  }
  return count;
}

// -> {groups: [{signature, count, runIds, firstSeen, lastSeen, verdict}],
//     latest: {runId, signature|null} | null}; groups most recently seen first.
function groupFailures(window, runs) {
  const inWindow = [...runs].sort(byTime).slice(-window);
  const latestRun = inWindow.length ? inWindow[inWindow.length - 1] : null;
  const successCommits = new Set(inWindow.filter((r) => r.conclusion === 'success' || r.passedOnRerun === true).map((r) => r.commit));
  // (the failures whose log could not be read: any one of them could carry a
  // signature seen once before it)
  const unread = inWindow.filter((r) => r.conclusion === 'failure' && !r.signature);
  const unreadAfter = (r) => unread.some((u) => byTime(u, r) > 0);
  const branches = new Map();
  for (const r of inWindow) {
    if (!branches.has(r.branch)) branches.set(r.branch, []);
    branches.get(r.branch).push(r);
  }

  const branchRuns = [...branches.values()];
  const bySignature = new Map();
  for (const r of inWindow) {
    if (r.conclusion !== 'failure' || !r.signature) continue;
    if (!bySignature.has(r.signature)) bySignature.set(r.signature, []);
    bySignature.get(r.signature).push(r);
  }
  const groups = [...bySignature].map(([signature, list]) => {
    let verdict = 'recurring';
    if (list.some((r) => successCommits.has(r.commit)) || branchRuns.some((b) => alternations(b, signature) >= 2)) verdict = 'flaky';
    else if (list.length === 1 && !unreadAfter(list[0])) verdict = 'new';
    return {signature, count: list.length, runIds: list.map((r) => r.runId), firstSeen: seen(list[0]), lastSeen: seen(list[list.length - 1]), verdict};
  });
  groups.sort((a, b) => byTime(b.lastSeen, a.lastSeen));
  const latestSignature = latestRun && latestRun.conclusion === 'failure' && latestRun.signature ? latestRun.signature : null;
  return {groups, latest: latestRun ? {runId: latestRun.runId, signature: latestSignature} : null};
}

module.exports = {groupFailures};
