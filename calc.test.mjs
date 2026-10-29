// calc.test.mjs — Unit tests for the arrival-time engine. Run: `node --test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSchedule,
  computeBatchSchedule,
  steadyArrivalMs,
  requiredRate,
  formatDuration,
  maskTime,
  parseTime,
  normalizeTime,
  parseLocalDateTime,
  formatClock,
  bphToBpd,
  bphToGpm,
  MS_PER_HOUR,
} from './calc.js';

// Fixed reference start time so tests are deterministic (no wall clock).
const T0 = Date.UTC(2026, 6, 20, 12, 0, 0); // 2026-07-20 12:00:00 UTC
const h = (n) => n * MS_PER_HOUR;
const at = (hoursFromT0) => T0 + h(hoursFromT0);

test('steady rate: 10000 bbl at 5000 BPH arrives in 2h', () => {
  const r = computeSchedule({ startMs: T0, volumeToGo: 10000, initialRate: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.arrived, true);
  assert.equal(r.arrivalMs, at(2));
  assert.equal(r.totalHours, 2);
});

test('steadyArrivalMs matches computeSchedule with no changes', () => {
  const steady = steadyArrivalMs(T0, 7500, 3000); // 2.5h
  assert.equal(steady, at(2.5));
  const sched = computeSchedule({ startMs: T0, volumeToGo: 7500, initialRate: 3000 });
  assert.equal(sched.arrivalMs, steady);
});

test('rate increase mid-run pulls arrival earlier', () => {
  // 10000 bbl. 5000 BPH for first 0.5h => 2500 bbl. Remaining 7500 at 10000 BPH => 0.75h.
  // Arrival at 0.5 + 0.75 = 1.25h.
  const r = computeSchedule({
    startMs: T0,
    volumeToGo: 10000,
    initialRate: 5000,
    changes: [{ timeMs: at(0.5), rate: 10000 }],
  });
  assert.equal(r.arrived, true);
  assert.equal(r.arrivalMs, at(1.25));
  assert.equal(r.totalHours, 1.25);
  const arrivalSeg = r.segments.find((s) => s.isArrival);
  assert.equal(arrivalSeg.rate, 10000);
  assert.equal(arrivalSeg.volume, 7500);
});

test('rate cut mid-run pushes arrival later', () => {
  // 10000 bbl. 5000 BPH for 1h => 5000 bbl. Remaining 5000 at 2500 BPH => 2h.
  // Arrival at 1 + 2 = 3h (steady would be 2h).
  const r = computeSchedule({
    startMs: T0,
    volumeToGo: 10000,
    initialRate: 5000,
    changes: [{ timeMs: at(1), rate: 2500 }],
  });
  assert.equal(r.arrivalMs, at(3));
  const steady = steadyArrivalMs(T0, 10000, 5000);
  assert.equal(steady, at(2));
});

test('pause then resume: zero-rate segment adds dead time', () => {
  // 10000 bbl. 5000 BPH for 0.5h => 2500. Pause (0 BPH) for 1h. Resume 5000 BPH.
  // Remaining 7500 at 5000 => 1.5h. Arrival at 0.5 + 1.0 + 1.5 = 3.0h.
  const r = computeSchedule({
    startMs: T0,
    volumeToGo: 10000,
    initialRate: 5000,
    changes: [
      { timeMs: at(0.5), rate: 0 },
      { timeMs: at(1.5), rate: 5000 },
    ],
  });
  assert.equal(r.arrived, true);
  assert.equal(r.arrivalMs, at(3));
});

test('flow stops and never resumes: no arrival', () => {
  const r = computeSchedule({
    startMs: T0,
    volumeToGo: 10000,
    initialRate: 5000,
    changes: [{ timeMs: at(0.5), rate: 0 }],
  });
  assert.equal(r.arrived, false);
  assert.equal(r.arrivalMs, null);
  assert.equal(r.reason, 'stopped');
});

test('starting at 0 BPH then resuming works', () => {
  // Down at start, resume 4000 BPH at +1h, 8000 bbl => 2h. Arrival at 3h.
  const r = computeSchedule({
    startMs: T0,
    volumeToGo: 8000,
    initialRate: 0,
    changes: [{ timeMs: at(1), rate: 4000 }],
  });
  assert.equal(r.arrivalMs, at(3));
});

test('change scheduled before start overrides the initial rate', () => {
  // Change clamped to start; effectively starts at 8000 BPH. 8000 bbl => 1h.
  const r = computeSchedule({
    startMs: T0,
    volumeToGo: 8000,
    initialRate: 2000,
    changes: [{ timeMs: at(-5), rate: 8000 }],
  });
  assert.equal(r.arrivalMs, at(1));
});

test('out-of-order changes are sorted', () => {
  const r = computeSchedule({
    startMs: T0,
    volumeToGo: 10000,
    initialRate: 5000,
    changes: [
      { timeMs: at(1.5), rate: 5000 },
      { timeMs: at(0.5), rate: 0 },
    ],
  });
  assert.equal(r.arrivalMs, at(3)); // same as pause-then-resume case
});

test('arrival exactly at a change boundary', () => {
  // 5000 bbl at 5000 BPH => exactly 1h, and a change is scheduled at 1h.
  const r = computeSchedule({
    startMs: T0,
    volumeToGo: 5000,
    initialRate: 5000,
    changes: [{ timeMs: at(1), rate: 9999 }],
  });
  assert.equal(r.arrivalMs, at(1));
});

test('validation: non-positive volume', () => {
  const r = computeSchedule({ startMs: T0, volumeToGo: 0, initialRate: 5000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('validation: negative rate', () => {
  const r = computeSchedule({ startMs: T0, volumeToGo: 100, initialRate: -1 });
  assert.equal(r.ok, false);
});

test('requiredRate: 12000 bbl in 3h needs 4000 BPH', () => {
  const r = requiredRate({ startMs: T0, volumeToGo: 12000, targetMs: at(3) });
  assert.equal(r.ok, true);
  assert.equal(r.rate, 4000);
  assert.equal(r.hours, 3);
});

test('requiredRate: target not after start is rejected', () => {
  const r = requiredRate({ startMs: T0, volumeToGo: 12000, targetMs: T0 });
  assert.equal(r.ok, false);
});

test('batch schedule: back-to-back batches at a steady rate', () => {
  // 10000 bbl to first interface @5000 BPH => 2h. Then two 5000-bbl batches.
  // Cumulative 15000 => 3h, 20000 => 4h.
  const r = computeBatchSchedule({
    startMs: T0,
    volumeToGo: 10000,
    initialRate: 5000,
    batches: [{ label: 'WTI', volume: 5000 }, { volume: 5000 }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].label, 'Batch 1');
  assert.equal(r.rows[0].arrivalMs, at(2));
  assert.equal(r.rows[1].label, 'WTI');
  assert.equal(r.rows[1].cumulative, 15000);
  assert.equal(r.rows[1].arrivalMs, at(3));
  assert.equal(r.rows[2].label, 'Batch 3'); // no label provided -> default
  assert.equal(r.rows[2].cumulative, 20000);
  assert.equal(r.rows[2].arrivalMs, at(4));
});

test('batch schedule: a rate change shifts every downstream batch', () => {
  // 10000 @5000 for 1h (5000 bbl), then cut to 2500 BPH.
  // Batch 1 (10000): 1h + 5000/2500=2h => 3h.
  // Batch 2 (+6000 => 16000): remaining after 10000 is 6000 @2500 = 2.4h => 5.4h.
  const r = computeBatchSchedule({
    startMs: T0,
    volumeToGo: 10000,
    initialRate: 5000,
    changes: [{ timeMs: at(1), rate: 2500 }],
    batches: [{ volume: 6000 }],
  });
  assert.equal(r.rows[0].arrivalMs, at(3));
  assert.equal(r.rows[1].arrivalMs, at(5.4));
});

test('batch schedule: blank/zero batch volumes are ignored', () => {
  const r = computeBatchSchedule({
    startMs: T0,
    volumeToGo: 8000,
    initialRate: 4000,
    batches: [{ volume: 0 }, { volume: NaN }, { volume: 4000 }],
  });
  assert.equal(r.rows.length, 2); // primary + the one valid batch
  assert.equal(r.rows[1].cumulative, 12000);
  assert.equal(r.rows[1].arrivalMs, at(3));
});

test('batch schedule: invalid primary volume returns not ok', () => {
  const r = computeBatchSchedule({ startMs: T0, volumeToGo: 0, initialRate: 5000, batches: [{ volume: 100 }] });
  assert.equal(r.ok, false);
});

test('batch schedule: stopped flow yields null arrivals but stays ok', () => {
  const r = computeBatchSchedule({
    startMs: T0,
    volumeToGo: 10000,
    initialRate: 5000,
    changes: [{ timeMs: at(0.5), rate: 0 }],
    batches: [{ volume: 5000 }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].arrived, false);
  assert.equal(r.rows[0].arrivalMs, null);
  assert.equal(r.rows[1].arrivalMs, null);
});

test('unit conversions', () => {
  assert.equal(bphToBpd(5000), 120000);
  assert.equal(bphToGpm(60), 42); // 60 bbl/h * 42 gal / 60 min = 42 gpm
});

test('formatDuration renders days/hours/minutes and seconds', () => {
  assert.equal(formatDuration(h(2)), '2h');
  assert.equal(formatDuration(h(25) + 90000), '1d 1h 1m'); // 25h + 1.5m
  assert.equal(formatDuration(45000), '45s');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(-h(1)), '-1h');
});

test('maskTime builds 24-hour HH:MM from bare digits, keystroke by keystroke', () => {
  const typed = (keys) => [...keys].reduce((v, k) => maskTime(v + k), '');
  assert.equal(typed('1532'), '15:32');
  assert.equal(typed('0905'), '09:05');
  assert.equal(typed('905'), '9:05'); // "90" isn't an hour, so it's 9 + minutes
  assert.equal(typed('2359'), '23:59');
  assert.equal(typed('15:32'), '15:32'); // typed colon is kept, not doubled
  assert.equal(typed('9:05'), '9:05');
  assert.equal(typed('15323'), '15:32'); // extra digits dropped
  assert.equal(maskTime('15:'), '15:'); // backspacing through the colon
  assert.equal(maskTime('15'), '15');
  assert.equal(maskTime('3:32 PM'), '3:32'); // letters stripped
});

test('parseTime accepts only valid 24-hour times', () => {
  assert.deepEqual(parseTime('15:32'), { hours: 15, minutes: 32 });
  assert.deepEqual(parseTime('9:05'), { hours: 9, minutes: 5 });
  assert.deepEqual(parseTime('00:00'), { hours: 0, minutes: 0 });
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('12:60'), null);
  assert.equal(parseTime('15:3'), null); // still being typed
  assert.equal(parseTime('15'), null);
  assert.equal(parseTime(''), null);
});

test('normalizeTime pads to HH:MM and leaves bad entries alone', () => {
  assert.equal(normalizeTime('15:32'), '15:32');
  assert.equal(normalizeTime('9:05'), '09:05');
  assert.equal(normalizeTime('7'), '07:00');
  assert.equal(normalizeTime('15'), '15:00');
  assert.equal(normalizeTime('15:3'), '15:3');
  assert.equal(normalizeTime('25:00'), '25:00');
  assert.equal(normalizeTime(''), '');
});

test('parseLocalDateTime reads a local 24-hour date-time', () => {
  assert.equal(parseLocalDateTime('2026-10-29T15:32'), new Date(2026, 9, 29, 15, 32).getTime());
  assert.equal(parseLocalDateTime('2026-10-29T9:05'), new Date(2026, 9, 29, 9, 5).getTime());
  assert.ok(Number.isNaN(parseLocalDateTime('2026-10-29T15:3')));
  assert.ok(Number.isNaN(parseLocalDateTime('2026-10-29T')));
  assert.ok(Number.isNaN(parseLocalDateTime('T15:32')));
  assert.ok(Number.isNaN(parseLocalDateTime('')));
});

test('formatClock is always 24-hour, including around midnight', () => {
  assert.equal(formatClock(new Date(2026, 9, 29, 15, 32).getTime()), '15:32');
  assert.equal(formatClock(new Date(2026, 9, 29, 0, 5).getTime()), '00:05');
  assert.equal(formatClock(new Date(2026, 9, 29, 9, 7, 59).getTime()), '09:07');
});
