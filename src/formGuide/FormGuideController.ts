/**
 * FormGuideController — wires FormGuideUI to PhaseController.
 *
 * When the user clicks "I'm Ready" in the form guide panel, this controller:
 *   1. Transitions the LLM phase from pre_workout → session_active via
 *      PhaseController.onSessionStart().
 *   2. Hides the form guide UI.
 *   3. Invokes any registered onWorkoutStart callback so the caller can
 *      transition the application to workout execution mode.
 *
 * Requirement covered: 7.4
 */

import { FormGuide } from './FormGuide.js';
import { FormGuideUI } from './FormGuideUI.js';
import { PhaseController } from '../llmGateway/PhaseController.js';

export class FormGuideController {
  private readonly ui: FormGuideUI;
  private readonly phaseController: PhaseController;
  private onWorkoutStartCallback: (() => void) | null = null;

  constructor(
    containerEl: HTMLElement,
    guide: FormGuide,
    phaseController: PhaseController,
  ) {
    this.ui = new FormGuideUI(guide);
    this.phaseController = phaseController;
    this.ui.mount(containerEl);

    // Wire the "I'm Ready" callback to the phase transition
    this.ui.onReadyConfirmed(() => {
      this.phaseController.onSessionStart(); // pre_workout → session_active
      this.ui.hide();
      if (this.onWorkoutStartCallback !== null) {
        this.onWorkoutStartCallback();
      }
    });
  }

  showExercise(exerciseName: string): void {
    this.ui.showExercise(exerciseName);
  }

  /** Register callback invoked when the user confirms readiness and the workout starts. */
  onWorkoutStart(callback: () => void): void {
    this.onWorkoutStartCallback = callback;
  }
}
