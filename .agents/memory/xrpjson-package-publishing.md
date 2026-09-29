---
name: xrpjson package publishing
description: Published xrpjson package export and timestamp-validation quirks discovered while migrating tests.
---

The published xrpjson 1.0.0 package declares its root entry as `dist/index.js`, but that file is not included in the tarball. Its functional factories are present under `dist/fp/index.js`, yet the package export map does not expose an `./fp` subpath. The package also rejects current Ripple-epoch timestamps because its escrow/check timestamp guard compares them to the Unix/Ripple epoch offset instead of the current Ripple time.

**Why:** Tests cannot import the documented package root, and valid live-ledger escrow/check timestamps fail factory construction before submission.

**How to apply:** Keep the direct built-file import in one adapter until a published xrpjson release fixes the export map and timestamp guard; then switch the adapter to the documented public import and remove the workaround.