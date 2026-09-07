/**
 * AccountUI — dialogs for the server-backed account (register / login / forgot /
 * reset) and encrypted cloud sync. Kept visually consistent with PrivacyUI.
 *
 * Two-secrets model made explicit in the UI: the account password logs you into
 * the server; your vault passphrase (handled by PrivacyUI) decrypts your data.
 * The server never sees the passphrase.
 */

import { AuthClient } from './AuthClient.js';
import { SyncClient } from './SyncClient.js';
import { PrivacyManager } from '../privacy/PrivacyManager.js';
import type { PrivacyUI } from '../privacy/PrivacyUI.js';

export class AccountUI {
  readonly auth = new AuthClient();
  readonly sync = new SyncClient(this.auth);
  private privacy = PrivacyManager.getInstance();

  constructor(private privacyUI: PrivacyUI) {}

  isLoggedIn(): boolean { return this.auth.isLoggedIn(); }
  /** Account identity label — the email. */
  username(): string | null { return this.auth.currentUser()?.email ?? this.auth.currentUser()?.username ?? null; }

  /** Run the correct dialog for current state: Log In / Register when logged out. */
  async promptAccount(): Promise<void> {
    if (this.auth.isLoggedIn()) {
      await this.showAccountMenu();
    } else {
      await this.showLoginDialog();
    }
  }

  /** Handle ?verify= / ?reset= links opened from the dev email console. */
  async handleUrlTokens(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const verify = params.get('verify');
    const reset = params.get('reset');
    if (verify) {
      const r = await this.auth.verifyEmail(verify);
      alert(r.ok ? 'Email verified! You can now log in.' : `Verification failed: ${r.error}`);
      this.clearUrlParams();
    } else if (reset) {
      await this.showResetDialog(reset);
      this.clearUrlParams();
    }
  }

  private clearUrlParams(): void {
    history.replaceState(null, '', location.pathname);
  }

  // --- Login ---

  private showLoginDialog(): Promise<void> {
    return new Promise((resolve) => {
      const { overlay, panel } = this.modal('🔑 Log In to Your Account');

      const info = this.p('Log in to sync your encrypted data across devices. Your account password is separate from your vault passphrase — the server never sees your passphrase.');
      panel.appendChild(info);

      const id = this.input('email', 'Email');
      const pw = this.input('password', 'Password');
      panel.append(id, pw);
      const err = this.err();
      panel.appendChild(err);

      const links = document.createElement('div');
      links.style.cssText = 'display:flex; justify-content:space-between; margin:2px 0 10px;';
      const forgot = this.link('Forgot password?');
      forgot.onclick = async () => { overlay.remove(); await this.showForgotDialog(); resolve(); };
      const reg = this.link('Create an account');
      reg.onclick = async () => { overlay.remove(); await this.showRegisterDialog(); resolve(); };
      links.append(forgot, reg);
      panel.appendChild(links);

      const row = this.row();
      const cancel = this.btn('Cancel', 'ghost');
      const login = this.btn('Log In', 'primary');
      cancel.onclick = () => { overlay.remove(); resolve(); };
      const attempt = async () => {
        login.disabled = true; login.textContent = 'Logging in…';
        const r = await this.auth.login(id.value.trim(), pw.value);
        if (!r.ok) { err.textContent = r.error ?? 'Login failed.'; login.disabled = false; login.textContent = 'Log In'; return; }
        overlay.remove();
        await this.afterLogin();
        resolve();
      };
      login.onclick = attempt;
      pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
      row.append(cancel, login);
      panel.appendChild(row);
      setTimeout(() => id.focus(), 50);
    });
  }

  // --- Register ---

  private showRegisterDialog(): Promise<void> {
    return new Promise((resolve) => {
      const { overlay, panel } = this.modal('✍ Create an Account');
      panel.appendChild(this.p('Create a server account for encrypted cloud sync. Your email is your login. The server stores only unreadable ciphertext — your email is the only personal data it holds.'));

      const em = this.input('email', 'Email (this is your login)');
      const pw = this.input('password', 'Password (min 8 characters)');
      panel.append(em, pw);
      const err = this.err();
      panel.appendChild(err);

      const row = this.row();
      const cancel = this.btn('Cancel', 'ghost');
      const create = this.btn('Register', 'primary');
      cancel.onclick = () => { overlay.remove(); resolve(); };
      create.onclick = async () => {
        create.disabled = true; create.textContent = 'Creating…';
        const r = await this.auth.register(em.value.trim(), pw.value);
        if (!r.ok) { err.textContent = r.error ?? 'Registration failed.'; create.disabled = false; create.textContent = 'Register'; return; }
        overlay.remove();
        alert('Account created! In dev mode, the verification link is printed to the server console. You can log in now.');
        await this.showLoginDialog();
        resolve();
      };
      row.append(cancel, create);
      panel.appendChild(row);
      setTimeout(() => em.focus(), 50);
    });
  }

  // --- Forgot / Reset ---

  private showForgotDialog(): Promise<void> {
    return new Promise((resolve) => {
      const { overlay, panel } = this.modal('📧 Reset Your Password');
      panel.appendChild(this.p('Enter your email. If it is registered, a reset link will be sent (dev mode: printed to the server console). This resets your account password only — it cannot decrypt your data.'));
      const em = this.input('email', 'Email');
      panel.appendChild(em);
      const err = this.err();
      panel.appendChild(err);
      const row = this.row();
      const cancel = this.btn('Cancel', 'ghost');
      const send = this.btn('Send Reset Link', 'primary');
      cancel.onclick = () => { overlay.remove(); resolve(); };
      send.onclick = async () => {
        send.disabled = true; send.textContent = 'Sending…';
        await this.auth.forgotPassword(em.value.trim());
        overlay.remove();
        alert('If that email is registered, a reset link has been sent. In dev mode, check the server console.');
        resolve();
      };
      row.append(cancel, send);
      panel.appendChild(row);
      setTimeout(() => em.focus(), 50);
    });
  }

  private showResetDialog(token: string): Promise<void> {
    return new Promise((resolve) => {
      const { overlay, panel } = this.modal('🔑 Set a New Password');
      panel.appendChild(this.p('Enter a new account password. Your encrypted data stays intact and still requires your vault passphrase to decrypt.'));
      const pw1 = this.input('password', 'New password (min 8)');
      const pw2 = this.input('password', 'Confirm new password');
      panel.append(pw1, pw2);
      const err = this.err();
      panel.appendChild(err);
      const row = this.row();
      const save = this.btn('Set Password', 'primary');
      save.onclick = async () => {
        if (pw1.value.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
        if (pw1.value !== pw2.value) { err.textContent = 'Passwords do not match.'; return; }
        save.disabled = true; save.textContent = 'Saving…';
        const r = await this.auth.resetPassword(token, pw1.value);
        if (!r.ok) { err.textContent = r.error ?? 'Reset failed.'; save.disabled = false; save.textContent = 'Set Password'; return; }
        overlay.remove();
        alert('Password reset! You can now log in with your new password.');
        await this.showLoginDialog();
        resolve();
      };
      row.appendChild(save);
      panel.appendChild(row);
      setTimeout(() => pw1.focus(), 50);
    });
  }

  // --- Logged-in menu (sync / logout / delete) ---

  private showAccountMenu(): Promise<void> {
    return new Promise((resolve) => {
      const { overlay, panel } = this.modal(`👤 ${this.auth.currentUser()?.username ?? 'Account'}`);
      const u = this.auth.currentUser();
      panel.appendChild(this.p(`Logged in as ${u?.email}. Your data syncs as encrypted ciphertext the server cannot read.`));

      const status = document.createElement('div');
      status.style.cssText = 'font-size:0.76rem; color:var(--text-faint); margin-bottom:10px;';
      panel.appendChild(status);

      const col = document.createElement('div');
      col.style.cssText = 'display:flex; flex-direction:column; gap:8px;';

      const syncUp = this.btn('☁ Sync Up (encrypt & upload)', 'primary');
      syncUp.onclick = async () => {
        if (!this.privacy.isUnlocked()) {
          const ok = await this.privacyUI.promptAuth();
          void ok;
          if (!this.privacy.isUnlocked()) { status.textContent = 'Unlock your vault first.'; return; }
        }
        syncUp.disabled = true; status.textContent = 'Encrypting & uploading…';
        try {
          const blob = await this.privacy.buildSyncBlob();
          const ks = this.privacy.exportKeyStore() ?? '';
          const r = await this.sync.push(blob, ks);
          status.textContent = r.ok ? '✓ Uploaded (encrypted).' : `Upload failed: ${r.error}`;
        } catch {
          status.textContent = 'Could not build the encrypted blob.';
        }
        syncUp.disabled = false;
      };

      const syncDown = this.btn('⬇ Sync Down (download & decrypt)', 'ghost');
      syncDown.onclick = async () => {
        syncDown.disabled = true; status.textContent = 'Downloading…';
        const r = await this.sync.pull();
        if (!r.ok || !r.data) { status.textContent = `Download failed: ${r.error}`; syncDown.disabled = false; return; }
        if (!r.data.blob || !r.data.keyStore) { status.textContent = 'Nothing synced yet.'; syncDown.disabled = false; return; }
        // Install wrapped-key metadata so this device can unlock the vault.
        this.privacy.importKeyStore(r.data.keyStore);
        if (!this.privacy.isUnlocked()) {
          await this.privacyUI.promptAuth();
          if (!this.privacy.isUnlocked()) { status.textContent = 'Unlock your vault to decrypt the data.'; syncDown.disabled = false; return; }
        }
        try {
          const n = await this.privacy.applySyncBlob(r.data.blob);
          status.textContent = `✓ Restored ${n} scans (decrypted locally).`;
        } catch {
          status.textContent = 'Decryption failed — wrong passphrase for this data.';
        }
        syncDown.disabled = false;
      };

      const logout = this.btn('🚪 Log Out of Account', 'ghost');
      logout.onclick = async () => { await this.auth.logout(); overlay.remove(); resolve(); };

      const del = this.btn('🗑 Delete Server Account', 'danger');
      del.onclick = async () => {
        if (!confirm('Delete your server account and all synced ciphertext? Local data stays on this device. This cannot be undone.')) return;
        const r = await this.sync.deleteAccount();
        if (r.ok) { await this.auth.logout(); overlay.remove(); alert('Server account deleted. Your local data is untouched.'); resolve(); }
        else status.textContent = `Delete failed: ${r.error}`;
      };

      col.append(syncUp, syncDown, logout, del);
      panel.appendChild(col);

      const close = this.btn('Close', 'ghost');
      close.style.marginTop = '12px';
      close.onclick = () => { overlay.remove(); resolve(); };
      panel.appendChild(close);
    });
  }

  private async afterLogin(): Promise<void> {
    // Offer to pull existing data right after login.
    const r = await this.sync.pull();
    if (r.ok && r.data?.blob && r.data.keyStore) {
      this.privacy.importKeyStore(r.data.keyStore);
      alert('Logged in. You have synced data — open the account menu and choose "Sync Down" after unlocking your vault to restore it on this device.');
    } else {
      alert('Logged in. Use the account menu to sync your encrypted data up.');
    }
  }

  // --- tiny DOM helpers (match PrivacyUI styling) ---

  private modal(titleText: string): { overlay: HTMLElement; panel: HTMLElement } {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); backdrop-filter:blur(3px); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const panel = document.createElement('div');
    panel.style.cssText = 'background:var(--bg-1,#1a1a1a); border:1px solid var(--border,#333); border-radius:14px; padding:22px; max-width:460px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.5);';
    const title = document.createElement('h3');
    title.textContent = titleText;
    title.style.cssText = 'margin:0 0 14px; font-size:1.05rem; color:var(--text,#fff);';
    panel.appendChild(title);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    return { overlay, panel };
  }

  private p(text: string): HTMLElement {
    const el = document.createElement('p');
    el.style.cssText = 'font-size:0.8rem; color:var(--text-muted); line-height:1.5; margin:0 0 12px;';
    el.textContent = text;
    return el;
  }

  private input(type: string, placeholder: string): HTMLInputElement {
    const i = document.createElement('input');
    i.type = type;
    i.placeholder = placeholder;
    i.autocomplete = type === 'password' ? 'current-password' : 'off';
    i.style.cssText = 'width:100%; box-sizing:border-box; padding:10px 12px; margin-bottom:8px; border-radius:8px; border:1px solid var(--border,#333); background:var(--bg-2,#242424); color:var(--text,#fff); font-size:0.85rem;';
    return i;
  }

  private err(): HTMLElement {
    const e = document.createElement('div');
    e.style.cssText = 'font-size:0.76rem; color:var(--danger,#e5484d); min-height:1.1em;';
    return e;
  }

  private link(text: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = 'background:none; border:none; color:var(--accent,#00d4a0); font-size:0.76rem; cursor:pointer; padding:0;';
    return b;
  }

  private row(): HTMLElement {
    const r = document.createElement('div');
    r.style.cssText = 'display:flex; gap:10px; justify-content:flex-end; margin-top:12px;';
    return r;
  }

  private btn(label: string, kind: 'primary' | 'ghost' | 'danger'): HTMLButtonElement {
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
}
