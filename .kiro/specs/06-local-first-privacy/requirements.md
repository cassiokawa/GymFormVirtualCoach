# Requirements Document

## Introduction

Form Coach runs entirely on the user's device. Body scans, weight, and workout logs never
leave the machine unless the user explicitly opts into optional, zero-knowledge cloud sync.
Yet the interface already exposes account and Log In controls, and a sync server already
exists. This creates an apparent contradiction: the product promises "this device only" while
offering an account that pushes data to a server.

This spec resolves that contradiction and hardens the existing privacy layer
(`PrivacyVault`, `PrivacyManager`, `PrivacyUI`), account clients (`AuthClient`, `SyncClient`,
`AccountUI`), and the zero-knowledge sync server. The resolution rests on two independent
secrets and one structural guarantee:

- The **Account_Password** authenticates the user to the Sync_Server only. It never decrypts
  any data and never leaves as anything other than a login credential.
- The **Encryption_Passphrase** unlocks the device-only vault Master_Key. It never leaves the
  device in any form.
- The device-only boundary is enforced as a **compile-time type error**, not a runtime check.
  Sensitive data carries a Classification type. The type system makes it impossible to pass
  Classified data to a Network_Sink except through one explicit transform,
  `encryptForSync()`, which returns an opaque Encrypted_Envelope the server cannot read.

This spec formalizes and reconciles code that already exists; it does not rebuild it. It adds
the compile-time classification boundary and a build-time scan that were missing.

The scope of this spec is bounded to the **Privacy & Sync** context (per `structure.md`): it
owns classification types, envelope encryption, and scoped erasure. It does not own exercise
logic or coaching.

## Glossary

- **Client**: The browser-side TypeScript application (Vite), including the privacy layer.
- **Sync_Server**: The optional zero-knowledge Node + SQLite backend.
- **Account_Password**: The credential that authenticates a user to the Sync_Server. It is
  used only for server identity and session management. It can never decrypt vault data.
- **Encryption_Passphrase**: The device-only secret that unwraps the Master_Key. It is never
  transmitted to the Sync_Server in any form.
- **Recovery_Code**: The one-time code generated at vault creation that independently unwraps
  the Master_Key when the Encryption_Passphrase is forgotten.
- **Master_Key**: The random 256-bit AES-GCM key that encrypts all Classified data. Held only
  in memory while the vault is unlocked; never persisted in plaintext.
- **Vault**: The client-side component (`PrivacyVault`) that holds the in-memory Master_Key
  and performs authenticated encryption of Classified data.
- **Classified**: A compile-time classification carried by any value derived from sensitive
  personal data (body scans, weight, workout logs). Modeled as a branded type
  (`Classified<T>` / `Sensitive<T>`) that the type system tracks distinctly from `T`.
- **Encrypted_Envelope**: The opaque output of encrypting Classified data with the Master_Key
  (AES-GCM ciphertext plus initialization vector). It carries no Classification and no key
  material, and is the only representation of Classified data permitted to reach a Network_Sink.
- **encryptForSync**: The single transform that converts Classified data into an
  Encrypted_Envelope. It is the only sanctioned path from Classified to network-transmissible.
- **Network_Sink**: Any outbound transmission primitive (`fetch`, `XMLHttpRequest`,
  `WebSocket`, `navigator.sendBeacon`) that can send data off the device.
- **Wrapped_Key_Metadata**: The Master_Key wrapped independently by the Encryption_Passphrase
  and by the Recovery_Code (`VaultKeyStore`). Safe to store on the Sync_Server because neither
  wrapping can be unwrapped without one of the two device-only secrets.
- **Sync_Consent**: The recorded opt-in decision for optional cloud sync, distinct from the
  local storage consent for sensitive data.
- **Body_Data**: Body-scan measurements and body weight. The highest-risk data class.
- **Workout_Data**: Workout history, reps, sets, and preferences.
- **Classification_Guard**: The build-time scan that fails the build when Classified data can
  reach a Network_Sink without passing through `encryptForSync`.
- **PII**: Personally Identifiable Information. The only PII the Sync_Server holds is the
  user's email address.

## Requirements

### Requirement 1: Local-First Encrypted Storage

**User Story:** As a user, I want all my sensitive data stored encrypted on my device and the
app fully usable without any account or network, so that "this device only" is the default and
not a setting I must find.

#### Acceptance Criteria

1. THE Client SHALL store all Body_Data and Workout_Data locally on the device.
2. WHEN Body_Data is persisted, THE Vault SHALL encrypt the Body_Data with the Master_Key using AES-GCM before it is written to device storage.
3. WHILE no account exists and no network is available, THE Client SHALL allow the user to record, read, export, and erase local data.
4. WHILE the Vault is locked, THE Vault SHALL reject every request to encrypt or decrypt Classified data.
5. WHERE the user has not opted into cloud sync, THE Client SHALL transmit no Body_Data and no Workout_Data to the Sync_Server.

### Requirement 2: Envelope Encryption and Zero-Knowledge Storage

**User Story:** As a user, I want my data encrypted with a key the server never sees, so that
even a fully compromised server cannot read my measurements.

#### Acceptance Criteria

1. THE Vault SHALL encrypt all Classified data with a single 256-bit Master_Key.
2. THE Vault SHALL wrap the Master_Key independently with the Encryption_Passphrase and with the Recovery_Code, deriving each wrapping key via PBKDF2 with a per-credential salt.
3. WHEN the user changes the Encryption_Passphrase, THE Vault SHALL re-wrap the Master_Key under the new Encryption_Passphrase and SHALL leave the encrypted data unchanged.
4. WHEN the Client uploads sync data, THE Sync_Server SHALL store the Encrypted_Envelope and the Wrapped_Key_Metadata as opaque values.
5. THE Sync_Server SHALL store neither the Master_Key, nor the Encryption_Passphrase, nor the Recovery_Code.
6. WHEN a correct credential is supplied on a new device after a pull, THE Client SHALL reconstruct the Master_Key from the Wrapped_Key_Metadata and decrypt the Encrypted_Envelope.
7. IF an incorrect credential is supplied after a pull, THEN THE Client SHALL report a decryption failure and SHALL NOT reconstruct the data.

### Requirement 3: Compile-Time Classification Boundary

**User Story:** As a developer maintaining this codebase under deadline pressure, I want the
device-only boundary enforced by the type system, so that sending sensitive data to the
network unencrypted is a build failure rather than a mistake caught in review.

#### Acceptance Criteria

1. THE Client SHALL represent every value derived from Body_Data or Workout_Data as a Classified type that the type system tracks distinctly from its underlying type.
2. WHEN Classified data is passed to a function typed to accept only a Network_Sink payload, THE type system SHALL raise a compile-time type error.
3. THE Client SHALL provide exactly one transform, `encryptForSync`, that accepts Classified data and returns an Encrypted_Envelope.
4. THE `encryptForSync` transform SHALL produce an Encrypted_Envelope that carries no Classification and contains no plaintext and no key material.
5. WHEN the Classification_Guard scans the build, THE Classification_Guard SHALL fail the build IF Classified data reaches a Network_Sink without passing through `encryptForSync`.
6. WHERE a value is an Encrypted_Envelope, THE type system SHALL permit that value to be passed to a Network_Sink.

### Requirement 4: Optional Account and Opt-In Sync

**User Story:** As a user, I want cloud sync to be optional and off by default, with a clear
one-time choice, so that an account never silently uploads my data.

#### Acceptance Criteria

1. THE Client SHALL authenticate the Account_Password against the Sync_Server only and SHALL NOT use the Account_Password to unwrap the Master_Key.
2. WHERE the user has not granted Sync_Consent, THE Client SHALL perform no push to the Sync_Server.
3. WHEN the user opts into cloud sync, THE Client SHALL record Sync_Consent before the first push to the Sync_Server.
4. WHEN the user declines the cloud-sync opt-in, THE Client SHALL record the decline and SHALL NOT prompt for the cloud-sync opt-in again.
5. WHEN the Client pushes to the Sync_Server, THE Client SHALL transmit only an Encrypted_Envelope and the Wrapped_Key_Metadata.
6. WHEN a request reaches a protected sync endpoint without a valid session, THE Sync_Server SHALL reject the request with an authentication error.

### Requirement 5: Scoped Erasure and Account Deletion

**User Story:** As a user, I want to erase my body data separately from my workout data and to
delete my server account entirely, so that I control each kind of data independently.

#### Acceptance Criteria

1. THE Client SHALL provide erasure of Body_Data that is available independently from erasure of Workout_Data.
2. WHEN the user erases Body_Data, THE Client SHALL remove all stored Body_Data and SHALL retain Workout_Data.
3. WHEN the user erases Workout_Data, THE Client SHALL remove all stored Workout_Data and SHALL retain Body_Data.
4. WHEN the user requests server account deletion with a valid session, THE Sync_Server SHALL delete the account record, all associated tokens, and the stored Encrypted_Envelope and Wrapped_Key_Metadata.
5. WHEN server account deletion completes, THE Sync_Server SHALL retain no PII for the deleted account beyond the point of deletion.
6. WHEN server account deletion completes, THE Client SHALL retain the local encrypted data and SHALL continue to support local export and erasure.

### Requirement 6: Privacy Notice

**User Story:** As a user, I want the privacy notice to state plainly what the server can and
cannot see, so that I can make an informed choice before enabling sync.

#### Acceptance Criteria

1. THE Client SHALL present a privacy notice stating that cloud sync is optional and off by default.
2. THE privacy notice SHALL state that the Sync_Server stores only unreadable ciphertext and cannot decrypt Body_Data or Workout_Data.
3. THE privacy notice SHALL state that the email address is the only PII the Sync_Server holds.
4. THE privacy notice SHALL state that the Encryption_Passphrase and the Recovery_Code never leave the device.
