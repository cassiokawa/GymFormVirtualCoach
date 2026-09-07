/**
 * InsightsPanel — collapsible "Body & Insights" panel.
 *
 * Loads workout sessions from Storage, runs the analytics engine, and renders:
 * - a 2D anatomy heat-map of worked muscles (front + back),
 * - a per-muscle volume legend,
 * - per-exercise form-quality bars,
 * - volume/consistency headline stats,
 * - prioritized recommendations.
 *
 * Mirrors the collapsible-panel pattern used elsewhere in the demo UI and uses
 * the shared design tokens from index.html.
 */

import type { Session } from '../types/index.js';
import type { Storage } from '../storage/Storage.js';
import { computeInsights, type InsightsReport, type Recommendation, type MuscleGrowthStat } from './analytics.js';
import { AnatomyView } from './AnatomyView.js';
import { BodyModel3D } from './BodyModel3D.js';
import { REGION_LABELS } from './muscleMap.js';
import { LlmInsightGenerator } from './LlmInsightGenerator.js';
import { OllamaError } from './OllamaClient.js';
import { renderMarkdown } from './markdown.js';

export class InsightsPanel {
  private readonly storage: Storage;
  private container: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private anatomy: AnatomyView | null = null;
  private body3d: BodyModel3D | null = null;
  private use3d = BodyModel3D.isSupported();
  private lastReport: InsightsReport | null = null;
  private sessions: Session[] = [];
  private expanded = false;
  private readonly llm = new LlmInsightGenerator();
  private aiAbort: AbortController | null = null;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  mount(container: HTMLElement): void {
    this.container = container;
    const details = document.createElement('details');
    details.style.marginTop = '12px';

    const summary = document.createElement('summary');
    summary.textContent = '🧠 Body & Insights';
    details.appendChild(summary);

    const body = document.createElement('div');
    body.style.paddingTop = '14px';
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '18px';
    body.innerHTML = '<div style="color:var(--text-dim); font-size:0.85rem;">Loading your workout insights…</div>';
    this.bodyEl = body;
    details.appendChild(body);

    // Lazy-load on first open so we don't query storage until needed.
    details.addEventListener('toggle', () => {
      if (details.open && !this.expanded) {
        this.expanded = true;
        void this.loadAndRender();
      }
    });

    container.appendChild(details);
  }

  /** Called by the app after a session is saved to refresh live. */
  addSession(session: Session): void {
    this.sessions.unshift(session);
    if (this.expanded) this.renderReport(computeInsights(this.sessions));
  }

  private async loadAndRender(): Promise<void> {
    try {
      const all = await this.storage.query({ from: new Date(0), to: new Date('2100-01-01') });
      this.sessions = [...all].reverse();
      this.renderReport(computeInsights(this.sessions));
    } catch {
      if (this.bodyEl) {
        this.bodyEl.innerHTML =
          '<div style="color:var(--danger); font-size:0.85rem;">Unable to load workout history.</div>';
      }
    }
  }

  private renderReport(report: InsightsReport): void {
    const body = this.bodyEl;
    if (!body) return;
    body.replaceChildren();

    this.lastReport = report;
    if (!report.hasData) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-dim); font-size:0.85rem; text-align:center; padding:20px;';
      empty.textContent = 'Complete a workout to see which muscles you trained, your form quality, and personalized recommendations.';
      body.appendChild(empty);
      return;
    }

    body.appendChild(this.buildAnatomySection(report));
    body.appendChild(this.buildGrowthSection(report));
    body.appendChild(this.buildVolumeStats(report));
    body.appendChild(this.buildFormQuality(report));
    body.appendChild(this.buildSymmetrySection(report));
    body.appendChild(this.buildRecommendations(report.recommendations));
    body.appendChild(this.buildAiReportSection(report));
  }

  private buildAiReportSection(report: InsightsReport): HTMLElement {
    const wrap = document.createElement('div');
    wrap.appendChild(sectionTitle('AI Coach Report (local LLM)'));

    // Controls row: model picker + generate button.
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';

    const select = document.createElement('select');
    select.style.cssText = 'flex:1; min-width:180px; font-size:0.82rem;';
    // Seed with commonly-installed local models; refreshed from Ollama below.
    const seed = ['phi3:mini', 'gemma4:12b', 'qwen2.5-coder:32b', 'llama3.3:70b'];
    for (const name of seed) {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      select.appendChild(opt);
    }

    const genBtn = document.createElement('button');
    genBtn.type = 'button';
    genBtn.textContent = '✨ Generate';
    genBtn.style.cssText = 'background:linear-gradient(135deg,var(--violet),#8a7bff); color:#fff; font-size:0.82rem;';

    controls.appendChild(select);
    controls.appendChild(genBtn);
    wrap.appendChild(controls);

    const status = document.createElement('div');
    status.style.cssText = 'font-size:0.72rem; color:var(--text-faint); margin-top:6px; min-height:1em;';
    wrap.appendChild(status);

    const output = document.createElement('div');
    output.style.cssText = 'margin-top:10px; background:var(--bg-2); border:1px solid var(--line); border-radius:12px; padding:14px; font-size:0.82rem; line-height:1.55; display:none;';
    wrap.appendChild(output);

    // Populate the dropdown from the local Ollama server (best-effort).
    void this.llm.listModels().then((models) => {
      if (models.length === 0) return;
      select.replaceChildren();
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.name; opt.textContent = m.name;
        select.appendChild(opt);
      }
    }).catch(() => {
      status.textContent = 'Tip: start Ollama (and OLLAMA_ORIGINS=* if needed) to auto-list your models.';
    });

    genBtn.addEventListener('click', () => {
      // Cancel any in-flight generation.
      this.aiAbort?.abort();
      this.aiAbort = new AbortController();
      genBtn.disabled = true;
      genBtn.style.opacity = '0.5';
      status.textContent = `Generating with ${select.value}… (local models can take a while)`;
      output.style.display = 'none';

      this.llm
        .generateReport(report, { model: select.value, signal: this.aiAbort.signal })
        .then((text) => {
          output.innerHTML = renderMarkdown(text);
          output.style.display = 'block';
          status.textContent = `Generated by ${select.value} · grounded in your logged data`;
        })
        .catch((err: unknown) => {
          const msg = err instanceof OllamaError ? err.message : String(err);
          status.textContent = `Couldn't generate: ${msg}`;
        })
        .finally(() => {
          genBtn.disabled = false;
          genBtn.style.opacity = '1';
        });
    });

    return wrap;
  }

  // --- Sections ------------------------------------------------------------

  private buildAnatomySection(report: InsightsReport): HTMLElement {
    const wrap = document.createElement('div');

    // Title row with a 2D/3D toggle (only when WebGL is available).
    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;';
    titleRow.appendChild(sectionTitle('Muscles Worked'));
    if (BodyModel3D.isSupported()) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.textContent = this.use3d ? 'View 2D' : 'View 3D';
      toggle.style.cssText = 'padding:5px 12px; font-size:0.72rem; background:var(--bg-3); color:var(--text); border:1px solid var(--line-strong); border-radius:999px;';
      toggle.addEventListener('click', () => {
        this.use3d = !this.use3d;
        toggle.textContent = this.use3d ? 'View 2D' : 'View 3D';
        if (this.lastReport) this.renderReport(this.lastReport);
      });
      titleRow.appendChild(toggle);
    }
    wrap.appendChild(titleRow);

    const figure = document.createElement('div');
    figure.style.cssText =
      'display:flex; gap:16px; justify-content:center; align-items:flex-start; flex-wrap:wrap; background:var(--bg-2); border:1px solid var(--line); border-radius:14px; padding:16px; min-height:200px;';
    wrap.appendChild(figure);

    // Dispose any previous 3D instance before re-rendering.
    if (this.body3d) { this.body3d.dispose(); this.body3d = null; }

    if (this.use3d && BodyModel3D.isSupported()) {
      const stage = document.createElement('div');
      stage.style.cssText = 'width:100%; max-width:340px;';
      figure.appendChild(stage);
      try {
        this.body3d = new BodyModel3D(stage);
        this.body3d.init();
        this.body3d.update(report.activations);
      } catch {
        // WebGL context creation can still fail on some devices; fall back to 2D.
        this.body3d = null;
        this.use3d = false;
        figure.replaceChildren();
        this.anatomy = new AnatomyView(figure);
        this.anatomy.render(report.activations);
      }
      const hint = document.createElement('div');
      hint.style.cssText = 'width:100%; text-align:center; font-size:0.68rem; color:var(--text-faint); margin-top:4px;';
      hint.textContent = 'Drag to rotate · scroll to zoom · hover a muscle for detail';
      wrap.appendChild(hint);
    } else {
      this.anatomy = new AnatomyView(figure);
      this.anatomy.render(report.activations);
    }

    // Legend / heat scale.
    const legend = document.createElement('div');
    legend.style.cssText = 'display:flex; gap:14px; justify-content:center; margin-top:8px; font-size:0.7rem; color:var(--text-dim); flex-wrap:wrap;';
    legend.innerHTML =
      '<span style="color:#ff2200;">🔴 hot = high volume</span>' +
      '<span style="color:#1a6bff;">🔵 cold = neglected</span>' +
      '<span style="color:#cc00ff;">🟣 purple = injury risk (bad form)</span>';
    wrap.appendChild(legend);

    return wrap;
  }

  private buildGrowthSection(report: InsightsReport): HTMLElement {
    const wrap = document.createElement('div');
    wrap.appendChild(sectionTitle('Muscle Growth (last 7 days)'));

    if (report.growth.length === 0) {
      const none = document.createElement('div');
      none.style.cssText = 'color:var(--text-dim); font-size:0.8rem;';
      none.textContent = 'No trainable volume this week yet.';
      wrap.appendChild(none);
      return wrap;
    }

    const list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
    for (const g of report.growth) {
      const pct = Math.min(100, Math.round((g.weeklySets / g.targetSets) * 100));
      const statusColor = g.status === 'optimal' ? 'var(--accent)' : g.status === 'over' ? 'var(--warn)' : 'var(--text-faint)';
      const recoveryDot = g.recovery === 'fresh' ? '🟢' : g.recovery === 'recovering' ? '🟡' : '⚪';
      const rest = g.daysSinceTrained === Infinity ? 'never' : g.daysSinceTrained === 0 ? 'today' : `${g.daysSinceTrained}d ago`;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:0.75rem;';
      row.innerHTML =
        `<span style="min-width:78px; color:var(--text-dim);">${g.label}</span>` +
        `<span style="flex:1; height:8px; background:var(--bg-3); border-radius:999px; overflow:hidden;">` +
        `<span style="display:block; height:100%; width:${pct}%; background:${statusColor};"></span></span>` +
        `<span style="min-width:52px; text-align:right; color:var(--text);">${g.weeklySets}/${g.targetSets} sets</span>` +
        `<span title="last trained ${rest}" style="min-width:60px; text-align:right; color:var(--text-faint);">${recoveryDot} ${rest}</span>`;
      list.appendChild(row);
    }
    wrap.appendChild(list);

    const legend = document.createElement('div');
    legend.style.cssText = 'font-size:0.68rem; color:var(--text-faint); margin-top:6px;';
    legend.textContent = 'Target ~10 sets/week per muscle for growth · 🟢 recovered · 🟡 recovering · ⚪ stale';
    wrap.appendChild(legend);
    return wrap;
  }

  private buildSymmetrySection(report: InsightsReport): HTMLElement {
    const wrap = document.createElement('div');
    if (report.symmetry.length === 0) return wrap; // hide when no signal
    wrap.appendChild(sectionTitle('Left / Right Symmetry'));

    const list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
    for (const sym of report.symmetry) {
      const total = sym.leftFlags + sym.rightFlags;
      const leftPct = total > 0 ? Math.round((sym.leftFlags / total) * 100) : 50;
      const balanced = sym.dominantSide === 'balanced';
      const row = document.createElement('div');
      row.style.cssText = 'background:var(--bg-2); border:1px solid var(--line); border-radius:10px; padding:8px 10px; font-size:0.75rem;';
      row.innerHTML =
        `<div style="display:flex; justify-content:space-between; margin-bottom:5px;">` +
        `<span style="color:var(--text-dim);">${sym.joint.replace(/_/g, ' ')}</span>` +
        `<span style="color:${balanced ? 'var(--accent)' : 'var(--warn)'};">${balanced ? 'balanced' : `${sym.dominantSide} heavy`}</span></div>` +
        `<div style="display:flex; height:8px; border-radius:999px; overflow:hidden; background:var(--bg-3);">` +
        `<span style="width:${leftPct}%; background:var(--violet);"></span>` +
        `<span style="width:${100 - leftPct}%; background:var(--accent);"></span></div>` +
        `<div style="display:flex; justify-content:space-between; font-size:0.65rem; color:var(--text-faint); margin-top:3px;">` +
        `<span>L ${sym.leftFlags}</span><span>R ${sym.rightFlags}</span></div>`;
      list.appendChild(row);
    }
    wrap.appendChild(list);
    return wrap;
  }

  private buildVolumeStats(report: InsightsReport): HTMLElement {
    const v = report.volume;
    const wrap = document.createElement('div');
    wrap.appendChild(sectionTitle('Volume & Consistency'));

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fit, minmax(90px,1fr)); gap:10px;';
    grid.appendChild(statTile(String(v.totalReps), 'Total reps'));
    grid.appendChild(statTile(String(v.totalSessions), 'Sessions'));
    grid.appendChild(statTile(String(v.sessionsThisWeek), 'This week'));
    grid.appendChild(statTile(`${v.currentStreakDays}d`, 'Streak'));
    wrap.appendChild(grid);

    // Per-muscle volume bars.
    if (v.perMuscleReps.length > 0) {
      const max = Math.max(1, ...v.perMuscleReps.map((m) => m.reps));
      const bars = document.createElement('div');
      bars.style.cssText = 'margin-top:12px; display:flex; flex-direction:column; gap:6px;';
      for (const m of v.perMuscleReps) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:0.75rem;';
        row.innerHTML =
          `<span style="min-width:78px; color:var(--text-dim);">${m.label}</span>` +
          `<span style="flex:1; height:8px; background:var(--bg-3); border-radius:999px; overflow:hidden;">` +
          `<span style="display:block; height:100%; width:${Math.round((m.reps / max) * 100)}%; background:linear-gradient(90deg,var(--accent),var(--violet));"></span></span>` +
          `<span style="min-width:28px; text-align:right; color:var(--text);">${m.reps}</span>`;
        bars.appendChild(row);
      }
      wrap.appendChild(bars);
    }
    return wrap;
  }

  private buildFormQuality(report: InsightsReport): HTMLElement {
    const wrap = document.createElement('div');
    wrap.appendChild(sectionTitle('Form Quality by Exercise'));

    const list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
    for (const eq of report.exerciseQuality) {
      const color = eq.qualityPercent >= 75 ? 'var(--accent)' : eq.qualityPercent >= 50 ? 'var(--warn)' : 'var(--danger)';
      const row = document.createElement('div');
      row.style.cssText = 'background:var(--bg-2); border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:0.78rem;';
      const devNote = eq.topDeviations.length > 0
        ? `<div style="color:var(--text-faint); font-size:0.7rem; margin-top:3px;">Most flagged: ${eq.topDeviations.map((d) => `${d.joint.replace(/_/g, ' ')} (${d.count})`).join(', ')}</div>`
        : '';
      row.innerHTML =
        `<div style="display:flex; justify-content:space-between; align-items:center;">` +
        `<span style="font-weight:600;">${eq.displayName}</span>` +
        `<span style="font-weight:700; color:${color};">${eq.qualityPercent}%</span></div>` +
        `<div style="margin-top:6px; height:6px; background:var(--bg-3); border-radius:999px; overflow:hidden;">` +
        `<span style="display:block; height:100%; width:${eq.qualityPercent}%; background:${color};"></span></div>` +
        `<div style="color:var(--text-faint); font-size:0.7rem; margin-top:4px;">${eq.correctReps}/${eq.totalReps} clean reps</div>` +
        devNote;
      list.appendChild(row);
    }
    wrap.appendChild(list);
    return wrap;
  }

  private buildRecommendations(recs: Recommendation[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.appendChild(sectionTitle('Recommendations'));

    if (recs.length === 0) {
      const ok = document.createElement('div');
      ok.style.cssText = 'color:var(--text-dim); font-size:0.8rem;';
      ok.textContent = 'No issues detected — balanced training and solid form. Keep it up!';
      wrap.appendChild(ok);
      return wrap;
    }

    const list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
    const icon = { high: '🔴', medium: '🟡', low: '🟢' } as const;
    for (const rec of recs) {
      const item = document.createElement('div');
      item.style.cssText =
        'display:flex; gap:10px; align-items:flex-start; background:var(--bg-2); border:1px solid var(--line); border-left:3px solid ' +
        (rec.priority === 'high' ? 'var(--danger)' : rec.priority === 'medium' ? 'var(--warn)' : 'var(--accent)') +
        '; border-radius:10px; padding:10px 12px; font-size:0.8rem; line-height:1.45;';
      item.innerHTML = `<span>${icon[rec.priority]}</span><span>${rec.message}</span>`;
      list.appendChild(item);
    }
    wrap.appendChild(list);
    return wrap;
  }
}

// --- small DOM helpers -----------------------------------------------------

function sectionTitle(text: string): HTMLElement {
  const h = document.createElement('div');
  h.textContent = text;
  h.style.cssText =
    'font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-faint); margin-bottom:8px;';
  return h;
}

function statTile(value: string, label: string): HTMLElement {
  const t = document.createElement('div');
  t.style.cssText = 'background:var(--bg-2); border:1px solid var(--line); border-radius:10px; padding:10px; text-align:center;';
  t.innerHTML =
    `<div style="font-size:1.3rem; font-weight:800; color:var(--accent);">${value}</div>` +
    `<div style="font-size:0.62rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-faint); margin-top:2px;">${label}</div>`;
  return t;
}

// Re-export for potential external use.
export { REGION_LABELS };
