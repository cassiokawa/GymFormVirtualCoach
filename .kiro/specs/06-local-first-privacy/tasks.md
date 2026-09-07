# Implementation Plan: Local-First Privacy

## Overview

This plan formalizes and hardens the existing Privacy & Sync layer rather than rebuilding it.
The centerpiece is the compile-time classification boundary (`tech.md` hard rule #3): branded
`Classified<T>` types, a single `encryptForSync()` transform, and a build-time
Classification_Guard that fails the build when Classified data can reach a Network_Sink
unencrypted. Existing modules (`PrivacyVault`, `PrivacyManager`, `PrivacyUI`, `AuthClient`,
`SyncClient`, `AccountUI`, `server/`) are reconciled behind these contracts. The second gap
closed here is scoped erasure — Body_Data erasable independently from Workout_Data.

The build in this project is `tsc --noEmit`, so a type-level test that must compile clean is a
first-class part of verification. Client tests run under `vitest`; server tests run under
`node --test`. The Privacy & Sync context depends inward only (`structure.md`): the UI and
account layers depend on its contracts, never the reverse.

## Tasks

- [x] 1. Establish branded classification types
  - [x] 1.1 Create `src/privacy/Classification.ts` with `Classified<T>`/`Sensitive<T>` branded types, the `classify` entry function, and `declassifyForDevice` (the greppable on-device escape hatch)
    - Use a `unique symbol` brand key that user code cannot forge
    - Ensure `Classified<T>` is assignable-from `T` only via `classify`, and never assignable-to a plain `T`
    - _Requirements: 3.1_

  - [ ]* 1.2 Write a type-level test asserting Classified assignability rules under `tsc --noEmit`
    - Assert `classify(x)` produces `Classified<T>`, and that assigning `Classified<T>` to a plain `T` fails to compile (`@ts-expect-error`)
    - _Requirements: 3.1_

- [ ] 2. Define the Encrypted_Envelope boundary and Network_Sink typing
  - [x] 2.1 Re-export the unbranded `EncryptedEnvelope` shape and add `NetworkTransmissible` (envelope + Wrapped_Key_Metadata + account credential) in `src/privacy/Classification.ts`
    - Keep `EncryptedEnvelope` unbranded so it is assignable to a Network_Sink payload
    - Ensure `Classified<T>` is NOT assignable to `NetworkTransmissible`
    - _Requirements: 3.4, 3.6_

  - [x] 2.2 Implement `encryptForSync(vault, data: Classified<T>): Promise<EncryptedEnvelope>` as the single sanctioned transform, delegating to `PrivacyVault.encryptJSON`
    - Consume Classified input, return an unbranded envelope carrying no classification, no plaintext, no key material
    - _Requirements: 3.3, 3.4_

  - [ ]* 2.3 Write a type-level test that passing `Classified<T>` to a `NetworkTransmissible` parameter is a compile error, and passing an `EncryptedEnvelope` compiles
    - Use `@ts-expect-error` on the Classified case; positive case for the envelope
    - _Requirements: 3.2, 3.6_

- [x] 3. Build the Classification_Guard build-time scan
  - [x] 3.1 Create `scripts/classification-guard.mjs` that parses `src/**/*.ts` and flags any module referencing a Network_Sink identifier (`fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`) together with Classified access that does not route through `encryptForSync`
    - Model on existing `scripts/*.mjs` convention; exit non-zero on violation
    - _Requirements: 3.5_

  - [x] 3.2 Wire the Classification_Guard into the build so a violation fails the build
    - Add the guard to the `build` script path alongside `tsc --noEmit`
    - _Requirements: 3.5_

  - [ ]* 3.3 Write a unit test for the guard using fixture modules (one clean, one violating) asserting pass/fail exit codes
    - _Requirements: 3.5_

- [~] 4. Checkpoint - Ensure the type boundary and guard hold
  - Ensure `tsc --noEmit`, the type-level tests, and the guard tests all pass, ask the user if questions arise.

- [ ] 5. Reconcile PrivacyVault as the Master_Key holder
  - [x] 5.1 Formalize `src/privacy/PrivacyVault.ts` contracts: AES-GCM Master_Key wrapped independently by Encryption_Passphrase and Recovery_Code via PBKDF2 with per-credential salt; type body-scan payloads as `Classified<BodyScan[]>` on the way in
    - Keep `encryptJSON`/`decryptJSON` as the crypto core; no cryptographic changes
    - _Requirements: 1.2, 2.1, 2.2_

  - [x] 5.2 Enforce the locked-vault contract: reject every encrypt/decrypt request while the Vault is locked
    - _Requirements: 1.4_

  - [ ] 5.3 Formalize change-passphrase to re-wrap the Master_Key under the new Encryption_Passphrase while leaving encrypted data unchanged
    - _Requirements: 2.3_

  - [ ]* 5.4 Write unit tests for vault encrypt/decrypt round-trip, locked-vault rejection, dual-credential unwrap, and change-passphrase re-wrap
    - _Requirements: 1.2, 1.4, 2.1, 2.2, 2.3_

- [ ] 6. Reconcile PrivacyManager storage and Classified flow
  - [~] 6.1 Retype `loadScans`/`saveScans` in `src/privacy/PrivacyManager.ts` to move `Classified<BodyScan[]>`; encrypt Body_Data with the Master_Key before writing to device storage
    - Support record, read, and export of local data with no account and no network
    - _Requirements: 1.1, 1.2, 1.3_

  - [~] 6.2 Rework `buildSyncBlob` to call `encryptForSync` and emit only an Encrypted_Envelope plus Wrapped_Key_Metadata
    - _Requirements: 2.4, 4.5_

  - [ ]* 6.3 Write unit tests for encrypted-at-rest persistence, offline record/read/export, and that `buildSyncBlob` output contains no plaintext or key material
    - _Requirements: 1.1, 1.2, 1.3, 2.4_

- [x] 7. Implement scoped erasure key partition
  - [x] 7.1 Define explicit `BODY_KEYS` and `WORKOUT_KEYS` partitions and split `eraseAll` into `eraseBodyData`, `eraseWorkoutData`, and `eraseAll` in `PrivacyManager.ts`
    - `eraseBodyData` touches only `BODY_KEYS` and retains Workout_Data; `eraseWorkoutData` touches only `WORKOUT_KEYS` and retains Body_Data
    - Body_Data erasure available independently from Workout_Data erasure
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ]* 7.2 Write unit tests: erasing Body_Data retains Workout_Data and vice versa; full erase clears both
    - _Requirements: 5.1, 5.2, 5.3_

- [ ] 8. Reconcile sync consent and the opt-in gate
  - [~] 8.1 Implement `SyncConsentRecord` handling in `PrivacyManager.ts`: record consent before the first push; block all push while consent is not granted
    - _Requirements: 4.2, 4.3_

  - [~] 8.2 Enforce the decline-once rule: record a decline and never re-prompt the cloud-sync opt-in
    - _Requirements: 4.4_

  - [ ]* 8.3 Write unit tests: no push without consent; consent recorded before first push; declined opt-in is not re-prompted
    - _Requirements: 4.2, 4.3, 4.4_

- [ ] 9. Reconcile SyncClient at the network boundary
  - [x] 9.1 Retype `SyncClient.push` in `src/account/SyncClient.ts` so its body parameter is `EncryptedEnvelope` + `WrappedKeyMetadata` only — never `Classified<T>`
    - This is where the compile boundary bites; envelopes and wrapped-key metadata are the only payloads
    - _Requirements: 3.2, 4.5_

  - [ ]* 9.2 Write a type-level test that `SyncClient.push` rejects `Classified<T>` at compile time and accepts an envelope
    - _Requirements: 3.2, 4.5_

- [ ] 10. Reconcile AuthClient two-secrets separation
  - [x] 10.1 Formalize `src/account/AuthClient.ts`: Account_Password authenticates against the Sync_Server only; the session token is the sole client-held server credential; Account_Password never unwraps the Master_Key
    - Cover login/logout/verify/reset flows against the server
    - _Requirements: 4.1_

  - [ ]* 10.2 Write unit tests asserting Account_Password is used only for server auth and is never passed to vault unwrap paths
    - _Requirements: 4.1_

- [ ] 11. Reconcile the zero-knowledge Sync_Server contract
  - [x] 11.1 Formalize `server/` storage so `blob` (Encrypted_Envelope) and `keyStore` (Wrapped_Key_Metadata) are stored opaque, and neither Master_Key, Encryption_Passphrase, nor Recovery_Code is ever stored
    - Email is the only PII stored
    - _Requirements: 2.4, 2.5_

  - [x] 11.2 Enforce session protection: reject requests to protected sync endpoints without a valid session with an authentication error
    - _Requirements: 4.6_

  - [ ]* 11.3 Write server tests (`node --test`) asserting opaque-only storage, no secret material persisted, and rejection of unauthenticated protected requests
    - _Requirements: 2.4, 2.5, 4.6_

- [ ] 12. Implement server account deletion and scoped server erasure
  - [x] 12.1 Implement `DELETE /account` in `server/` to remove the account record, all associated tokens, and the stored Encrypted_Envelope and Wrapped_Key_Metadata for a valid session; retain no PII beyond deletion
    - _Requirements: 5.4, 5.5_

  - [x] 12.2 Ensure the Client retains local encrypted data after server account deletion and continues to support local export and erasure
    - _Requirements: 5.6_

  - [ ]* 12.3 Write server tests that account deletion removes account, tokens, and blob and leaves no PII; client-side test that local data survives server deletion
    - _Requirements: 5.4, 5.5, 5.6_

- [x] 13. Implement cross-device key reconstruction and decryption failure handling
  - [x] 13.1 Wire pull + unwrap so a correct credential on a new device reconstructs the Master_Key from Wrapped_Key_Metadata and decrypts the Encrypted_Envelope
    - _Requirements: 2.6_

  - [x] 13.2 Handle incorrect-credential pull: report a decryption failure and do not reconstruct data
    - _Requirements: 2.7_

  - [ ]* 13.3 Write unit tests for correct-credential reconstruction and incorrect-credential decryption-failure paths
    - _Requirements: 2.6, 2.7_

- [ ] 14. Surface privacy notice and controls in PrivacyUI
  - [~] 14.1 Render the privacy notice in `src/privacy/PrivacyUI.ts`: sync optional and off by default; server stores only unreadable ciphertext and cannot decrypt Body_Data or Workout_Data; email is the only server-side PII; Encryption_Passphrase and Recovery_Code never leave the device
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [~] 14.2 Add sync opt-in and scoped erase controls (erase Body_Data / erase Workout_Data / full erase) wiring into `PrivacyManager`; no crypto in the UI
    - _Requirements: 4.3, 4.4, 5.1_

  - [ ]* 14.3 Write unit tests that the notice contains the four required statements and that scoped-erase controls invoke the correct manager operations
    - _Requirements: 5.1, 6.1, 6.2, 6.3, 6.4_

- [ ] 15. Wire opt-in sync end to end through AccountUI
  - [~] 15.1 Connect `src/account/AccountUI.ts` to the consent gate, `AuthClient` session, and `SyncClient` push/pull so opt-in sync flows: consent recorded, then envelope + wrapped-key metadata pushed; no push without a valid session
    - _Requirements: 4.2, 4.3, 4.5, 4.6_

  - [ ]* 15.2 Write an integration test for the opt-in push/pull round-trip: consent -> push envelope -> pull -> reconstruct on a fresh vault
    - _Requirements: 4.3, 4.5, 2.6_

- [~] 16. Final checkpoint - Ensure all tests and the boundary pass
  - Ensure `tsc --noEmit`, the Classification_Guard, `vitest run`, and `node --test server/` all pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP.
- Each task references specific requirements clauses for traceability.
- This spec formalizes existing code; reconciliation tasks retype and split behavior behind
  contracts rather than duplicating modules.
- The design has no Correctness Properties section: the core guarantee is a compile-time type
  error plus a build-time scan, verified by type-level tests (`tsc --noEmit`) and guard tests,
  not property-based tests. Reconciliation of existing crypto, clients, and server is covered
  by unit and integration tests.
- The Privacy & Sync context depends inward only; UI and account layers depend on its contracts.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "3.2", "3.3", "5.1", "10.1", "11.1"] },
    { "id": 2, "tasks": ["2.2", "5.2", "5.3", "10.2", "11.2", "11.3", "12.1"] },
    { "id": 3, "tasks": ["2.3", "5.4", "6.1", "9.1", "12.2", "12.3"] },
    { "id": 4, "tasks": ["6.2", "6.3", "7.1", "9.2", "13.1"] },
    { "id": 5, "tasks": ["7.2", "8.1", "13.2", "14.1"] },
    { "id": 6, "tasks": ["8.2", "8.3", "13.3", "14.2"] },
    { "id": 7, "tasks": ["14.3", "15.1"] },
    { "id": 8, "tasks": ["15.2"] }
  ]
}
```
