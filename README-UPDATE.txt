Universe UI and tutorial update

Based on spacexmzez-bit/Taskitator main commit 1cf5439b9ba0ea4c674a0c745c175ff7e40bf6da.
Copy these files to the same paths in the repository. The ZIP contains the supplied UI update plus updated test fixtures and a fix allowing Universe picker tabs to switch while member counts are loading. No worker.js change was required or included. CHANGES.md is the original update description.

Validation: npm test passed 383/383 on Node v24.22.1 with current repository source and image assets. No live Cloudflare deployment or browser acceptance test was performed. Review and test the UI in a browser and on mobile before deploying. If the repository has changed since the base commit, compare changes before overwriting files.
