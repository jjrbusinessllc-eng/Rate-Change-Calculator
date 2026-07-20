// calc.js — Pure calculation engine for the Pipeline Rate Change / Arrival Time Calculator.
//
// Domain model (liquids pipeline, volume-to-go tracking):
//   - You are moving product toward a target (a batch interface reaching a station,
//     a delivery reaching its scheduled volume, tankage filling, etc.).
//   - "Volume to go" is the number of barrels between the product's current position
//     and the target.
//   - Flow rate is in barrels per hour (BPH).
//   - Arrival happens when the cumulative volume pumped equals the volume to go.
//
// The interesting part is RATE CHANGES: the rate can step to new values at scheduled
// clock times. The engine integrates a piecewise-constant rate schedule until the
// cumulative volume reaches the volume to go, and reports exactly when (and in which
// segment) arrival occurs.
//
// All times are epoch milliseconds. The UI works in the operator's local clock time
// and converts to/from epoch ms at the boundary.
//
// These functions are pure (no DOM, no globals) so they can be unit-tested under Node
// and imported by the browser UI via `import { ... } from './calc.js'`.

export const MS_PER_HOUR = 3600000;
export const GALLONS_PER_BARREL = 42; // US petroleum barrel

// ---- Unit helpers -----------------------------------------------------------

export function bphToBpd(bph) {
  return bph * 24;
}
export function bpdToBph(bpd) {
  return bpd / 24;
}
export function bphToGpm(bph) {
  return (bph * GALLONS_PER_BARREL) / 60;
}
export function gpmToBph(gpm) {
  return (gpm * 60) / GALLONS_PER_BARREL;
}

// ---- Core: arrival with a piecewise-constant rate schedule ------------------

/**
 * Compute arrival time given a starting rate and zero or more scheduled rate changes.
 *
 * @param {Object}   opts
 * @param {number}   opts.startMs       Epoch ms when tracking starts (product is at "volumeToGo" away).
 * @param {number}   opts.volumeToGo    Barrels remaining to the target (> 0).
 * @param {number}   opts.initialRate   Starting flow rate in BPH (>= 0) in force from startMs.
 * @param {Array<{timeMs:number, rate:number}>} [opts.changes]  Scheduled rate changes.
 *                                       Each takes effect at its clock time (epoch ms) and sets
 *                                       a new BPH rate. Times before startMs are clamped to startMs.
 *
 * @returns {{
 *   ok: boolean,
 *   arrivalMs: number|null,   // epoch ms of arrival, or null if it never arrives
 *   totalHours: number|null,  // hours from startMs to arrival, or null
 *   arrived: boolean,
 *   reason: string,           // 'ok' | 'stopped' | 'invalid'
 *   message: string,
 *   segments: Array<{         // every rate segment walked (0-duration segments are kept)
 *     startMs: number,
 *     endMs: number|null,     // null for the open-ended final segment
 *     rate: number,           // BPH in force during this segment
 *     hours: number,          // duration in hours (Infinity for the open-ended segment)
 *     volume: number,         // barrels moved during this segment (up to arrival)
 *     remainingBefore: number,// barrels remaining at segment start
 *     remainingAfter: number, // barrels remaining at segment end (0 once arrived)
 *     isArrival: boolean      // true for the segment in which arrival occurs
 *   }>
 * }}
 */
export function computeSchedule({ startMs, volumeToGo, initialRate, changes = [] }) {
  // ---- validation ----
  if (!isFiniteNumber(startMs)) {
    return invalid('Enter a valid start time.');
  }
  if (!isFiniteNumber(volumeToGo) || volumeToGo <= 0) {
    return invalid('Enter a volume to go greater than zero.');
  }
  if (!isFiniteNumber(initialRate) || initialRate < 0) {
    return invalid('Enter a starting rate of zero or more.');
  }
  for (const c of changes) {
    if (!isFiniteNumber(c.timeMs) || !isFiniteNumber(c.rate) || c.rate < 0) {
      return invalid('Each rate change needs a valid time and a rate of zero or more.');
    }
  }

  // ---- build the event timeline ----
  // Anchor the initial rate at startMs, then append changes (clamped to >= startMs).
  // Stable sort keeps the initial event first when a change is clamped onto startMs,
  // so a 0-duration segment at the initial rate is followed by the change's rate —
  // i.e. a change scheduled at/​before start correctly overrides the initial rate.
  const events = [{ timeMs: startMs, rate: initialRate }];
  for (const c of changes) {
    events.push({ timeMs: Math.max(startMs, c.timeMs), rate: c.rate });
  }
  stableSortByTime(events);

  // ---- walk the segments, integrating volume ----
  const segments = [];
  let remaining = volumeToGo;
  let arrivalMs = null;

  for (let i = 0; i < events.length; i++) {
    const seg = events[i];
    const next = events[i + 1];
    const segStart = seg.timeMs;
    const segEnd = next ? next.timeMs : null; // null => open-ended final segment
    const hours = segEnd === null ? Infinity : (segEnd - segStart) / MS_PER_HOUR;
    const remainingBefore = remaining;

    let volume = 0;
    let isArrival = false;

    if (remaining > 0 && seg.rate > 0) {
      const capacity = seg.rate * hours; // barrels this segment can move (Infinity if open-ended)
      if (capacity >= remaining) {
        // Arrival happens inside this segment.
        const hoursNeeded = remaining / seg.rate;
        arrivalMs = segStart + hoursNeeded * MS_PER_HOUR;
        volume = remaining;
        remaining = 0;
        isArrival = true;
      } else {
        volume = capacity;
        remaining -= capacity;
      }
    }

    segments.push({
      startMs: segStart,
      endMs: segEnd,
      rate: seg.rate,
      hours,
      volume,
      remainingBefore,
      remainingAfter: remaining,
      isArrival,
    });

    if (arrivalMs !== null) break;
  }

  if (arrivalMs === null) {
    // Never reached the target — the (open-ended) final rate was zero.
    return {
      ok: true,
      arrivalMs: null,
      totalHours: null,
      arrived: false,
      reason: 'stopped',
      message: 'Flow is stopped (0 BPH) — the product never reaches the target. Add a rate change that resumes flow.',
      segments,
    };
  }

  return {
    ok: true,
    arrivalMs,
    totalHours: (arrivalMs - startMs) / MS_PER_HOUR,
    arrived: true,
    reason: 'ok',
    message: '',
    segments,
  };
}

/**
 * Convenience: arrival at a single steady rate (no changes).
 * @returns {number|null} epoch ms of arrival, or null if rate <= 0.
 */
export function steadyArrivalMs(startMs, volumeToGo, rate) {
  if (!isFiniteNumber(rate) || rate <= 0) return null;
  if (!isFiniteNumber(volumeToGo) || volumeToGo <= 0) return null;
  return startMs + (volumeToGo / rate) * MS_PER_HOUR;
}

/**
 * Reverse mode: the steady rate needed to arrive exactly at targetMs.
 * @returns {{ok:boolean, rate:number|null, hours:number|null, message:string}}
 */
export function requiredRate({ startMs, volumeToGo, targetMs }) {
  if (!isFiniteNumber(startMs) || !isFiniteNumber(targetMs)) {
    return { ok: false, rate: null, hours: null, message: 'Enter valid start and target times.' };
  }
  if (!isFiniteNumber(volumeToGo) || volumeToGo <= 0) {
    return { ok: false, rate: null, hours: null, message: 'Enter a volume to go greater than zero.' };
  }
  const hours = (targetMs - startMs) / MS_PER_HOUR;
  if (hours <= 0) {
    return { ok: false, rate: null, hours, message: 'The target time must be after the start time.' };
  }
  return { ok: true, rate: volumeToGo / hours, hours, message: '' };
}

// ---- Multiple back-to-back batches ------------------------------------------

/**
 * Arrival times for a sequence of batches moving nose-to-tail down the line,
 * all sharing one rate schedule.
 *
 * The first batch is the primary "volume to go" (its interface arrives when the
 * cumulative pumped volume reaches `volumeToGo`). Each following batch adds its
 * own volume to the running total, so its interface arrives when the cumulative
 * pumped volume reaches that larger total. Scheduled rate changes apply to every
 * batch, since the schedule simply keeps running into the future.
 *
 * @param {Object} opts
 * @param {number} opts.startMs
 * @param {number} opts.volumeToGo   Barrels to the first batch's interface (> 0).
 * @param {number} opts.initialRate  BPH in force from startMs.
 * @param {Array<{timeMs:number, rate:number}>} [opts.changes]
 * @param {Array<{label?:string, volume:number}>} [opts.batches]  Following batches, in order.
 * @returns {{ ok:boolean, message:string, rows: Array<{
 *   index:number, label:string, deltaVolume:number, cumulative:number,
 *   arrivalMs:number|null, totalHours:number|null, arrived:boolean, reason:string
 * }> }}
 */
export function computeBatchSchedule({ startMs, volumeToGo, initialRate, changes = [], batches = [] }) {
  const first = computeSchedule({ startMs, volumeToGo, initialRate, changes });
  if (first.reason === 'invalid') {
    return { ok: false, message: first.message, rows: [] };
  }

  const rows = [{
    index: 1,
    label: 'Batch 1',
    deltaVolume: volumeToGo,
    cumulative: volumeToGo,
    arrivalMs: first.arrivalMs,
    totalHours: first.totalHours,
    arrived: first.arrived,
    reason: first.reason,
  }];

  let cumulative = volumeToGo;
  const following = batches.filter((b) => isFiniteNumber(b.volume) && b.volume > 0);
  following.forEach((b, i) => {
    cumulative += b.volume;
    const r = computeSchedule({ startMs, volumeToGo: cumulative, initialRate, changes });
    rows.push({
      index: i + 2,
      label: b.label && String(b.label).trim() ? String(b.label).trim() : `Batch ${i + 2}`,
      deltaVolume: b.volume,
      cumulative,
      arrivalMs: r.arrivalMs,
      totalHours: r.totalHours,
      arrived: r.arrived,
      reason: r.reason,
    });
  });

  return { ok: true, message: '', rows };
}

// ---- Formatting -------------------------------------------------------------

/**
 * Format a duration in ms as "Xd Yh Zm" (drops leading zero units). For durations
 * under a minute, shows seconds. Returns "0m" for zero.
 * @param {number} ms
 * @param {{seconds?:boolean}} [opts]  include seconds precision
 */
export function formatDuration(ms, opts = {}) {
  if (!isFiniteNumber(ms)) return '—';
  const negative = ms < 0;
  let total = Math.abs(Math.round(ms / 1000)); // whole seconds
  const days = Math.floor(total / 86400);
  total -= days * 86400;
  const hours = Math.floor(total / 3600);
  total -= hours * 3600;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;

  const parts = [];
  if (days) parts.push(days + 'd');
  if (hours) parts.push(hours + 'h');
  if (minutes) parts.push(minutes + 'm');
  if (opts.seconds || (!days && !hours && !minutes)) {
    parts.push(seconds + 's');
  }
  const text = parts.join(' ');
  return (negative ? '-' : '') + text;
}

/** Format a number with thousands separators and a fixed number of decimals. */
export function formatNumber(n, decimals = 0) {
  if (!isFiniteNumber(n)) return '—';
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// ---- internal ---------------------------------------------------------------

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function invalid(message) {
  return {
    ok: false,
    arrivalMs: null,
    totalHours: null,
    arrived: false,
    reason: 'invalid',
    message,
    segments: [],
  };
}

// Stable sort by timeMs (ascending). Array.prototype.sort is stable in modern
// engines, but we sort a decorated copy in place to be explicit and safe.
function stableSortByTime(arr) {
  arr
    .map((e, i) => [e, i])
    .sort((a, b) => a[0].timeMs - b[0].timeMs || a[1] - b[1])
    .forEach(([e], i) => {
      arr[i] = e;
    });
}
