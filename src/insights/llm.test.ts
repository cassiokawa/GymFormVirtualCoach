/**
 * Tests for the LLM insight layer: safe Markdown rendering and prompt building.
 * The Ollama network path is not exercised here (it requires a live server);
 * these tests lock in the pure, deterministic pieces.
 */

import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown.js';
import { buildPrompt, reportToPromptData } from './LlmInsightGenerator.js';
import type { InsightsReport } from './analytics.js';

describe('renderMarkdown (safe subset)', () => {
  it('escapes HTML so model output cannot inject markup', () => {
    const html = renderMarkdown('Hello <script>alert(1)</script> & "friends"');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('renders headings, bold, and bullet lists', () => {
    const html = renderMarkdown('## Summary\n\nYou did **great**.\n\n- point one\n- point two');
    expect(html).toContain('Summary');
    expect(html).toContain('<strong>great</strong>');
    expect(html).toContain('<ul');
    expect(html).toContain('<li>point one</li>');
  });

  it('renders ordered lists', () => {
    const html = renderMarkdown('1. first\n2. second');
    expect(html).toContain('<ol');
    expect(html).toContain('<li>first</li>');
  });
});

describe('prompt building', () => {
  const report: InsightsReport = {
    activations: [{ region: 'quads', weightedVolume: 30, intensity: 1, quality: 0.8 }],
    exerciseQuality: [
      { exerciseName: 'barbell_squat', displayName: 'Barbell Squat', totalReps: 10, correctReps: 8, qualityPercent: 80, topDeviations: [{ joint: 'left_knee', count: 2 }] },
    ],
    volume: { totalReps: 10, totalSessions: 1, sessionsThisWeek: 1, currentStreakDays: 1, perMuscleReps: [{ region: 'quads', label: 'Quads', reps: 30 }] },
    growth: [{ region: 'quads', label: 'Quads', weeklySets: 3, targetSets: 10, status: 'under', daysSinceTrained: 1, recovery: 'recovering' }],
    symmetry: [{ joint: 'knee', leftFlags: 3, rightFlags: 1, dominantSide: 'left', message: 'x' }],
    recommendations: [{ kind: 'form', priority: 'high', message: 'Fix squat depth.' }],
    hasData: true,
  };

  it('includes real numbers and no fabricated fields', () => {
    const data = reportToPromptData(report) as Record<string, unknown>;
    expect(data).toHaveProperty('volume');
    expect(data).toHaveProperty('formByExercise');
    expect(data).toHaveProperty('weeklyGrowth');
    const prompt = buildPrompt(report);
    expect(prompt).toContain('Barbell Squat');
    expect(prompt).toContain('"cleanRepPercent": 80');
  });
});
