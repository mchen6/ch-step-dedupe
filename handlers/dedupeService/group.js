'use strict';
// ch-step-dedupe/dedupeService.group: {window, runs} -> {groups, latest}.
const {groupFailures} = require('../../lib/group');

const MAX_WINDOW = 100;
const ISO = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const CONCLUSIONS = ['failure', 'success', 'other'];

// A real date and time: Date.parse rolls 2026-02-30 over to March 2.
function isTime(t) {
  const m = typeof t === 'string' ? ISO.exec(t) : null;
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days && h < 24 && mi < 60 && sec < 60;
}

const isRun = (r) => r != null
  && typeof r.runId === 'string' && /^\d+$/.test(r.runId)
  && CONCLUSIONS.includes(r.conclusion)
  && typeof r.commit === 'string' && /^[0-9a-f]{7,40}$/.test(r.commit) && typeof r.branch === 'string'
  && isTime(r.createdAt)
  && (r.signature === undefined || (r.conclusion === 'failure' && typeof r.signature === 'string' && /^[0-9a-f]{64}$/.test(r.signature)));

module.exports = async (input) => {
  const window = input != null ? input.window : null;
  const runs = input != null ? input.runs : null;
  if (!Number.isInteger(window) || window < 1 || window > MAX_WINDOW) {
    throw new DeviceError('ARGUMENTS_INVALID', `window must be an integer from 1 to ${MAX_WINDOW}`);
  }
  if (!Array.isArray(runs) || !runs.every(isRun)) {
    throw new DeviceError('ARGUMENTS_INVALID', 'runs must be [{runId (digits), conclusion: failure|success|other, commit (hex SHA), branch, createdAt (ISO 8601), signature?: sha256 hex, on failures only}]');
  }
  if (new Set(runs.map((r) => r.runId)).size !== runs.length) {
    throw new DeviceError('ARGUMENTS_INVALID', 'runs lists a run id more than once');
  }
  return {output: groupFailures(window, runs)};
};
