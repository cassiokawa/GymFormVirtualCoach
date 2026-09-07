/**
 * CueRationer — the Coaching-seam gate that turns the stream of raw
 * {@link FaultDetected} events into at most ONE spoken cue per rep.
 *
 * ## What this module decides, and what it does not
 *
 * This module decides **what to speak**. It does not play any sound. Rep tones,
 * cue tones, and speech playback are wired by the caller (`AudioBus.cueTone()`
 * then `SpeechChannel.speak()`); this rationer only returns the decision — a
 * {@link RationedCue} or `null`. That separation is deliberate: the rationer
 * must NEVER be able to gate a rep tone. A rep is confirmed by a tone regardless
 * of whether a cue is spoken (R3.6, `coaching-safety.md`). `flush` here concerns
 * the *spoken cue* only.
 *
 * ## Rules enforced (R3.2, R3.4, R3.5, R3.6, `coaching-safety.md`)
 *
 * - **One cue per rep, never two.** `flush` returns at most one cue for the rep.
 * - **Highest severity wins.** When several faults occur in a rep, the
 *   highest-severity one is chosen and the rest are discarded (R3.5).
 * - **3-rep cooldown per cue id.** The same `cueId` is not re-emitted within 3
 *   reps of its last emission. If the highest-severity candidate is cooling
 *   down, the rationer falls through to the next-highest candidate that is not
 *   cooling down, rather than emitting nothing — so a genuinely different,
 *   allowed fault can still be voiced. If every candidate this rep is cooling
 *   down, the result is `null` (silence).
 *
 * ## Severity ordering and tie-break
 *
 * `critical` > `warning` > `info`. On EQUAL severity the **first-offered** fault
 * wins: `offer` is called in the order faults are detected within the rep, and a
 * later equal-severity fault does not displace an earlier one. This makes the
 * selection deterministic given the offer/flush sequence.
 *
 * ## Statefulness and purity
 *
 * The rationer is deterministic given its offer/flush sequence. It is stateful
 * across reps in exactly two ways: the per-rep accumulation of offered faults
 * (cleared on every `flush`), and the per-`cueId` record of the rep index at
 * which it was last emitted (drives the cooldown). {@link CueRationer.reset}
 * clears both.
 *
 * Requirements: 3.2, 3.4, 3.5, 3.6
 */

import type { FaultDetected, FaultSeverity, RationedCue } from './types';

/** Number of reps a cue id must wait before it may be spoken again (cooldown). */
export const CUE_COOLDOWN_REPS = 3;

/**
 * Rank of a {@link FaultSeverity} for selection. Higher wins. Kept as a total
 * order so ties are impossible between *different* severities and the tie-break
 * only ever applies to genuinely equal severities.
 */
const SEVERITY_RANK: Readonly<Record<FaultSeverity, number>> = {
  info: 0,
  warning: 1,
  critical: 2,
};

/**
 * Rations detected faults down to one spoken cue per rep, applying a per-cue-id
 * cooldown. See the module doc for the full contract.
 */
export class CueRationer {
  /**
   * Faults offered within the CURRENT rep window, in offer order. Kept in full
   * (not collapsed to a running max) so that if the highest-severity candidate
   * is cooling down we can fall through to the next-highest allowed candidate.
   * Cleared on every {@link flush}.
   */
  private offered: FaultDetected[] = [];

  /**
   * For each `cueId` that has been emitted, the rep index at which it was last
   * emitted. Drives the 3-rep cooldown. Never cleared by `flush`; only by
   * {@link reset}.
   */
  private readonly lastEmittedRep = new Map<string, number>();

  /**
   * Accumulate a fault observed during the current rep window. Called for every
   * {@link FaultDetected} between rep boundaries. Pure bookkeeping — no I/O, no
   * selection happens here.
   */
  offer(fault: FaultDetected): void {
    this.offered.push(fault);
  }

  /**
   * At a rep boundary, select AT MOST ONE cue for the rep and reset the per-rep
   * accumulation.
   *
   * Selection: order the faults offered this rep by severity (highest first),
   * breaking ties by offer order (first-offered wins). Walk that order and
   * return the first candidate whose `cueId` is NOT within its 3-rep cooldown.
   * If a candidate is emitted, record `repIndex` as its last-emitted rep so the
   * cooldown is enforced for subsequent reps.
   *
   * Returns `null` when no fault was offered this rep, or when every offered
   * fault's `cueId` is still cooling down (silence is correct when there is
   * nothing new and allowed to say).
   *
   * NOTE: this concerns the SPOKEN cue only. It has no bearing on the rep tone,
   * which the caller emits unconditionally (R3.6).
   *
   * @param repIndex The index of the rep just completed. Monotonic across a set.
   */
  flush(repIndex: number): RationedCue | null {
    // Snapshot and reset the per-rep window first, so an early return still
    // clears accumulation for the next rep.
    const candidates = this.offered;
    this.offered = [];

    if (candidates.length === 0) {
      return null;
    }

    // Stable sort by severity descending. Array.prototype.sort is stable in
    // modern engines, and we only compare severity — so equal-severity faults
    // keep their original offer order, giving first-offered-wins on ties.
    const ordered = candidates
      .map((fault, offerOrder) => ({ fault, offerOrder }))
      .sort((a, b) => {
        const bySeverity =
          SEVERITY_RANK[b.fault.severity] - SEVERITY_RANK[a.fault.severity];
        if (bySeverity !== 0) {
          return bySeverity;
        }
        return a.offerOrder - b.offerOrder;
      });

    for (const { fault } of ordered) {
      if (this.isCoolingDown(fault.faultId, repIndex)) {
        continue;
      }
      this.lastEmittedRep.set(fault.faultId, repIndex);
      return {
        cueId: fault.faultId,
        text: fault.cue,
        severity: fault.severity,
      };
    }

    // Every candidate is within its cooldown window.
    return null;
  }

  /**
   * Clear ALL state: the current rep's accumulation and every cooldown record.
   * Used between sets so a new set starts with a clean rationing history.
   */
  reset(): void {
    this.offered = [];
    this.lastEmittedRep.clear();
  }

  /**
   * True when `cueId` was emitted within the last {@link CUE_COOLDOWN_REPS}
   * reps (inclusive of the emitting rep). A cue emitted at rep `r` is suppressed
   * for reps `r+1 .. r+CUE_COOLDOWN_REPS` and allowed again at `r+CUE_COOLDOWN_REPS+1`.
   */
  private isCoolingDown(cueId: string, repIndex: number): boolean {
    const last = this.lastEmittedRep.get(cueId);
    if (last === undefined) {
      return false;
    }
    return repIndex - last <= CUE_COOLDOWN_REPS;
  }
}
