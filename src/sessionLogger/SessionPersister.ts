/**
 * SessionPersister — wires session end to Storage and AnalyticsEngine.
 *
 * After SessionLogger.endSession() produces a Session object, this controller:
 *   1. Persists the session via Storage.persist()
 *   2. Assembles a SessionSummary via AnalyticsEngine.assembleSessionSummary()
 *   3. Returns both for downstream consumers (Coaching_Advisor, UI, etc.)
 *
 * Requirements covered: 9.1, 9.2, 9.3, 8.5
 */

import { Storage } from '../storage/Storage.js';
import { AnalyticsEngine } from '../analyticsEngine/AnalyticsEngine.js';
import type { Session, SessionSummary } from '../types/index.js';

export interface SessionPersistResult {
  session: Session;
  summary: SessionSummary;
}

export class SessionPersister {
  private storage: Storage;
  private analyticsEngine: AnalyticsEngine;

  constructor(storage: Storage, analyticsEngine: AnalyticsEngine) {
    this.storage = storage;
    this.analyticsEngine = analyticsEngine;
  }

  /**
   * Persist a completed session and produce its analytics summary.
   *
   * 1. Calls Storage.persist(session) to save to IndexedDB.
   * 2. Calls AnalyticsEngine.assembleSessionSummary(session) to produce the summary.
   *
   * Requirements 9.1, 9.2, 9.3 — persist resolves within 2s timeout.
   * Requirement 8.5 — SessionSummary assembled for downstream dispatch.
   */
  async persistAndAnalyze(session: Session): Promise<SessionPersistResult> {
    // 1. Persist to Storage (IndexedDB)
    await this.storage.persist(session);

    // 2. Assemble summary via AnalyticsEngine
    const summary = this.analyticsEngine.assembleSessionSummary(session);

    return { session, summary };
  }
}
