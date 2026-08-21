import type { Session } from '../types/index.js';
import { Storage } from '../storage/Storage.js';
import { ExportController } from './ExportController.js';
import type { SessionRowData } from './ExportController.js';

export class ExerciseLogPanel {
  private containerEl: HTMLElement | null = null;
  private expanded = false;
  private sessions: Session[] = [];
  private rowData: SessionRowData[] = [];
  private readonly storage: Storage;
  private readonly exportController: ExportController;

  constructor(storage: Storage) {
    this.storage = storage;
    this.exportController = new ExportController();
  }

  mount(container: HTMLElement): void {
    this.containerEl = container;
    this.renderShell();
  }

  private renderShell(): void {
    if (!this.containerEl) return;
    this.containerEl.innerHTML = `
      <section class="exercise-log-panel" aria-label="Workout History" style="margin-top:20px; width:640px; max-width:100%;">
        <button class="log-toggle" aria-expanded="false" style="width:100%; padding:10px 16px; border:none; border-radius:8px; background:#16213e; color:#eee; font-weight:600; cursor:pointer; text-align:left; font-size:0.9rem;">
          ▶ Workout History
        </button>
        <div class="log-content" style="display:none; margin-top:8px; background:#16213e; border-radius:8px; padding:12px; max-height:300px; overflow-y:auto;">
          <div class="log-table-area"></div>
          <div class="log-export" style="margin-top:12px; display:flex; gap:8px;">
            <button class="log-export-json" style="padding:6px 12px; border:none; border-radius:6px; background:#00b894; color:#fff; font-size:0.8rem; cursor:pointer;">Export JSON</button>
            <button class="log-export-csv" style="padding:6px 12px; border:none; border-radius:6px; background:#0984e3; color:#fff; font-size:0.8rem; cursor:pointer;">Export CSV</button>
          </div>
        </div>
      </section>
    `;

    const toggle = this.containerEl.querySelector('.log-toggle') as HTMLButtonElement;
    toggle.addEventListener('click', () => { void this.toggle(); });

    const jsonBtn = this.containerEl.querySelector('.log-export-json') as HTMLButtonElement;
    jsonBtn.addEventListener('click', () => {
      const content = this.exportController.exportJSON(this.rowData);
      this.exportController.download(content, ExportController.generateFilename('json'), 'application/json');
    });

    const csvBtn = this.containerEl.querySelector('.log-export-csv') as HTMLButtonElement;
    csvBtn.addEventListener('click', () => {
      const content = this.exportController.exportCSV(this.rowData);
      this.exportController.download(content, ExportController.generateFilename('csv'), 'text/csv');
    });
  }

  async toggle(): Promise<void> {
    this.expanded = !this.expanded;
    const content = this.containerEl?.querySelector('.log-content') as HTMLElement | null;
    const toggle = this.containerEl?.querySelector('.log-toggle') as HTMLButtonElement | null;
    if (content && toggle) {
      content.style.display = this.expanded ? 'block' : 'none';
      toggle.textContent = this.expanded ? '▼ Workout History' : '▶ Workout History';
      toggle.setAttribute('aria-expanded', String(this.expanded));
    }
    if (this.expanded) {
      await this.loadAndRender();
    }
  }

  /** Also callable externally to add a just-completed session without requerying storage */
  addSession(session: Session): void {
    this.sessions.unshift(session);
    this.rowData = this.sessions.map(s => ExerciseLogPanel.sessionToRowData(s));
    this.renderTable();
  }

  private async loadAndRender(): Promise<void> {
    try {
      const all = await this.storage.query({ from: new Date(0), to: new Date('2100-01-01') });
      this.sessions = [...all].reverse(); // descending
      this.rowData = this.sessions.map(s => ExerciseLogPanel.sessionToRowData(s));
      this.renderTable();
    } catch {
      const area = this.containerEl?.querySelector('.log-table-area');
      if (area) area.innerHTML = '<p style="color:#d63031; font-size:0.8rem;">Unable to load workout history.</p>';
    }
  }

  private renderTable(): void {
    const area = this.containerEl?.querySelector('.log-table-area');
    if (!area) return;

    if (this.rowData.length === 0) {
      area.innerHTML = '<p style="color:#888; font-size:0.8rem;">No sessions recorded yet. Complete a workout to see history.</p>';
      return;
    }

    let html = `<table style="width:100%; font-size:0.8rem; border-collapse:collapse;">
      <thead><tr style="border-bottom:1px solid #333;">
        <th style="text-align:left; padding:4px;">Date</th>
        <th style="text-align:left; padding:4px;">Exercises</th>
        <th style="text-align:right; padding:4px;">Reps</th>
        <th style="text-align:right; padding:4px;">Quality</th>
      </tr></thead><tbody>`;

    for (const row of this.rowData) {
      html += `<tr style="border-bottom:1px solid #222;">
        <td style="padding:4px;">${row.date}</td>
        <td style="padding:4px;">${row.exercises}</td>
        <td style="text-align:right; padding:4px;">${row.totalReps}</td>
        <td style="text-align:right; padding:4px;">${row.formQualityPercent}${row.formQualityPercent !== 'N/A' ? '%' : ''}</td>
      </tr>`;
    }

    html += '</tbody></table>';
    area.innerHTML = html;
  }

  // Static computation methods

  static computeTotalReps(session: Session): number {
    return session.sets.reduce((sum, set) => sum + set.reps.length, 0);
  }

  static computeCorrectReps(session: Session): number {
    return session.sets.reduce((sum, set) => sum + set.reps.filter(r => r.category === 'correct').length, 0);
  }

  static computeUniqueExercises(session: Session): string[] {
    return [...new Set(session.sets.map(s => s.exerciseName))].sort();
  }

  static computeFormQuality(session: Session): string {
    const total = ExerciseLogPanel.computeTotalReps(session);
    if (total === 0) return 'N/A';
    const correct = ExerciseLogPanel.computeCorrectReps(session);
    return String(Math.round((correct / total) * 100));
  }

  static formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  static sessionToRowData(session: Session): SessionRowData {
    return {
      date: ExerciseLogPanel.formatDate(session.startedAt),
      exercises: ExerciseLogPanel.computeUniqueExercises(session).map(n => n.replace(/_/g, ' ')).join(', '),
      totalReps: ExerciseLogPanel.computeTotalReps(session),
      formQualityPercent: ExerciseLogPanel.computeFormQuality(session),
    };
  }
}
