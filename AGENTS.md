# AGENTS.md — 173-xrpjson-testing

Downstream test harness for [`xrpjson`](https://www.npmjs.com/package/xrpjson).
Exercises all 79 transaction factories at the unit contract, per-family, and
against a live XRPL network.

This file is **environment and workflow only**. It deliberately does not restate
findings or protocol rules — those live in the repo and are cited there:

| Content | Lives in |
|---|---|
| Bugs and divergences found in xrpjson, with citations | `DIVERGENCES.md` |
| User stories, acceptance criteria, and the sources that settle them | `USER-STORIES.md` |
| Coverage matrix, commands, shim notes | `README.md` |

## The source repo is not where its name says

The xrpjson **source** lives at:

```
/Users/jdobson/developer/175-xrpjson      # package name is `xrpjson`, dir is not
```

Searching for a directory matching the package name finds nothing. To read a
factory's source, diff a release, or check a docstring, go there — do not infer
behaviour from the installed `dist/`.

## Search tooling points at the source repo

Both the `codesearch` MCP and the HTTP server index `175-xrpjson` — not this
repo. They share one collection, so results are interchangeable.

```bash
cd /Users/jdobson/developer/175-xrpjson
npx codesearch serve        # HTTP fallback on :7700; MCP needs no daemon
```

The HTTP API wraps responses as `{success, data: {...}}` — **not** flat.
Parsing `results` off the top level returns nothing and looks like an empty
index. Prefer the MCP tools; the repo's own `AGENTS.md` says the same.

## Commands

```bash
npm install --cache="$PWD/.npm-cache"   # see sandbox note below
npm run test:unit        # 608 tests, ~seconds — run this after every change
npm run test:integration # ~30 min against testnet
```

Timing is not uniform across integration suites. Suite [13] is ~20 min on its
own because it waits out the `AccountDelete` account-age requirement — that is
expected, not a hang. Any single suite runs standalone and funds its own
wallets:

```bash
node integration/tests/12-nft-lifecycle.mjs
node integration/tests/13-account-admin.mjs
```

Suite [13] must stay last in `run-all.mjs`: it mutates Alice's signing setup
(regular key, then signer list) and deletes a throwaway account. `AccountDelete`
only succeeds once the regular key and signer list are gone, so ADM-4 and ADM-7
are prerequisites of ADM-12 rather than hygiene.

## Sandbox workarounds

This environment restricts `unlink` outside the workspace. Three consequences:

- **npm** — `npm install` fails with `EPERM ... unlink` under `_cacache/tmp`.
  npm's "root-owned files / sudo chown" message is misleading; it is not an
  ownership problem. Use `--cache="$PWD/.npm-cache"` (already gitignored).
- **bash heredocs** — `cat <<'EOF'`, `python3 - <<'PY'`, and `git commit -F -`
  all fail with "cannot create temp file for here document". Write the file with
  the write tool, then pass `-F <file>`.
- **tooling with heredocs internally** — the `local-docs` skill's `search.sh`
  fails this way. Call the entry point directly:
  ```bash
  ~/.mavis/skills/local-docs/scripts/.venv/bin/python query.py \
    ~/.mavis/docs.local/xrpl-dev-portal "<query>" --limit 5
  ```

## Conventions

- **New suites use the canonical fp factory names** (`payment`, `setRegularKey`),
  not the `XxxTx` aliases in `xrpjson.mjs`. That shim is a migration path for
  suites [1]–[11]; extending it for new code defeats its purpose.
- **`ValidationError` and the `*Flags` enums are not on the root entry.** They
  live on `xrpjson/errors` and `xrpjson/flags`. Importing them from bare
  `xrpjson` yields `undefined`, which makes `instanceof` silently return
  `false`. Route through the shim.
- Shared helpers go in `integration/helpers.mjs` with names that say what they
  return (`extractNFTokenId`, `extractOfferIndex`). A generic reader that silently
  returns `undefined` for one transaction type already cost a 17/17 failure —
  see `DIVERGENCES.md` Bug #S8.

## Workflow

For new user stories, **write `USER-STORIES.md` first, then implement against
it.** The document is the intent; when a test and its story disagree, the story
is right to interrogate. The method is captured in the `xrpl-tx-stories` skill
(`~/.mavis/skills/xrpl-tx-stories/`) — load it before writing ledger tests, and
expect it to contradict an assumption or two.

Expect the live ledger to contradict the spec. When it does, determine which side
is wrong from the canonical source, correct **both** the story and the test, and
record the citation. Never weaken an assertion to make a run green.

Classify every failure before reporting: library defect, test-scaffolding
defect, or doc-only correction. "No new defect found" is a real result worth
stating outright.

## Testnet

`wss://s.altnet.rippletest.net:51233` — no credentials; wallets come from the
faucet. The faucet sets a new account's `Sequence` to the current ledger index,
which is why age-gated operations need an early-funded account. Amendment-gated
families (Vault, Loan, ConfidentialMPT, Sponsorship) may not be enabled — check
`server_info` features before assuming a story can run.

## Git

`main` is the default branch and the only one that ships — branch before
committing. `origin` does not exist; the sole remote is `gitsafe-backup`.
