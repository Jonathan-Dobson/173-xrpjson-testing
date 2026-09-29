---
name: xrpjson package publishing
description: Published xrpjson package export and timestamp-validation quirks discovered while migrating tests.
---

The published xrpjson 1.0.2 package now exposes its functional factories from the documented root import. Its errors and flags are still not exported from the root, so the test adapter keeps direct imports for those two internal files. The package still rejects current Ripple-epoch timestamps because its escrow timestamp guard compares them to the Unix/Ripple epoch offset instead of the current Ripple time.

**Why:** The 1.0.2 release fixes the factory import problem, but valid live-ledger escrow timestamps still fail factory construction before submission.

**How to apply:** Use the package root for factories. Keep direct built-file imports for errors and flags until they are publicly exported, and keep the timestamp workaround isolated until the validation guard is corrected.