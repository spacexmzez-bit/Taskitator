# Taskitator Android Build State

- **Baseline GitHub SHA**: `1b28da2d223fb4e613aff1301d883026f4d428e7` (verified on `main`)
- **Active Phase**: Phase 1 — Foundation, authentication and safe shared sync
- **Current Slice**: Slice 1 — Top-Level Sync Push Schema, Demo Data Removal & Initial Pull Invariant

## Implemented in this Slice
- Removed all hardcoded demo tasks from `initDefaultSnapshot`; initial task list starts clean (`emptyList()`).
- Corrected `POST /sync/push` contract: payloads are serialized with top-level snapshot fields, `base_version`, and `mutation_id` (eliminated nested `{payload: snapshot}` defect).
- Added `X-App-ID: taskitator` and `X-Taskitator-User` request headers to `TaskitatorWorkerApi`.
- Added `/auth/me` and `/auth/account` client methods to `TaskitatorWorkerApi`.
- Implemented `needsInitialPull` guard in `TaskRepository`: write pushes require initial remote pull first.
- Implemented explicit 409 conflict handling with non-destructive local backup exports (`taskitator_conflict_backup.json`), preventing automatic/silent overwrite.

## Modified Paths
- `app/src/main/java/com/example/data/model/TaskModels.kt`
- `app/src/main/java/com/example/data/network/TaskitatorWorkerApi.kt`
- `app/src/main/java/com/example/data/repository/TaskRepository.kt`
- `app/src/main/java/com/example/data/util/DateUtils.kt`
- `app/src/test/java/com/example/TaskitatorPhase1SyncTest.kt`
- `android/BUILD_STATE.md`

## API Contracts Used
- `GET /auth/me`
- `POST /auth/account`
- `GET /sync/pull`
- `POST /sync/push` (top-level schema with `base_version` and `mutation_id`)

## Test Results
- `gradle :app:testDebugUnitTest`: PASS (`TaskitatorUnitTest`, `TaskitatorPhase1SyncTest`)
- Verified top-level push payload without nested `payload` key.
- Verified 0 demo tasks on initialization.
- Verified preservation of unknown/excluded fields (`universe_groups`, `sleep_lock_schedule`, `recurrence_state`, `smart_study_opaque_tag`).

## Outstanding Risks & Considerations
- Native Clerk token `azp` validation against Worker's `ALLOWED_ORIGINS` (`https://taskitator.mazendev.com`) requires testing during authentication slice.

## Next Slice
- Phase 1 Slice 2: Clerk Android authentication integration, session token acquisition/refresh, and connecting account identity to `GET /auth/me` and `POST /auth/account`.
