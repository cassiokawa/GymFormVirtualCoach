/**
 * FormGuideUI — DOM-manipulation UI layer for the Form_Guide component.
 *
 * Pure TypeScript; no framework. Renders step-by-step instructions and
 * reference media into a host container element, then exposes a callback
 * that fires when the user clicks "I'm Ready".
 *
 * Requirements covered: 7.1, 7.2, 7.3, 7.4
 */

import type { ExerciseGuide, FormStep, MediaReference } from './FormGuide.js';
import { FormGuide } from './FormGuide.js';

// ---------------------------------------------------------------------------
// FormGuideUI
// ---------------------------------------------------------------------------

/**
 * FormGuideUI manages the lifecycle of the pre-workout form guide panel.
 *
 * Usage:
 * ```ts
 * const guide = new FormGuide();
 * const ui    = new FormGuideUI(guide);
 * ui.mount(document.getElementById('guide-container')!);
 * ui.onReadyConfirmed(() => startWorkoutSet());
 * ui.showExercise('barbell_squat');
 * ```
 *
 * Requirements 7.1, 7.2, 7.3, 7.4
 */
export class FormGuideUI {
  private readonly guide: FormGuide;
  private containerEl: HTMLElement | null = null;
  private onReadyCallback: (() => void) | null = null;

  constructor(guide: FormGuide) {
    this.guide = guide;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Attach the UI to a host container element.  Must be called before
   * `showExercise`.
   */
  mount(containerEl: HTMLElement): void {
    this.containerEl = containerEl;
  }

  /**
   * Render the full form guide for the given exercise name into the mounted
   * container, including:
   *   - Step-by-step biomechanical instructions   (Requirement 7.1)
   *   - ≥1 correct-form media item               (Requirement 7.2)
   *   - ≥1 common-mistake media item             (Requirement 7.3)
   *   - An "I'm Ready" button                    (Requirement 7.4)
   *
   * If no guide exists for the exercise, a "Guide not available" notice is
   * rendered instead so the caller is never left with a blank panel.
   */
  showExercise(exerciseName: string): void {
    if (this.containerEl === null) {
      throw new Error(
        'FormGuideUI: call mount() before showExercise().',
      );
    }

    const exerciseGuide = this.guide.getGuide(exerciseName);

    // Clear any previous content
    this.containerEl.innerHTML = '';
    this.containerEl.setAttribute('aria-live', 'polite');

    if (exerciseGuide === null) {
      this.renderNotAvailable(this.containerEl, exerciseName);
      return;
    }

    this.renderGuide(this.containerEl, exerciseGuide);
  }

  /**
   * Register a callback that fires when the user clicks "I'm Ready".
   * Can be set before or after `showExercise`.
   *
   * Requirement 7.4
   */
  onReadyConfirmed(callback: () => void): void {
    this.onReadyCallback = callback;
  }

  /**
   * Hide the guide panel by clearing its contents and collapsing it.
   */
  hide(): void {
    if (this.containerEl === null) return;
    this.containerEl.innerHTML = '';
    this.containerEl.removeAttribute('aria-live');
  }

  // -------------------------------------------------------------------------
  // Private rendering helpers
  // -------------------------------------------------------------------------

  /**
   * Build and inject the full guide layout into `container`.
   */
  private renderGuide(container: HTMLElement, exerciseGuide: ExerciseGuide): void {
    const section = this.createElement('section', {
      className: 'form-guide',
      role: 'region',
      ariaLabel: `Form guide for ${exerciseGuide.exerciseName.replace(/_/g, ' ')}`,
    });

    // Heading
    const heading = this.createElement('h2', { className: 'form-guide__title' });
    heading.textContent = this.formatExerciseName(exerciseGuide.exerciseName);
    section.appendChild(heading);

    // Steps
    section.appendChild(this.renderSteps(exerciseGuide.steps));

    // Correct-form media (Requirement 7.2)
    const correctMedia = this.guide.getMedia(exerciseGuide.exerciseName, 'correct_form');
    if (correctMedia.length > 0) {
      section.appendChild(
        this.renderMediaGroup('Correct Form', 'form-guide__media--correct', correctMedia),
      );
    }

    // Common-mistake media (Requirement 7.3)
    const mistakeMedia = this.guide.getMedia(exerciseGuide.exerciseName, 'common_mistake');
    if (mistakeMedia.length > 0) {
      section.appendChild(
        this.renderMediaGroup(
          'Common Mistakes to Avoid',
          'form-guide__media--mistakes',
          mistakeMedia,
        ),
      );
    }

    // "I'm Ready" button (Requirement 7.4)
    section.appendChild(this.renderReadyButton());

    container.appendChild(section);
  }

  /**
   * Render the ordered list of biomechanical steps.
   *
   * Requirement 7.1
   */
  private renderSteps(steps: FormStep[]): HTMLElement {
    const wrapper = this.createElement('div', { className: 'form-guide__steps' });

    const heading = this.createElement('h3', { className: 'form-guide__steps-title' });
    heading.textContent = 'Step-by-Step Instructions';
    wrapper.appendChild(heading);

    const ol = document.createElement('ol');
    ol.className = 'form-guide__step-list';

    for (const step of steps) {
      const li = document.createElement('li');
      li.className = 'form-guide__step-item';
      li.setAttribute('data-step', String(step.stepNumber));

      const num = this.createElement('span', { className: 'form-guide__step-number' });
      num.textContent = `Step ${step.stepNumber}`;
      num.setAttribute('aria-hidden', 'true');

      const text = this.createElement('span', { className: 'form-guide__step-text' });
      text.textContent = step.instruction;

      li.appendChild(num);
      li.appendChild(text);
      ol.appendChild(li);
    }

    wrapper.appendChild(ol);
    return wrapper;
  }

  /**
   * Render a labelled group of media references (GIF or video link).
   *
   * Requirements 7.2, 7.3
   */
  private renderMediaGroup(
    groupTitle: string,
    groupClass: string,
    items: MediaReference[],
  ): HTMLElement {
    const wrapper = this.createElement('div', {
      className: `form-guide__media-group ${groupClass}`,
    });

    const heading = this.createElement('h3', { className: 'form-guide__media-title' });
    heading.textContent = groupTitle;
    wrapper.appendChild(heading);

    const list = this.createElement('ul', { className: 'form-guide__media-list' });
    list.setAttribute('role', 'list');

    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'form-guide__media-item';
      li.appendChild(this.renderMediaItem(item));
      list.appendChild(li);
    }

    wrapper.appendChild(list);
    return wrapper;
  }

  /**
   * Render a single `MediaReference` as either an `<img>` (GIF) or an
   * anchor `<a>` (video link), both with descriptive alt/aria text.
   */
  private renderMediaItem(item: MediaReference): HTMLElement {
    if (item.type === 'gif') {
      const img = document.createElement('img');
      img.className = 'form-guide__media-gif';
      img.src = item.url;
      img.alt = item.alt;
      img.loading = 'lazy';
      return img;
    }

    // type === 'video'
    const anchor = document.createElement('a');
    anchor.className = 'form-guide__media-video-link';
    anchor.href = item.url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.setAttribute('aria-label', `${item.alt} (opens in new tab)`);
    anchor.textContent = item.alt;
    return anchor;
  }

  /**
   * Render the "I'm Ready" confirmation button.
   *
   * Requirement 7.4
   */
  private renderReadyButton(): HTMLElement {
    const wrapper = this.createElement('div', { className: 'form-guide__ready-wrapper' });

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'form-guide__ready-btn';
    button.textContent = "I'm Ready";
    button.setAttribute('aria-label', "I'm ready — begin the workout set");

    button.addEventListener('click', () => {
      if (this.onReadyCallback !== null) {
        this.onReadyCallback();
      }
    });

    wrapper.appendChild(button);
    return wrapper;
  }

  /**
   * Render a notice when no guide is registered for the requested exercise.
   */
  private renderNotAvailable(container: HTMLElement, exerciseName: string): void {
    const notice = this.createElement('p', { className: 'form-guide__not-available' });
    notice.setAttribute('role', 'status');
    notice.textContent = `No form guide available for "${this.formatExerciseName(exerciseName)}".`;
    container.appendChild(notice);
  }

  // -------------------------------------------------------------------------
  // Utility helpers
  // -------------------------------------------------------------------------

  /**
   * Create an `HTMLElement` of the given tag and apply a flat set of
   * properties to it.  Only string-valued properties are applied; this
   * avoids the complexity of a full virtual-DOM diffing implementation.
   */
  private createElement(
    tag: string,
    props: Record<string, string>,
  ): HTMLElement {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'className') {
        el.className = value;
      } else if (key === 'role') {
        el.setAttribute('role', value);
      } else if (key === 'ariaLabel') {
        el.setAttribute('aria-label', value);
      } else {
        el.setAttribute(key, value);
      }
    }
    return el;
  }

  /**
   * Convert a snake_case exercise identifier to a human-readable title.
   * e.g. "barbell_squat" → "Barbell Squat"
   */
  private formatExerciseName(exerciseName: string): string {
    return exerciseName
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
