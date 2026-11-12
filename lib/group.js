'use strict';
// A window of CI runs, failures grouped by signature, each group with a
// verdict. A pure function of its input.
//
// The window is the `window` most recent runs given (by createdAt, then run id).
// Verdicts:
//   flaky      a commit it failed on also has a success in the window (a rerun
//              that passed counts, so this is checked before new), or on
//              one branch it alternates with successes at least twice (fail,
//              pass, fail: counted from its first failure on, so a regression
//              that was fixed, pass-fail-pass, is one alternation, not flaky);
//   new        the signature is seen only in the latest failed run, which
//              must carry it (a latest failure whose log could not be read
//              makes no older signature new);
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
    const mark = r.conclusion === 'failure' && r.signature === signature ? 'F' : r.conclusion === 'success' ? 'S' : null;
    if (mark === null || (last === null && mark === 'S')) continue;
    if (last !== null && mark !== last) count++;
    last = mark;
  }
  return count;
}

// -> {groups: [{signature, count, runIds, firstSeen, lastSeen, verdict}],
//     latest: {runId, signature|null} | null}; groups most recently seen first.
function groupFailures(window, runs) {
  const inWindow = [...runs].sort(byTime).slice(-window);
  const latestRun = inWindow.length ? inWindow[inWindow.length - 1] : null;
  const newestFailure = inWindow.findLast((r) => r.conclusion === 'failure') || null;
  const successCommits = new Set(inWindow.filter((r) => r.conclusion === 'success').map((r) => r.commit));
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
    else if (list.length === 1 && list[0] === newestFailure) verdict = 'new';
    return {signature, count: list.length, runIds: list.map((r) => r.runId), firstSeen: seen(list[0]), lastSeen: seen(list[list.length - 1]), verdict};
  });
  groups.sort((a, b) => byTime(b.lastSeen, a.lastSeen));
  const latestSignature = latestRun && latestRun.conclusion === 'failure' && latestRun.signature ? latestRun.signature : null;
  return {groups, latest: latestRun ? {runId: latestRun.runId, signature: latestSignature} : null};
}

module.exports = {groupFailures};
