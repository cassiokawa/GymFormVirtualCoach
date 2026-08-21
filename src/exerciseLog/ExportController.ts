export interface SessionRowData {
  date: string;
  exercises: string;
  totalReps: number;
  formQualityPercent: string;
}

export class ExportController {
  exportJSON(rows: SessionRowData[]): string {
    return JSON.stringify(rows, null, 2);
  }

  exportCSV(rows: SessionRowData[]): string {
    const header = 'date,exercises,total_reps,form_quality_percent';
    const lines = rows.map(r => {
      const ex = r.exercises.includes(',') ? `"${r.exercises}"` : r.exercises;
      return `${r.date},${ex},${r.totalReps},${r.formQualityPercent}`;
    });
    return [header, ...lines].join('\n');
  }

  download(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  static generateFilename(extension: string): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `workout-history-${yyyy}-${mm}-${dd}.${extension}`;
  }
}
