# Requirements Document

## Introduction

This feature adds a hybrid zero-knowledge authentication and cloud sync capability to the CV Fitness / Form Assistant, which is otherwise a fully client-side TypeScript/Vite application. The user wants "a proper user with username and password with email recovery" while preserving the previously required guarantee that "only the user should have access to its own data."

The chosen design (Option C, confirmed with the user) is a **hybrid zero-knowledge** model built on a **two-secrets** principle:

- The **Account Password** authenticates the user against the server (Node + Express + SQLite). It is used only for identity and session management.
- The **Encryption Passphrase** decrypts the user's private vault data. It is derived and used entirely client-side (via the existing `PrivacyVault` master key) and is **never transmitted to the server**.

Because the two secrets are separate, the server can authenticate a user and store their data without ever being able to read it. The server holds only an opaque, client-side-encrypted blob (AES-GCM). Resetting the Account Password (via emailed token) restores server access but grants **no** ability to decrypt vault data; that remains gated by the Encryption Passphrase or the existing recovery code.

Email delivery runs in **dev mode** initially: the full verification and reset token flow is implemented, but links are written to the server console instead of sent through a real provider. The email transport is designed to be swappable to a real SMTP/API provider later without changing the surrounding flow.

The existing local vault (`PrivacyVault` master key wrapped by passphrase + recovery code) is preserved unchanged; sync layers on top of it. Vault unlock (Encryption Passphrase) remains independent from account login (Account Password).

## Glossary

- **Client**: The browser-side TypeScript application (Vite), including the existing privacy layer.
- **Sync_Server**: The Node + Express + SQLite backend added by this feature.
- **Account_Password**: The credential used to authenticate a user with the Sync_Server. Never used to decrypt vault data.
- **Encryption_Passphrase**: The client-side secret that unlocks the PrivacyVault master key. Never sent to the Sync_Server.
- **Recovery_Code**: The one-time code generated at vault creation that can independently unwrap the PrivacyVault master key (existing behavior).
- **PrivacyVault**: The existing client-side component that holds the in-memory AES-GCM master key and encrypts/decrypts JSON payloads.
- **Master_Key**: The random 256-bit AES-GCM key that encrypts all sensitive user data; held only in memory when unlocked, never persisted in plaintext.
- **Encrypted_Blob**: An opaque, client-side-encrypted (AES-GCM) payload containing the user's sensitive data (body scans, weight, workout data). The Sync_Server stores this without any ability to decrypt it.
- **Session_Token**: A JWT issued by the Sync_Server on successful login, used to authenticate subsequent API requests.
- **Verification_Token**: A secure random token with an expiry, used to confirm ownership of an email address.
- **Reset_Token**: A secure random token with an expiry, used to reset the Account_Password.
- **Email_Transport**: The swappable component responsible for delivering email. In dev mode it writes links to the server console.
- **Data_Subject_Rights**: GDPR/LGPD rights of access, portability, and erasure exercised by the user.
- **PII**: Personally Identifiable Information. The only new PII the Sync_Server processes is the user's email address.

## Requirements

### Requirement 1: Account Registration

**User Story:** As a user, I want to register an account with a username, email, and password, so that I can access sync features across devices.

#### Acceptance Criteria

1. WHEN a registration request is received with a username, an email, and an Account_Password, THE Sync_Server SHALL create a new account record and store the Account_Password only as a salted hash produced by Argon2 or scrypt.
2. IF a registration request contains a username that already exists, THEN THE Sync_Server SHALL reject the request with a conflict error and SHALL NOT create an account.
3. IF a registration request contains an email that already exists, THEN THE Sync_Server SHALL reject the request with a conflict error and SHALL NOT create an account.
4. IF a registration request contains an Account_Password shorter than 8 characters, THEN THE Sync_Server SHALL reject the request with a validation error.
5. WHEN an account is created, THE Sync_Server SHALL mark the account email as unverified and SHALL generate a Verification_Token with an expiry of 24 hours.
6. WHEN an account is created, THE Sync_Server SHALL deliver a verification link containing the Verification_Token via the Email_Transport.
7. THE Sync_Server SHALL NOT store the Account_Password in plaintext at any point.

### Requirement 2: Email Verification

**User Story:** As a user, I want to verify my email address, so that the account is confirmed and recovery is possible.

#### Acceptance Criteria

1. WHEN a verification request is received with a valid, unexpired Verification_Token, THE Sync_Server SHALL mark the associated account email as verified.
2. WHEN a Verification_Token is successfully redeemed, THE Sync_Server SHALL invalidate that Verification_Token so it cannot be reused.
3. IF a verification request contains an expired Verification_Token, THEN THE Sync_Server SHALL reject the request with an expiration error and SHALL NOT verify the email.
4. IF a verification request contains an unknown Verification_Token, THEN THE Sync_Server SHALL reject the request with an invalid-token error.
5. WHERE email delivery runs in dev mode, THE Email_Transport SHALL write the verification link to the server console instead of sending an email.

### Requirement 3: Login and Session Issuance

**User Story:** As a user, I want to log in with my credentials, so that I receive a session for authenticated requests.

#### Acceptance Criteria

1. WHEN a login request is received with credentials that match a stored account, THE Sync_Server SHALL issue a Session_Token.
2. IF a login request contains an Account_Password that does not match the stored hash, THEN THE Sync_Server SHALL reject the request with an authentication error and SHALL NOT issue a Session_Token.
3. IF a login request references an account that does not exist, THEN THE Sync_Server SHALL reject the request with an authentication error that does not reveal whether the username or email exists.
4. WHEN a Session_Token is issued, THE Sync_Server SHALL set an expiry on the Session_Token.
5. WHEN the Client receives a Session_Token, THE Client SHALL include the Session_Token on subsequent requests to protected endpoints.

### Requirement 4: Logout

**User Story:** As a user, I want to log out, so that my session can no longer be used on this device.

#### Acceptance Criteria

1. WHEN a logout action is performed, THE Client SHALL discard the stored Session_Token.
2. WHEN a request is made to a protected endpoint without a valid Session_Token, THE Sync_Server SHALL reject the request with an authentication error.

### Requirement 5: Forgot Password and Password Reset

**User Story:** As a user, I want to reset my Account_Password by email, so that I can regain server access if I forget it.

#### Acceptance Criteria

1. WHEN a forgot-password request is received for an existing account, THE Sync_Server SHALL generate a Reset_Token with an expiry of 1 hour and SHALL deliver a reset link containing the Reset_Token via the Email_Transport.
2. WHEN a forgot-password request is received for an email that has no account, THE Sync_Server SHALL return the same success response as for an existing account so that account existence is not revealed.
3. WHEN a reset request is received with a valid, unexpired Reset_Token and a new Account_Password of at least 8 characters, THE Sync_Server SHALL replace the stored Account_Password hash with a hash of the new Account_Password.
4. WHEN a Reset_Token is successfully redeemed, THE Sync_Server SHALL invalidate that Reset_Token so it cannot be reused.
5. IF a reset request contains an expired or unknown Reset_Token, THEN THE Sync_Server SHALL reject the request with an invalid-token error and SHALL NOT change the Account_Password.
6. WHEN an Account_Password is reset, THE Sync_Server SHALL leave the stored Encrypted_Blob unchanged so that vault data remains encrypted under the unchanged Master_Key.
7. THE reset of an Account_Password SHALL NOT grant the Client any ability to decrypt the Encrypted_Blob without the Encryption_Passphrase or the Recovery_Code.

### Requirement 6: Zero-Knowledge Blob Storage

**User Story:** As a user, I want the server to store only encrypted data it cannot read, so that my body measurements and workout data stay private.

#### Acceptance Criteria

1. WHEN the Client pushes sync data, THE Client SHALL encrypt the sensitive data into an Encrypted_Blob using the PrivacyVault Master_Key before transmission.
2. WHEN a push request is received on the protected sync endpoint with a valid Session_Token, THE Sync_Server SHALL store the Encrypted_Blob associated with the authenticated account.
3. THE Sync_Server SHALL store the Encrypted_Blob as opaque ciphertext and SHALL NOT store the Master_Key, the Encryption_Passphrase, or the Recovery_Code.
4. WHEN a pull request is received on the protected sync endpoint with a valid Session_Token, THE Sync_Server SHALL return the stored Encrypted_Blob for the authenticated account, or an empty result when no blob exists.
5. IF a request is made to a sync endpoint without a valid Session_Token, THEN THE Sync_Server SHALL reject the request with an authentication error.
6. WHEN the Client pulls an Encrypted_Blob, THE Client SHALL decrypt the Encrypted_Blob using the PrivacyVault Master_Key.

### Requirement 7: Independent Local Vault Preservation

**User Story:** As a user, I want my existing local encrypted vault to keep working, so that sync is additive and does not weaken local privacy.

#### Acceptance Criteria

1. THE Client SHALL retain the existing PrivacyVault master-key model in which the Master_Key is wrapped independently by the Encryption_Passphrase and the Recovery_Code.
2. THE unlocking of the vault with the Encryption_Passphrase SHALL be independent from authentication with the Account_Password.
3. WHILE the vault is locked, THE Client SHALL reject attempts to encrypt or decrypt sensitive data.
4. WHERE an account is not logged in, THE Client SHALL continue to support local-only encrypted storage, export, and erasure.

### Requirement 8: Multi-Device Vault Reconstruction

**User Story:** As a user, I want to set up a new device by logging in and entering my passphrase, so that my encrypted data is restored securely.

#### Acceptance Criteria

1. WHEN the Client logs in on a new device and pulls the Encrypted_Blob, THE Client SHALL require the Encryption_Passphrase or the Recovery_Code before decrypting the Encrypted_Blob.
2. WHEN the correct Encryption_Passphrase is provided on a new device after a pull, THE Client SHALL reconstruct the vault contents from the Encrypted_Blob.
3. IF an incorrect Encryption_Passphrase is provided after a successful account login and pull, THEN THE Client SHALL fail to decrypt the Encrypted_Blob and SHALL report a decryption failure.
4. WHEN the Recovery_Code is provided on a new device after a pull, THE Client SHALL reconstruct the vault contents from the Encrypted_Blob.

### Requirement 9: Credential and Token Security

**User Story:** As a security-conscious user, I want credentials and tokens handled securely, so that my account cannot be easily compromised.

#### Acceptance Criteria

1. THE Sync_Server SHALL store Account_Passwords only as salted hashes produced by Argon2 or scrypt.
2. THE Sync_Server SHALL generate each Verification_Token and each Reset_Token using a cryptographically secure random source.
3. THE Sync_Server SHALL store each Verification_Token and each Reset_Token with an associated expiry timestamp.
4. WHEN a token expiry timestamp has passed, THE Sync_Server SHALL treat the token as invalid.
5. WHEN repeated failed login attempts are received for the same account within a fixed time window, THE Sync_Server SHALL apply rate limiting to further login attempts for that account.
6. WHERE the Sync_Server runs in production, THE Sync_Server SHALL require transport over HTTPS.
7. THE Sync_Server SHALL NOT store the Encryption_Passphrase, the Recovery_Code, or the Master_Key.

### Requirement 10: Server-Side Account Erasure (GDPR/LGPD)

**User Story:** As a user, I want to permanently delete my server account and data, so that I can exercise my right to erasure.

#### Acceptance Criteria

1. WHEN an account-deletion request is received on the protected endpoint with a valid Session_Token, THE Sync_Server SHALL delete the account record, all associated Verification_Tokens and Reset_Tokens, and the stored Encrypted_Blob.
2. WHEN account deletion completes, THE Sync_Server SHALL invalidate the Session_Token associated with the deleted account.
3. WHEN account deletion completes, THE Sync_Server SHALL retain no PII for the deleted account.
4. THE Client SHALL continue to support local export of the user's data via the existing privacy layer after server account deletion.

### Requirement 11: Privacy Notice and Consent for Cloud Sync

**User Story:** As a user, I want the privacy notice to describe optional encrypted cloud sync, so that I understand what the server does and does not store before I opt in.

#### Acceptance Criteria

1. THE Client SHALL present an updated privacy notice stating that cloud sync is optional and that the Sync_Server stores only unreadable ciphertext.
2. THE updated privacy notice SHALL state that the email address is the only PII processed by the Sync_Server.
3. WHERE the user has not opted into cloud sync, THE Client SHALL NOT transmit any Encrypted_Blob to the Sync_Server.
4. WHEN the user opts into cloud sync, THE Client SHALL record the opt-in before performing the first push to the Sync_Server.

### Requirement 12: Swappable Email Transport

**User Story:** As a developer, I want the email transport to be swappable, so that I can move from dev-mode console output to a real provider later without changing the flow.

#### Acceptance Criteria

1. THE Sync_Server SHALL send verification and reset links through the Email_Transport interface rather than a hardcoded delivery mechanism.
2. WHERE the Email_Transport is configured in dev mode, THE Email_Transport SHALL write the link to the server console.
3. WHERE the Email_Transport is configured with a real provider, THE Email_Transport SHALL deliver the link through that provider without requiring changes to the registration or reset flow.
