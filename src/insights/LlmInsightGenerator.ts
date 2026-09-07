/**
 * LlmInsightGenerator — turns the deterministic {@link InsightsReport} into a
 * natural-language coaching report using a local Ollama model.
 *
 * The structured report (real numbers computed from the user's logs) is the
 * ground truth; the LLM only phrases and prioritizes it. The prompt explicitly
 * forbids inventing figures, so the prose stays faithful to the analytics.
 */

import type { InsightsReport } from './analytics.js';
import { OllamaClient, type GenerateOptions } from './OllamaClient.js';

const SYSTEM_PROMPT =
  'You are a concise, encouraging strength & conditioning coach. You are given ' +
  'a JSON summary of a user\'s recent workouts computed by a computer-vision ' +
  'form tracker. Write a short, practical coaching report in Markdown. Rules: ' +
  'only use facts present in the JSON — never invent numbers, exercises, or ' +
  'muscles; be specific and actionable; keep it under ~250 words; use short ' +
  'sections with headers (## Summary, ## Muscle Focus, ## Form, ## Next Session). ' +
  'Prioritize safety/form issues first. No preamble, no disclaimers.';

/** Compact the full report into the minimal JSON the model needs. */
export function reportToPromptData(report: InsightsReport): unknown {
  return {
    volume: report.volume,
    topMusclesByVolume: report.activations
      .slice(0, 6)
      .map((a) => ({ muscle: a.region, activation: a.intensity, formQuality: a.quality })),
    formByExercise: report.exerciseQuality.map((e) => ({
      exercise: e.displayName,
      cleanRepPercent: e.qualityPercent,
      totalReps: e.totalReps,
      mostFlaggedJoints: e.topDeviations.map((d) => d.joint),
    })),
    weeklyGrowth: report.growth.map((g) => ({
      muscle: g.label,
      setsThisWeek: g.weeklySets,
      targetSets: g.targetSets,
      status: g.status,
      daysSinceTrained: g.daysSinceTrained === Infinity ? null : g.daysSinceTrained,
      recovery: g.recovery,
    })),
    symmetry: report.symmetry.map((s) => ({
      joint: s.joint,
      leftFlags: s.leftFlags,
      rightFlags: s.rightFlags,
      dominantSide: s.dominantSide,
    })),
    ruleBasedRecommendations: report.recommendations.map((r) => ({
      topic: r.kind,
      priority: r.priority,
      note: r.message,
    })),
  };
}

/** Build the user prompt from the report. */
export function buildPrompt(report: InsightsReport): string {
  const data = JSON.stringify(reportToPromptData(report), null, 2);
  return (
    'Here is the workout summary JSON. Write the coaching report described in ' +
    'your instructions, grounded strictly in these facts:\n\n```json\n' +
    data +
    '\n```'
  );
}

export interface LlmReportOptions {
  model: string;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * Generate a coaching report via Ollama. Returns the model's Markdown text.
 * Propagates {@link OllamaError} from the client so the caller can show a
 * helpful message (and fall back to the rule-based report).
 */
export class LlmInsightGenerator {
  private readonly client: OllamaClient;

  constructor(client: OllamaClient = new OllamaClient()) {
    this.client = client;
  }

  /** List locally-installed models for the model picker. */
  listModels(): ReturnType<OllamaClient['listModels']> {
    return this.client.listModels();
  }

  /** Produce a natural-language coaching report from the structured insights. */
  async generateReport(report: InsightsReport, opts: LlmReportOptions): Promise<string> {
    if (!report.hasData) {
      return 'Complete a workout first — there is no data yet to analyze.';
    }
    const generateOpts: GenerateOptions = {
      model: opts.model,
      prompt: buildPrompt(report),
      system: SYSTEM_PROMPT,
      temperature: opts.temperature ?? 0.4,
    };
    if (opts.signal !== undefined) generateOpts.signal = opts.signal;
    return this.client.generate(generateOpts);
  }
}
