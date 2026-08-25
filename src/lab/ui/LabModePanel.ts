/**
 * LabModePanel — vanilla DOM controls and dashboard for the CV Algorithm Lab.
 *
 * Renders a collapsible dark-themed panel (matching {@link ../../index.html}'s
 * inline style) containing:
 * - a model selection dropdown populated from the registry (Req 10.1),
 * - benchmark start/stop controls (Req 10.1),
 * - a live FPS/latency indicator updated >= 1x/sec by the frame loop (Req 10.4),
 * - a results dashboard listing collected {@link BenchmarkResult}s, and
 * - a recommendation panel shown when >= 2 results exist (Req 10.5).
 *
 * The panel is framework-free: it builds DOM with `document.createElement` and
 * inline styles, mirroring the rest of the app. It reads state from the
 * injected {@link AlgorithmLab} and reflects changes on demand via
 * {@link renderResults} and {@link updateLiveMetrics}.
 *
 * Requirements covered: 10.1, 10.4, 10.5, 9.5
 * Design: "10. AlgorithmLab Orchestrator + LabModePanel".
 */

import type { AlgorithmLab } from '../AlgorithmLab.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';
import type { BenchmarkResult, Recommendation } from '../types.js';

/** Accent color used throughout the app UI. */
const ACCENT = 'var(--accent, #00d4a0)';
/** Elevated surface background. */
const SURFACE = 'var(--bg-2, #1a2444)';
/** Deeper surface background for cards. */
const SURFACE_DEEP = 'var(--bg-1, #121a33)';
/** Hairline border color. */
const LINE = 'var(--line, rgba(255,255,255,0.08))';
/** Dim text color. */
const TEXT_DIM = 'var(--text-dim, #9aa4c0)';
/** Danger/invalid color. */
const DANGER = 'var(--danger, #ff5a6a)';

/**
 * A collapsible Lab Mode panel bound to an {@link AlgorithmLab} instance.
 */
export class LabModePanel {
  private readonly lab: AlgorithmLab;
  private readonly registry: ModelRegistry;

  /** Root element created on {@link mount}. */
  private root: HTMLElement | null = null;
  /** Model selection dropdown. */
  private modelSelect: HTMLSelectElement | null = null;
  /** Benchmark start button. */
  private startButton: HTMLButtonElement | null = null;
  /** Benchmark stop button. */
  private stopButton: HTMLButtonElement | null = null;
  /** Live FPS/latency indicator element. */
  private liveIndicator: HTMLElement | null = null;
  /** Results dashboard container. */
  private dashboard: HTMLElement | null = null;
  /** Recommendation panel container. */
  private recommendationPanel: HTMLElement | null = null;
  /** Status line for benchmark progress/errors. */
  private statusLine: HTMLElement | null = null;
  /**
   * Optional async hook the host wires up to actually run a benchmark for the
   * currently-selected model (capturing frames from the live camera). When
   * unset (e.g. in unit tests) the Benchmark button only toggles button state.
   */
  private onRunBenchmark: (() => Promise<void>) | null = null;

  /**
   * @param lab      The orchestrator this panel drives and reads from.
   * @param registry Registry whose {@link ModelRegistry.list} populates the dropdown.
   */
  constructor(lab: AlgorithmLab, registry: ModelRegistry) {
    this.lab = lab;
    this.registry = registry;
  }

  /**
   * Build and append the panel into `container`. Safe to call once; a second
   * call rebuilds the panel from scratch.
   *
   * @param container Parent element to mount the panel into.
   */
  mount(container: HTMLElement): void {
    const details = document.createElement('details');

    const summary = document.createElement('summary');
    summary.textContent = '🔬 Algorithm Lab';
    details.appendChild(summary);

    const body = document.createElement('div');
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '12px';
    body.style.paddingTop = '14px';

    body.appendChild(this.buildControlsRow());
    body.appendChild(this.buildLiveIndicator());
    body.appendChild(this.buildStatusLine());
    body.appendChild(this.buildDashboard());
    body.appendChild(this.buildRecommendationPanel());

    details.appendChild(body);
    container.appendChild(details);

    this.root = details;
    this.populateModels();
    this.renderResults();
  }

  /**
   * Register the host callback that runs a real benchmark for the selected
   * model. The host is responsible for capturing frames and invoking
   * {@link AlgorithmLab.startBenchmark}. Wiring this enables the Benchmark
   * button to perform an actual run rather than only toggling button state.
   */
  setBenchmarkRunner(run: () => Promise<void>): void {
    this.onRunBenchmark = run;
  }

  /** Show a transient status message in the panel. */
  setStatus(message: string): void {
    if (this.statusLine !== null) {
      this.statusLine.textContent = message;
    }
  }

  /**
   * Update the live FPS/latency indicator. Called at least once per second by
   * the frame loop while a model is actively processing frames (Req 10.4).
   *
   * @param fps       Current frames-per-second estimate.
   * @param latencyMs Current per-frame latency estimate in milliseconds.
   */
  updateLiveMetrics(fps: number, latencyMs: number): void {
    if (this.liveIndicator === null) return;
    this.liveIndicator.textContent = `Live: ${fps.toFixed(1)} FPS · ${latencyMs.toFixed(1)} ms/frame`;
  }

  /**
   * Re-render the results dashboard and recommendation panel from the lab's
   * current state. Call after a benchmark completes.
   */
  renderResults(): void {
    this.renderDashboard();
    this.renderRecommendation();
  }

  // -------------------------------------------------------------------------
  // Construction helpers
  // -------------------------------------------------------------------------

  /** Build the row containing the model dropdown and benchmark buttons. */
  private buildControlsRow(): HTMLElement {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    row.style.flexWrap = 'wrap';

    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Pose model');
    // Radius, border, background, and focus styling come from the global select
    // CSS in index.html; here we only set flex sizing.
    select.style.flex = '1';
    select.style.minWidth = '180px';
    select.style.fontSize = '0.85rem';
    select.addEventListener('change', () => {
      void this.lab.setActiveModel(select.value).catch(() => {
        /* invalid selection is ignored; dropdown only lists valid ids */
      });
    });
    this.modelSelect = select;

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.textContent = '▶ Benchmark';
    this.styleButton(startBtn, ACCENT);
    this.startButton = startBtn;

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.textContent = '■ Stop';
    stopBtn.disabled = true;
    this.styleButton(stopBtn, 'var(--danger, #ff5a6a)', '#fff');
    stopBtn.style.opacity = '0.5';
    this.stopButton = stopBtn;

    // Start/stop toggle the disabled state; actual benchmark frames are driven
    // by the host frame loop via lab.startBenchmark.
    startBtn.addEventListener('click', () => {
      startBtn.disabled = true;
      startBtn.style.opacity = '0.5';
      stopBtn.disabled = false;
      stopBtn.style.opacity = '1';

      const run = this.onRunBenchmark;
      if (run === null) {
        // No host hook (e.g. unit tests): just leave the buttons toggled.
        return;
      }
      this.setStatus('Benchmarking…');
      run()
        .then(() => {
          this.setStatus('Benchmark complete.');
          this.renderResults();
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.setStatus(`Benchmark failed: ${message}`);
        })
        .finally(() => {
          startBtn.disabled = false;
          startBtn.style.opacity = '1';
          stopBtn.disabled = true;
          stopBtn.style.opacity = '0.5';
        });
    });
    stopBtn.addEventListener('click', () => {
      stopBtn.disabled = true;
      stopBtn.style.opacity = '0.5';
      startBtn.disabled = false;
      startBtn.style.opacity = '1';
      this.renderResults();
    });

    row.appendChild(select);
    row.appendChild(startBtn);
    row.appendChild(stopBtn);
    return row;
  }

  /** Build the live FPS/latency indicator element. */
  private buildLiveIndicator(): HTMLElement {
    const indicator = document.createElement('div');
    indicator.style.fontSize = '0.78rem';
    indicator.style.color = TEXT_DIM;
    indicator.style.fontVariantNumeric = 'tabular-nums';
    indicator.textContent = 'Live: — FPS · — ms/frame';
    this.liveIndicator = indicator;
    return indicator;
  }

  /** Build the benchmark status line element. */
  private buildStatusLine(): HTMLElement {
    const status = document.createElement('div');
    status.style.fontSize = '0.8rem';
    status.style.color = ACCENT;
    status.style.fontWeight = '600';
    status.style.minHeight = '1em';
    this.statusLine = status;
    return status;
  }

  /** Build the results dashboard container. */
  private buildDashboard(): HTMLElement {
    const dashboard = document.createElement('div');
    dashboard.style.display = 'flex';
    dashboard.style.flexDirection = 'column';
    dashboard.style.gap = '6px';
    this.dashboard = dashboard;
    return dashboard;
  }

  /** Build the recommendation panel container (hidden until >= 2 results). */
  private buildRecommendationPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.style.display = 'none';
    panel.style.padding = '14px 16px';
    panel.style.borderRadius = '14px';
    panel.style.background = 'var(--accent-soft, rgba(0,212,160,0.14))';
    panel.style.border = '1px solid rgba(0,212,160,0.35)';
    panel.style.fontSize = '0.82rem';
    panel.style.lineHeight = '1.5';
    this.recommendationPanel = panel;
    return panel;
  }

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  /** Populate the model dropdown from the registry (Req 10.1). */
  private populateModels(): void {
    const select = this.modelSelect;
    if (select === null) return;
    select.innerHTML = '';

    const metadata = this.registry.list();
    for (const meta of metadata) {
      const option = document.createElement('option');
      option.value = meta.id;
      option.textContent = `${meta.displayName} (${meta.keypointCount}kp · ${meta.backend})`;
      select.appendChild(option);
    }

    // Reflect the current active model, or select the first available.
    const activeId = this.lab.getActiveModelId();
    if (activeId !== null && this.registry.has(activeId)) {
      select.value = activeId;
    } else if (metadata[0] !== undefined) {
      select.value = metadata[0].id;
      void this.lab.setActiveModel(metadata[0].id).catch(() => {
        /* ignore */
      });
    }
  }

  /** Render the collected benchmark results into the dashboard. */
  private renderDashboard(): void {
    const dashboard = this.dashboard;
    if (dashboard === null) return;
    dashboard.innerHTML = '';

    const results = this.lab.getResults();
    if (results.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = TEXT_DIM;
      empty.style.fontSize = '0.82rem';
      empty.style.padding = '14px';
      empty.style.textAlign = 'center';
      empty.style.background = SURFACE;
      empty.style.borderRadius = '12px';
      empty.style.border = `1px dashed ${LINE}`;
      empty.textContent = 'No benchmark results yet. Select a model and run a benchmark.';
      dashboard.appendChild(empty);
      return;
    }

    for (const result of results) {
      dashboard.appendChild(this.buildResultCard(result));
    }
  }

  /** Build a single result card summarizing one {@link BenchmarkResult}. */
  private buildResultCard(result: BenchmarkResult): HTMLElement {
    const card = document.createElement('div');
    card.style.padding = '12px 14px';
    card.style.borderRadius = '12px';
    card.style.background = SURFACE_DEEP;
    card.style.border = `1px solid ${LINE}`;
    card.style.fontSize = '0.82rem';

    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.style.color = result.valid ? ACCENT : DANGER;
    title.textContent = `${result.modelId}${result.valid ? '' : ' (invalid)'}`;
    card.appendChild(title);

    const metrics = document.createElement('div');
    metrics.style.color = TEXT_DIM;
    metrics.style.marginTop = '4px';
    const fps = result.latency.meanFps.toFixed(1);
    const median = result.latency.medianMs.toFixed(1);
    const p95 = result.latency.p95Ms.toFixed(1);
    const accuracy =
      result.accuracy !== null
        ? `${(result.accuracy.meanOks * 100).toFixed(0)}% OKS`
        : 'accuracy N/A';
    metrics.textContent = `${fps} FPS · median ${median} ms · p95 ${p95} ms · ${accuracy} · ${result.successCount}/${result.frameCount} frames`;
    card.appendChild(metrics);

    if (result.warning !== undefined) {
      const warning = document.createElement('div');
      warning.style.color = '#fbbf24';
      warning.style.marginTop = '2px';
      warning.textContent = `⚠️ ${result.warning}`;
      card.appendChild(warning);
    }

    return card;
  }

  /** Render (or hide) the recommendation panel based on available results. */
  private renderRecommendation(): void {
    const panel = this.recommendationPanel;
    if (panel === null) return;

    const recommendation: Recommendation | null = this.lab.getRecommendation();
    if (recommendation === null) {
      panel.style.display = 'none';
      panel.innerHTML = '';
      return;
    }

    panel.style.display = '';
    panel.innerHTML = '';

    const heading = document.createElement('div');
    heading.style.fontWeight = '600';
    heading.style.color = ACCENT;
    heading.textContent = `🏆 Recommended: ${recommendation.bestOverallModelId}`;
    panel.appendChild(heading);

    const summary = document.createElement('div');
    summary.style.color = '#ddd';
    summary.style.marginTop = '4px';
    summary.textContent = recommendation.summary;
    panel.appendChild(summary);

    if (recommendation.perRegionNotes.length > 0) {
      const notes = document.createElement('ul');
      notes.style.margin = '8px 0 0 18px';
      notes.style.color = TEXT_DIM;
      notes.style.display = 'flex';
      notes.style.flexDirection = 'column';
      notes.style.gap = '4px';
      for (const note of recommendation.perRegionNotes) {
        const li = document.createElement('li');
        li.textContent = note;
        notes.appendChild(li);
      }
      panel.appendChild(notes);
    }
  }

  /** Apply the shared app button styling with a given background color. */
  private styleButton(button: HTMLButtonElement, background: string, color = '#05231c'): void {
    // Radius, hover, focus, and transitions come from the global button CSS in
    // index.html; here we only set the background, text color, and compact sizing.
    button.style.padding = '9px 16px';
    button.style.background = background;
    button.style.color = color;
    button.style.fontSize = '0.85rem';
  }
}
