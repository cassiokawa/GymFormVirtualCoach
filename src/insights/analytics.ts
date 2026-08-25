/**
 * Analytics engine — derives muscle-activation, form-quality, volume,
 * consistency, and recommendations purely from stored workout {@link Session}s.
 *
 * All functions are pure (no I/O) so they are easy to test and can run over any
 * session list the caller supplies from Storage.query().
 */

import type { Session } from '../types/index.js';
import { getExerciseByName } from '../config/exerciseCatalog.js';
import {
  type MuscleRegion,
  REGION_LABELS,
  exerciseMuscleWeights,
  normalizeMuscle,
} from './muscleMap.js';

/** Per-muscle aggregated activation and quality across the analyzed sessions. */
export interface MuscleActivation {
  region: MuscleRegion;
  /** Emphasis-weighted rep volume attributed to this muscle. */
  weightedVolume: number;
  /** Normalized 0..1 intensity relative to the most-worked muscle. */
  intensity: number;
  /** Mean form quality (0..1) of the reps that worked this muscle. */
  quality: number;
}

/** Per-exercise form-quality summary. */
export interface ExerciseQuality {
  exerciseName: string;
  displayName: string;
  totalReps: number;
  correctReps: number;
  qualityPercent: number; // 0..100
  topDeviations: Array<{ joint: string; count: number }>;
}

/** Muscle-growth-oriented metrics per muscle region. */
export interface MuscleGrowthStat {
  region: MuscleRegion;
  label: string;
  /** Approx. working sets in the last 7 days attributed to this muscle. */
  weeklySets: number;
  /** Hypertrophy guideline target (sets/week). */
  targetSets: number;
  /** 'under' | 'optimal' | 'over' relative to the target band. */
  status: 'under' | 'optimal' | 'over';
  /** Days since this muscle was last trained (Infinity if never). */
  daysSinceTrained: number;
  /** 'fresh' (>=2 days rest) | 'recovering' (<2 days) | 'stale' (>7 days). */
  recovery: 'fresh' | 'recovering' | 'stale';
}

/** Left/right symmetry signal derived from per-joint deviation flags. */
export interface SymmetryFlag {
  /** Base joint name without side prefix, e.g. "knee". */
  joint: string;
  leftFlags: number;
  rightFlags: number;
  /** Which side is flagged more, or 'balanced'. */
  dominantSide: 'left' | 'right' | 'balanced';
  message: string;
}

/** Volume + consistency headline numbers. */
export interface VolumeStats {
  totalReps: number;
  totalSessions: number;
  sessionsThisWeek: number;
  currentStreakDays: number;
  perMuscleReps: Array<{ region: MuscleRegion; label: string; reps: number }>;
}

/** A single actionable recommendation. */
export interface Recommendation {
  kind: 'balance' | 'form' | 'consistency' | 'safety';
  priority: 'high' | 'medium' | 'low';
  message: string;
}

/** Full analytics bundle for the insights panel. */
export interface InsightsReport {
  activations: MuscleActivation[];
  exerciseQuality: ExerciseQuality[];
  volume: VolumeStats;
  growth: MuscleGrowthStat[];
  symmetry: SymmetryFlag[];
  recommendations: Recommendation[];
  hasData: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Quality weight per rep category. */
function repQualityWeight(category: string): number {
  if (category === 'correct') return 1;
  if (category === 'flawed') return 0.5;
  return 0; // dangerous_aborted
}

/**
 * Compute the full insights report from a list of sessions.
 *
 * @param sessions Sessions to analyze (any order).
 * @param now Reference time for "this week" / streak math (defaults to Date.now()).
 */
export function computeInsights(sessions: Session[], now: number = Date.now()): InsightsReport {
  if (sessions.length === 0) {
    return {
      activations: [],
      exerciseQuality: [],
      volume: {
        totalReps: 0,
        totalSessions: 0,
        sessionsThisWeek: 0,
        currentStreakDays: 0,
        perMuscleReps: [],
      },
      growth: [],
      symmetry: [],
      recommendations: [],
      hasData: false,
    };
  }

  const activations = computeMuscleActivations(sessions);
  const exerciseQuality = computeExerciseQuality(sessions);
  const volume = computeVolume(sessions, activations, now);
  const growth = computeGrowthStats(sessions, now);
  const symmetry = computeSymmetry(sessions);
  const recommendations = buildRecommendations(activations, exerciseQuality, volume, growth, symmetry);

  return { activations, exerciseQuality, volume, growth, symmetry, recommendations, hasData: true };
}

// ---------------------------------------------------------------------------
// Muscle activation
// ---------------------------------------------------------------------------

/** Aggregate emphasis-weighted volume and mean quality per muscle region. */
export function computeMuscleActivations(sessions: Session[]): MuscleActivation[] {
  const volume = new Map<MuscleRegion, number>();
  const qualityWeighted = new Map<MuscleRegion, number>();
  const qualityDenom = new Map<MuscleRegion, number>();

  for (const session of sessions) {
    for (const set of session.sets) {
      const entry = getExerciseByName(set.exerciseName);
      if (entry === undefined) continue;
      const weights = exerciseMuscleWeights(entry.muscleGroups);
      if (weights.size === 0) continue;

      const reps = set.reps.length;
      if (reps === 0) continue;
      const meanRepQuality =
        set.reps.reduce((s, r) => s + repQualityWeight(r.category), 0) / reps;

      for (const [region, w] of weights) {
        volume.set(region, (volume.get(region) ?? 0) + reps * w);
        qualityWeighted.set(region, (qualityWeighted.get(region) ?? 0) + meanRepQuality * reps * w);
        qualityDenom.set(region, (qualityDenom.get(region) ?? 0) + reps * w);
      }
    }
  }

  const maxVolume = Math.max(1, ...volume.values());
  const result: MuscleActivation[] = [];
  for (const [region, vol] of volume) {
    const denom = qualityDenom.get(region) ?? 0;
    result.push({
      region,
      weightedVolume: round1(vol),
      intensity: round2(vol / maxVolume),
      quality: denom > 0 ? round2((qualityWeighted.get(region) ?? 0) / denom) : 0,
    });
  }
  // Descending by volume for stable display.
  result.sort((a, b) => b.weightedVolume - a.weightedVolume || a.region.localeCompare(b.region));
  return result;
}

// ---------------------------------------------------------------------------
// Form quality
// ---------------------------------------------------------------------------

/** Per-exercise quality with top recurring deviations. */
export function computeExerciseQuality(sessions: Session[]): ExerciseQuality[] {
  const totals = new Map<string, { total: number; correct: number; devs: Map<string, number> }>();

  for (const session of sessions) {
    for (const set of session.sets) {
      const rec = totals.get(set.exerciseName) ?? { total: 0, correct: 0, devs: new Map() };
      for (const rep of set.reps) {
        rec.total += 1;
        if (rep.category === 'correct') rec.correct += 1;
        for (const dev of rep.deviationEvents) {
          rec.devs.set(dev.jointName, (rec.devs.get(dev.jointName) ?? 0) + 1);
        }
      }
      totals.set(set.exerciseName, rec);
    }
  }

  const out: ExerciseQuality[] = [];
  for (const [exerciseName, rec] of totals) {
    if (rec.total === 0) continue;
    const topDeviations = [...rec.devs.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([joint, count]) => ({ joint, count }));
    out.push({
      exerciseName,
      displayName: getExerciseByName(exerciseName)?.displayName ?? exerciseName.replace(/_/g, ' '),
      totalReps: rec.total,
      correctReps: rec.correct,
      qualityPercent: Math.round((rec.correct / rec.total) * 100),
      topDeviations,
    });
  }
  out.sort((a, b) => a.qualityPercent - b.qualityPercent || a.displayName.localeCompare(b.displayName));
  return out;
}

// ---------------------------------------------------------------------------
// Volume & consistency
// ---------------------------------------------------------------------------

/** Headline volume + consistency numbers, including per-muscle rep totals. */
export function computeVolume(
  sessions: Session[],
  activations: MuscleActivation[],
  now: number,
): VolumeStats {
  let totalReps = 0;
  for (const s of sessions) {
    for (const set of s.sets) totalReps += set.reps.length;
  }

  const weekAgo = now - 7 * DAY_MS;
  const sessionsThisWeek = sessions.filter((s) => s.startedAt.getTime() >= weekAgo).length;

  const perMuscleReps = activations.map((a) => ({
    region: a.region,
    label: REGION_LABELS[a.region],
    reps: Math.round(a.weightedVolume),
  }));

  return {
    totalReps,
    totalSessions: sessions.length,
    sessionsThisWeek,
    currentStreakDays: computeStreak(sessions, now),
    perMuscleReps,
  };
}

/** Consecutive-day workout streak ending today/yesterday. */
export function computeStreak(sessions: Session[], now: number): number {
  if (sessions.length === 0) return 0;
  // Unique workout day keys (local midnight).
  const days = new Set<number>();
  for (const s of sessions) {
    const d = new Date(s.startedAt.getTime());
    d.setHours(0, 0, 0, 0);
    days.add(d.getTime());
  }
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  let cursor = today.getTime();
  // Allow the streak to count if the most recent workout was today or yesterday.
  if (!days.has(cursor) && !days.has(cursor - DAY_MS)) return 0;
  if (!days.has(cursor)) cursor -= DAY_MS;
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor -= DAY_MS;
  }
  return streak;
}

// ---------------------------------------------------------------------------
// Muscle growth (frequency, weekly volume, recovery)
// ---------------------------------------------------------------------------

/** Hypertrophy guideline: ~10 working sets/week/muscle is a common target. */
const TARGET_WEEKLY_SETS = 10;

/**
 * Per-muscle growth metrics: weekly working sets vs a hypertrophy target, and
 * recovery status from days-since-last-trained. A "set" here is one logged
 * SetRecord that involves the muscle (emphasis-weighted rounding).
 */
export function computeGrowthStats(sessions: Session[], now: number): MuscleGrowthStat[] {
  const weekAgo = now - 7 * DAY_MS;
  const weeklySets = new Map<MuscleRegion, number>();
  const lastTrained = new Map<MuscleRegion, number>();

  for (const session of sessions) {
    const t = session.startedAt.getTime();
    for (const set of session.sets) {
      const entry = getExerciseByName(set.exerciseName);
      if (entry === undefined) continue;
      const weights = exerciseMuscleWeights(entry.muscleGroups);
      for (const [region, w] of weights) {
        lastTrained.set(region, Math.max(lastTrained.get(region) ?? 0, t));
        if (t >= weekAgo) {
          // Count the set fractionally by emphasis so a secondary mover counts less.
          weeklySets.set(region, (weeklySets.get(region) ?? 0) + w);
        }
      }
    }
  }

  const regions = new Set<MuscleRegion>([...weeklySets.keys(), ...lastTrained.keys()]);
  const out: MuscleGrowthStat[] = [];
  for (const region of regions) {
    const sets = Math.round(weeklySets.get(region) ?? 0);
    const last = lastTrained.get(region);
    const days = last === undefined ? Infinity : Math.floor((now - last) / DAY_MS);
    const status: MuscleGrowthStat['status'] =
      sets < TARGET_WEEKLY_SETS * 0.6 ? 'under' : sets > TARGET_WEEKLY_SETS * 2 ? 'over' : 'optimal';
    const recovery: MuscleGrowthStat['recovery'] =
      days >= 7 ? 'stale' : days >= 2 ? 'fresh' : 'recovering';
    out.push({
      region,
      label: REGION_LABELS[region],
      weeklySets: sets,
      targetSets: TARGET_WEEKLY_SETS,
      status,
      daysSinceTrained: days,
      recovery,
    });
  }
  out.sort((a, b) => a.weeklySets - b.weeklySets || a.label.localeCompare(b.label));
  return out;
}

// ---------------------------------------------------------------------------
// Left/right symmetry
// ---------------------------------------------------------------------------

/**
 * Derive left/right symmetry signals from deviation flags. If one side of a
 * paired joint (knee, elbow, hip, shoulder) is flagged notably more, that hints
 * at an imbalance or a form habit worth correcting.
 */
export function computeSymmetry(sessions: Session[]): SymmetryFlag[] {
  const left = new Map<string, number>();
  const right = new Map<string, number>();

  for (const session of sessions) {
    for (const set of session.sets) {
      for (const rep of set.reps) {
        for (const dev of rep.deviationEvents) {
          const name = dev.jointName;
          if (name.startsWith('left_')) {
            const base = name.slice(5);
            left.set(base, (left.get(base) ?? 0) + 1);
          } else if (name.startsWith('right_')) {
            const base = name.slice(6);
            right.set(base, (right.get(base) ?? 0) + 1);
          }
        }
      }
    }
  }

  const joints = new Set<string>([...left.keys(), ...right.keys()]);
  const out: SymmetryFlag[] = [];
  for (const joint of joints) {
    const l = left.get(joint) ?? 0;
    const r = right.get(joint) ?? 0;
    const total = l + r;
    if (total < 3) continue; // not enough signal to judge
    let dominantSide: SymmetryFlag['dominantSide'] = 'balanced';
    // Flag an imbalance when one side accounts for >= 65% of flags.
    if (l >= total * 0.65) dominantSide = 'left';
    else if (r >= total * 0.65) dominantSide = 'right';
    const pretty = joint.replace(/_/g, ' ');
    const message =
      dominantSide === 'balanced'
        ? `${pretty}: form flags are even between sides.`
        : `${pretty}: your ${dominantSide} side is flagged more often (${dominantSide === 'left' ? l : r}/${total}). Focus on symmetric movement.`;
    out.push({ joint, leftFlags: l, rightFlags: r, dominantSide, message });
  }
  out.sort((a, b) => (b.leftFlags + b.rightFlags) - (a.leftFlags + a.rightFlags));
  return out;
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

/** Push-vs-pull / upper-vs-lower balance groups for imbalance detection. */
const PUSH: MuscleRegion[] = ['chest', 'shoulders', 'triceps'];
const PULL: MuscleRegion[] = ['back', 'biceps'];
const LOWER: MuscleRegion[] = ['quads', 'hamstrings', 'glutes', 'calves'];

/** Build prioritized, actionable recommendations from the computed metrics. */
export function buildRecommendations(
  activations: MuscleActivation[],
  exerciseQuality: ExerciseQuality[],
  volume: VolumeStats,
  growth: MuscleGrowthStat[] = [],
  symmetry: SymmetryFlag[] = [],
): Recommendation[] {
  const recs: Recommendation[] = [];
  const vol = (r: MuscleRegion): number =>
    activations.find((a) => a.region === r)?.weightedVolume ?? 0;
  const sum = (rs: MuscleRegion[]): number => rs.reduce((s, r) => s + vol(r), 0);

  // --- Safety: any exercise with dangerous reps or very low quality ---
  for (const eq of exerciseQuality) {
    if (eq.qualityPercent < 50 && eq.totalReps >= 3) {
      const dev = eq.topDeviations[0];
      const cue = dev ? ` Most flagged joint: ${dev.joint.replace(/_/g, ' ')}.` : '';
      recs.push({
        kind: 'form',
        priority: 'high',
        message: `${eq.displayName} form is low (${eq.qualityPercent}% clean over ${eq.totalReps} reps).${cue} Slow down and focus on range of motion.`,
      });
    }
  }

  // --- Balance: push vs pull ---
  const push = sum(PUSH);
  const pull = sum(PULL);
  if (push + pull > 0) {
    const ratio = push / Math.max(1, pull);
    if (ratio >= 2 && pull < push) {
      recs.push({
        kind: 'balance',
        priority: 'medium',
        message: `You train pushing muscles much more than pulling (${Math.round(push)} vs ${Math.round(pull)} weighted reps). Add rows or pull-ups to balance your upper body.`,
      });
    } else if (pull >= 2 * push && push < pull) {
      recs.push({
        kind: 'balance',
        priority: 'medium',
        message: `Your pulling volume far exceeds pushing. Add presses or push-ups to balance out.`,
      });
    }
  }

  // --- Balance: upper vs lower ---
  const lower = sum(LOWER);
  const upper = sum([...PUSH, ...PULL, 'forearms']);
  if (upper + lower > 0) {
    if (lower === 0 && upper > 0) {
      recs.push({
        kind: 'balance',
        priority: 'medium',
        message: `No lower-body volume recorded. Add squats, lunges, or deadlifts for a balanced physique.`,
      });
    } else if (upper === 0 && lower > 0) {
      recs.push({
        kind: 'balance',
        priority: 'medium',
        message: `All your volume is lower-body. Add some upper-body work (push-ups, rows, presses).`,
      });
    }
  }

  // --- Untrained major muscles ---
  const worked = new Set(activations.map((a) => a.region));
  const majors: MuscleRegion[] = ['chest', 'back', 'quads', 'shoulders', 'glutes'];
  const missing = majors.filter((m) => !worked.has(m));
  if (missing.length > 0 && activations.length > 0) {
    recs.push({
      kind: 'balance',
      priority: 'low',
      message: `Untrained major muscle${missing.length > 1 ? 's' : ''}: ${missing.map((m) => REGION_LABELS[m]).join(', ')}. Consider adding work for ${missing.length > 1 ? 'them' : 'it'}.`,
    });
  }

  // --- Consistency ---
  if (volume.sessionsThisWeek === 0) {
    recs.push({
      kind: 'consistency',
      priority: 'medium',
      message: `No workouts logged in the last 7 days. A short session today keeps momentum going.`,
    });
  } else if (volume.currentStreakDays >= 3) {
    recs.push({
      kind: 'consistency',
      priority: 'low',
      message: `${volume.currentStreakDays}-day streak — nice consistency. Keep it up!`,
    });
  }

  // --- Growth: under-trained muscles this week ---
  const under = growth.filter((g) => g.status === 'under' && g.weeklySets > 0);
  if (under.length > 0) {
    const names = under.slice(0, 3).map((g) => `${g.label} (${g.weeklySets}/${g.targetSets} sets)`).join(', ');
    recs.push({
      kind: 'balance',
      priority: 'medium',
      message: `For muscle growth, aim for ~${TARGET_WEEKLY_SETS} sets/week per muscle. Below target this week: ${names}.`,
    });
  }

  // --- Symmetry: notable left/right imbalance ---
  for (const sym of symmetry) {
    if (sym.dominantSide !== 'balanced') {
      recs.push({ kind: 'form', priority: 'medium', message: sym.message });
    }
  }

  // Highest priority first, stable within priority.
  const rank = { high: 0, medium: 1, low: 2 } as const;
  recs.sort((a, b) => rank[a.priority] - rank[b.priority]);
  return recs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }

/** Re-export for callers that need it. */
export { normalizeMuscle };
