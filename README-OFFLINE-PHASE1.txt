Offline mode, Phase 1. Built on main 50ba9a8.

Copy these files over the same paths in the repo. They already include the latest upstream changes to core.js, pro.js and sw.js.
If main has moved past 50ba9a8, use taskitator-phase1-offline.patch instead; it fails loudly on conflicts.

Before deploying: run node tools/offline-pro-keygen.mjs, set the Worker secret OFFLINE_PRO_PRIVATE_JWK, and paste the public key into core.js (offlineProPublicKey). Until then offline Pro stays off.
