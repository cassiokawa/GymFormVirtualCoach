/**
 * PrivacyUI — modal dialogs and settings panel for the GDPR/LGPD privacy layer.
 *
 * Renders:
 *  - A consent + privacy-notice modal (first time sensitive data is stored).
 *  - A passphrase dialog (set on first use, unlock afterwards).
 *  - A privacy settings panel (export data, erase all, lock vault).
 *
 * Pure DOM, no framework. All actions delegate to PrivacyManager.
 */

import { PrivacyManager, PRIVACY_NOTICE_VERSION } from './PrivacyManager.js';

const PRIVACY_NOTICE = `Your data stays on this device.

This app runs entirely in your browser. Your body measurements, weight, workout
history, and everything else are stored locally on this machine and are never
uploaded anywhere unless you explicitly turn on cloud sync. There is no tracking.

Optional cloud sync (off by default):
  If you create an account and enable sync, your data is encrypted on this
  device FIRST, then uploaded. The server stores only unreadable ciphertext and
  can never see your measurements, weight, or passphrase. Your email is the only
  personal data the server holds, used solely for account recovery.

What we store (only with your consent):
  • Body-scan measurements (normalized proportions)
  • Optional body weight you enter at scan time
  • Workout history and preferences

How it is protected:
  • Sensitive body/weight data is encrypted at rest with AES-256 using a
    passphrase that only you know. The passphrase is never stored anywhere.
  • Without your passphrase, the encrypted data cannot be read — not by this
    app, not by anyone with access to your browser storage.

Your rights (GDPR / LGPD):
  • Access & portability: export all your data as a JSON file at any time.
  • Erasure: permanently delete everything from this device at any time.
  • Withdraw consent: stop storing sensitive data going forward.

Because the passphrase is never stored, if you forget it your encrypted data
cannot be recovered. Keep it safe.`;

export class PrivacyUI {
  private manager = PrivacyManager.getInstance();

  /**
   * Ensure the user has consented and the vault is unlocked before storing
   * sensitive data. Resolves true if ready to store, false if the user
   * declined or cancelled. Shows the necessary dialogs in sequence.
   */
  async ensureReadyToStore(): Promise<boolean> {
    // 1) Consent gate.
    if (!this.manager.hasConsent()) {
      const agreed = await this.showConsentModal();
      if (!agreed) return false;
      this.manager.grantConsent();
    }
    // 2) Vault gate.
    if (!this.manager.isUnlocked()) {
      const unlocked = this.manager.isVaultInitialized()
        ? await this.showUnlockDialog()
        : await this.showCreateVaultDialog();
      if (!unlocked) return false;
    }
    return true;
  }

  /**
   * Public entry point for a navbar/auth button. Runs the correct dialog for
   * the current state: Sign Up (no account) → Log In (account, locked) →
   * Log Out (unlocked). Returns after the action completes.
   */
  async promptAuth(): Promise<void> {
    if (!this.manager.hasAccount()) {
      // First-time sign up also needs consent for storing sensitive data.
      if (!this.manager.hasConsent()) {
        const agreed = await this.showConsentModal();
        if (!agreed) return;
        this.manager.grantConsent();
      }
      await this.showCreateVaultDialog();
      return;
    }
    if (!this.manager.isUnlocked()) {
      await this.showUnlockDialog();
      return;
    }
    // Already logged in → log out.
    this.manager.lock();
  }

  /** Current auth state for rendering a button label/indicator. */
  authState(): 'signup' | 'login' | 'logout' {
    if (!this.manager.hasAccount()) return 'signup';
    return this.manager.isUnlocked() ? 'logout' : 'login';
  }

  // --- Consent modal ---

  private showConsentModal(): Promise<boolean> {
    return new Promise((resolve) => {
      const { overlay, panel } = this.makeModal('🔒 Privacy & Consent');

      const notice = document.createElement('pre');
      notice.textContent = PRIVACY_NOTICE;
      notice.style.cssText =
        'white-space:pre-wrap; font-size:0.78rem; line-height:1.5; color:var(--text-muted); background:var(--bg-2); padding:14px; border-radius:8px; max-height:40vh; overflow-y:auto; margin:0 0 14px; font-family:inherit;';
      panel.appendChild(notice);

      const ver = document.createElement('div');
      ver.style.cssText = 'font-size:0.68rem; color:var(--text-faint); margin-bottom:12px;';
      ver.textContent = `Privacy notice v${PRIVACY_NOTICE_VERSION}`;
      panel.appendChild(ver);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:10px; justify-content:flex-end;';
      const decline = this.button('Decline', 'ghost');
      const agree = this.button('I Agree — Enable Secure Storage', 'primary');
      decline.onclick = () => { overlay.remove(); resolve(false); };
      agree.onclick = () => { overlay.remove(); resolve(true); };
      row.append(decline, agree);
      panel.appendChild(row);
    });
  }

  // --- Sign up (create account + set passphrase) dialog ---

  private showCreateVaultDialog(): Promise<boolean> {
    return new Promise((resolve) => {
      const { overlay, panel } = this.makeModal('🔑 Sign Up — Secure Your Data');

      const info = document.createElement('p');
      info.style.cssText = 'font-size:0.8rem; color:var(--text-muted); line-height:1.5; margin:0 0 12px;';
      info.textContent =
        'Choose a passphrase to encrypt your body measurements and weight. There is no account server — this creates a private, encrypted vault on this device only.';
      panel.appendChild(info);

      const p1 = this.passwordInput('Passphrase (min 8 characters)');
      const p2 = this.passwordInput('Confirm passphrase');
      panel.append(p1, p2);

      const err = this.errorLine();
      panel.appendChild(err);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:10px; justify-content:flex-end; margin-top:12px;';
      const cancel = this.button('Cancel', 'ghost');
      const save = this.button('Sign Up', 'primary');
      cancel.onclick = () => { overlay.remove(); resolve(false); };
      save.onclick = async () => {
        if (p1.value.length < 8) { err.textContent = 'Passphrase must be at least 8 characters.'; return; }
        if (p1.value !== p2.value) { err.textContent = 'Passphrases do not match.'; return; }
        save.disabled = true; save.textContent = 'Encrypting…';
        try {
          const recoveryCode = await this.manager.createVault(p1.value);
          overlay.remove();
          // Show the one-time recovery code, then finish.
          await this.showRecoveryCodeModal(recoveryCode);
          resolve(true);
        } catch {
          err.textContent = 'Could not create the vault. Try again.';
          save.disabled = false; save.textContent = 'Sign Up';
        }
      };
      row.append(cancel, save);
      panel.appendChild(row);
      setTimeout(() => p1.focus(), 50);
    });
  }

  /** Show the one-time recovery code and require the user to confirm they saved it. */
  private showRecoveryCodeModal(code: string): Promise<void> {
    return new Promise((resolve) => {
      const { overlay, panel } = this.makeModal('🆘 Save Your Recovery Code');

      const info = document.createElement('p');
      info.style.cssText = 'font-size:0.8rem; color:var(--text-muted); line-height:1.5; margin:0 0 12px;';
      info.textContent =
        'This is the ONLY way to recover your data if you forget your passphrase. Save it somewhere safe (a password manager). It will not be shown again, and it cannot be regenerated.';
      panel.appendChild(info);

      const codeBox = document.createElement('div');
      codeBox.textContent = code;
      codeBox.style.cssText =
        'font-family:monospace; font-size:1.25rem; letter-spacing:0.12em; font-weight:700; text-align:center; padding:16px; margin-bottom:12px; background:var(--bg-2,#242424); border:1px dashed var(--accent,#00d4a0); border-radius:10px; color:var(--text,#fff); user-select:all;';
      panel.appendChild(codeBox);

      const copyBtn = this.button('📋 Copy code', 'ghost');
      copyBtn.style.cssText += 'width:100%; margin-bottom:12px;';
      copyBtn.onclick = () => {
        void navigator.clipboard?.writeText(code).then(() => { copyBtn.textContent = '✓ Copied'; });
      };
      panel.appendChild(copyBtn);

      const ackWrap = document.createElement('label');
      ackWrap.style.cssText = 'display:flex; gap:8px; align-items:flex-start; font-size:0.78rem; color:var(--text-muted); margin-bottom:12px; cursor:pointer;';
      const ack = document.createElement('input');
      ack.type = 'checkbox';
      const ackText = document.createElement('span');
      ackText.textContent = 'I have saved my recovery code somewhere safe.';
      ackWrap.append(ack, ackText);
      panel.appendChild(ackWrap);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex; justify-content:flex-end;';
      const done = this.button('Continue', 'primary');
      done.disabled = true;
      ack.addEventListener('change', () => { done.disabled = !ack.checked; });
      done.onclick = () => { overlay.remove(); resolve(); };
      row.appendChild(done);
      panel.appendChild(row);
    });
  }

  // --- Log in (unlock) dialog ---

  private showUnlockDialog(): Promise<boolean> {
    return new Promise((resolve) => {
      const { overlay, panel } = this.makeModal('🔓 Log In');

      const info = document.createElement('p');
      info.style.cssText = 'font-size:0.8rem; color:var(--text-muted); line-height:1.5; margin:0 0 12px;';
      info.textContent = 'Enter your passphrase to unlock your encrypted body measurements.';
      panel.appendChild(info);

      const p1 = this.passwordInput('Passphrase');
      panel.appendChild(p1);

      const err = this.errorLine();
      panel.appendChild(err);

      // Forgot-passphrase link -> recovery-code flow.
      const forgot = document.createElement('button');
      forgot.type = 'button';
      forgot.textContent = 'Forgot passphrase? Use recovery code';
      forgot.style.cssText = 'background:none; border:none; color:var(--accent,#00d4a0); font-size:0.76rem; cursor:pointer; padding:0; margin-bottom:6px; text-align:left;';
      forgot.onclick = async () => {
        overlay.remove();
        const ok = await this.showRecoveryDialog();
        resolve(ok);
      };
      panel.appendChild(forgot);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:10px; justify-content:flex-end; margin-top:12px;';
      const cancel = this.button('Cancel', 'ghost');
      const unlock = this.button('Log In', 'primary');
      cancel.onclick = () => { overlay.remove(); resolve(false); };
      const attempt = async () => {
        unlock.disabled = true; unlock.textContent = 'Logging in…';
        const ok = await this.manager.unlockVault(p1.value);
        if (ok) { overlay.remove(); resolve(true); }
        else {
          err.textContent = 'Incorrect passphrase.';
          unlock.disabled = false; unlock.textContent = 'Log In';
          p1.select();
        }
      };
      unlock.onclick = attempt;
      p1.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
      row.append(cancel, unlock);
      panel.appendChild(row);
      setTimeout(() => p1.focus(), 50);
    });
  }

  // --- Recover with recovery code, then set a new passphrase ---

  private showRecoveryDialog(): Promise<boolean> {
    return new Promise((resolve) => {
      const { overlay, panel } = this.makeModal('🆘 Recover Access');

      const info = document.createElement('p');
      info.style.cssText = 'font-size:0.8rem; color:var(--text-muted); line-height:1.5; margin:0 0 12px;';
      info.textContent = 'Enter the recovery code you saved when you signed up. You will then set a new passphrase.';
      panel.appendChild(info);

      const codeInput = document.createElement('input');
      codeInput.type = 'text';
      codeInput.placeholder = 'XXXX-XXXX-XXXX-XXXX';
      codeInput.autocomplete = 'off';
      codeInput.style.cssText =
        'width:100%; box-sizing:border-box; padding:10px 12px; margin-bottom:8px; border-radius:8px; border:1px solid var(--border,#333); background:var(--bg-2,#242424); color:var(--text,#fff); font-size:0.9rem; font-family:monospace; letter-spacing:0.06em;';
      panel.appendChild(codeInput);

      const err = this.errorLine();
      panel.appendChild(err);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:10px; justify-content:flex-end; margin-top:12px;';
      const cancel = this.button('Cancel', 'ghost');
      const next = this.button('Recover', 'primary');
      cancel.onclick = () => { overlay.remove(); resolve(false); };
      next.onclick = async () => {
        next.disabled = true; next.textContent = 'Checking…';
        const ok = await this.manager.recoverWithCode(codeInput.value);
        if (!ok) {
          err.textContent = 'That recovery code is not valid.';
          next.disabled = false; next.textContent = 'Recover';
          codeInput.select();
          return;
        }
        overlay.remove();
        // Vault is now unlocked via recovery code — force a new passphrase.
        const changed = await this.showChangePassphraseDialog(true);
        resolve(changed);
      };
      panel.appendChild(row);
      row.append(cancel, next);
      setTimeout(() => codeInput.focus(), 50);
    });
  }

  /**
   * Change/set the passphrase. Vault must be unlocked. When `mandatory` is true
   * (post-recovery), there is no cancel button.
   */
  showChangePassphraseDialog(mandatory = false): Promise<boolean> {
    return new Promise((resolve) => {
      const { overlay, panel } = this.makeModal(mandatory ? '🔑 Set a New Passphrase' : '🔑 Change Passphrase');

      const info = document.createElement('p');
      info.style.cssText = 'font-size:0.8rem; color:var(--text-muted); line-height:1.5; margin:0 0 12px;';
      info.textContent = mandatory
        ? 'Recovery successful. Set a new passphrase to secure your data going forward. Your recovery code stays the same.'
        : 'Set a new passphrase. Your data is not re-encrypted and your recovery code is unchanged.';
      panel.appendChild(info);

      const p1 = this.passwordInput('New passphrase (min 8 characters)');
      const p2 = this.passwordInput('Confirm new passphrase');
      panel.append(p1, p2);

      const err = this.errorLine();
      panel.appendChild(err);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:10px; justify-content:flex-end; margin-top:12px;';
      const save = this.button('Save Passphrase', 'primary');
      if (!mandatory) {
        const cancel = this.button('Cancel', 'ghost');
        cancel.onclick = () => { overlay.remove(); resolve(false); };
        row.appendChild(cancel);
      }
      save.onclick = async () => {
        if (p1.value.length < 8) { err.textContent = 'Passphrase must be at least 8 characters.'; return; }
        if (p1.value !== p2.value) { err.textContent = 'Passphrases do not match.'; return; }
        save.disabled = true; save.textContent = 'Saving…';
        const ok = await this.manager.changePassphrase(p1.value);
        if (ok) { overlay.remove(); resolve(true); }
        else {
          err.textContent = 'Could not change the passphrase. Try again.';
          save.disabled = false; save.textContent = 'Save Passphrase';
        }
      };
      row.appendChild(save);
      panel.appendChild(row);
      setTimeout(() => p1.focus(), 50);
    });
  }

  // --- Settings panel (export / erase / lock) ---

  /** Build a standalone privacy settings section for embedding in a panel. */
  buildSettingsSection(onChange?: () => void): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; flex-direction:column; gap:10px;';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-faint);';
    title.textContent = 'Privacy & Data';
    wrap.appendChild(title);

    const status = document.createElement('div');
    status.style.cssText = 'font-size:0.78rem; color:var(--text-muted); line-height:1.5;';
    const refreshStatus = () => {
      const consent = this.manager.hasConsent();
      const vault = this.manager.isVaultInitialized();
      const unlocked = this.manager.isUnlocked();
      const acct = !vault ? 'no account yet' : unlocked ? 'logged in' : 'logged out';
      status.innerHTML =
        `Storage: <strong>this device only</strong> · encrypted at rest<br>` +
        `Consent: <strong>${consent ? 'granted' : 'not given'}</strong> · ` +
        `Account: <strong>${acct}</strong>`;
    };
    refreshStatus();
    wrap.appendChild(status);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap;';

    // Rebuild the auth button to reflect current state (sign up / log in / log out).
    const buildAuthButton = () => {
      const hasAccount = this.manager.hasAccount();
      const unlocked = this.manager.isUnlocked();
      if (!hasAccount) {
        const b = this.button('✍ Sign Up', 'primary');
        b.onclick = async () => { await this.showCreateVaultDialog(); refreshStatus(); rebuild(); onChange?.(); };
        return b;
      }
      if (!unlocked) {
        const b = this.button('🔓 Log In', 'primary');
        b.onclick = async () => { await this.showUnlockDialog(); refreshStatus(); rebuild(); onChange?.(); };
        return b;
      }
      const b = this.button('🚪 Log Out', 'ghost');
      b.onclick = () => { this.manager.lock(); refreshStatus(); rebuild(); onChange?.(); };
      return b;
    };

    let authBtn = buildAuthButton();

    const changeBtn = this.button('🔑 Change Passphrase', 'ghost');
    changeBtn.onclick = async () => {
      if (!this.manager.isUnlocked()) { await this.showUnlockDialog(); }
      if (this.manager.isUnlocked()) await this.showChangePassphraseDialog(false);
      refreshStatus();
    };

    const exportBtn = this.button('⬇ Export My Data', 'ghost');
    exportBtn.onclick = async () => {
      if (this.manager.isVaultInitialized() && !this.manager.isUnlocked()) {
        await this.showUnlockDialog();
        rebuild();
      }
      await this.manager.downloadExport();
    };

    const eraseBtn = this.button('🗑 Erase All Data', 'danger');
    eraseBtn.onclick = async () => {
      const ok = confirm(
        'This permanently deletes ALL your data from this device — body scans, weight, ' +
        'workout history, and preferences. This cannot be undone. Continue?',
      );
      if (!ok) return;
      const ok2 = confirm('Are you absolutely sure? There is no recovery.');
      if (!ok2) return;
      await this.manager.eraseAll();
      refreshStatus();
      rebuild();
      onChange?.();
      alert('All local data has been erased.');
    };

    // Re-render the auth button in place when state changes.
    const rebuild = () => {
      const fresh = buildAuthButton();
      row.replaceChild(fresh, authBtn);
      authBtn = fresh;
      changeBtn.style.display = this.manager.hasAccount() ? '' : 'none';
    };

    row.append(authBtn, changeBtn, exportBtn, eraseBtn);
    changeBtn.style.display = this.manager.hasAccount() ? '' : 'none';
    wrap.appendChild(row);
    return wrap;
  }

  // --- small DOM helpers ---

  private makeModal(titleText: string): { overlay: HTMLElement; panel: HTMLElement } {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed; inset:0; background:rgba(0,0,0,0.6); backdrop-filter:blur(3px); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const panel = document.createElement('div');
    panel.style.cssText =
      'background:var(--bg-1,#1a1a1a); border:1px solid var(--border,#333); border-radius:14px; padding:22px; max-width:520px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.5);';
    const title = document.createElement('h3');
    title.textContent = titleText;
    title.style.cssText = 'margin:0 0 14px; font-size:1.05rem; color:var(--text,#fff);';
    panel.appendChild(title);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    return { overlay, panel };
  }

  private button(label: string, kind: 'primary' | 'ghost' | 'danger'): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    const base = 'padding:9px 14px; border-radius:8px; font-size:0.82rem; font-weight:600; cursor:pointer; border:1px solid transparent;';
    const styles: Record<string, string> = {
      primary: 'background:var(--accent,#00d4a0); color:#04241c;',
      ghost: 'background:var(--bg-2,#242424); color:var(--text,#fff); border-color:var(--border,#333);',
      danger: 'background:var(--danger,#e5484d); color:#fff;',
    };
    b.style.cssText = base + styles[kind];
    return b;
  }

  private passwordInput(placeholder: string): HTMLInputElement {
    const i = document.createElement('input');
    i.type = 'password';
    i.placeholder = placeholder;
    i.autocomplete = 'new-password';
    i.style.cssText =
      'width:100%; box-sizing:border-box; padding:10px 12px; margin-bottom:8px; border-radius:8px; border:1px solid var(--border,#333); background:var(--bg-2,#242424); color:var(--text,#fff); font-size:0.85rem;';
    return i;
  }

  private errorLine(): HTMLElement {
    const e = document.createElement('div');
    e.style.cssText = 'font-size:0.76rem; color:var(--danger,#e5484d); min-height:1.1em;';
    return e;
  }
}
