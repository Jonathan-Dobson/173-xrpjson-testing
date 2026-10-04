/**
 * Cross-suite state for [16] multisign-only.
 *
 * Suite [16] is split into 16a (setup) and 16b/16c/16d (which consume the
 * account it builds), and the plan requires 16a to run **first and alone**:
 * it is the only part that performs one-way, unrecoverable mutations.
 *
 * That requirement is enforced structurally rather than by convention: the
 * account is a one-way door (MS-5 spends the master key), so a suite that
 * silently rebuilt it would be a suite that re-ran setup as a side effect.
 * Suites 16b/16c/16d therefore LOAD state and skip with a reason when it is
 * absent. They never build it.
 *
 * What is deliberately NOT stored: the master seed. Once MS-5 lands the master
 * key is permanently unusable (the ledger spent the password at genesis), and
 * keeping the seed around would let a later suite accidentally prove something
 * about a configuration that has no master key. MS-15 shows the flag is
 * reversible; the key is not.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const STATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '.multisign-only.json',
);

/**
 * The shape persisted by 16a. `signers` are three funded wallets whose seeds
 * are needed to sign; `recipient` receives the multisigned payments; `master`
 * is absent by design (see the module comment).
 */
export function saveState(state) {
  if (state.master) {
    throw new Error(
      'refusing to persist a master seed: the [16] configuration has no master key',
    );
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  return state;
}

/** Read the state written by 16a, or null when 16a has not run. */
export function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch (e) {
    // A truncated file is not a reason to crash a later suite — it is a reason
    // to re-run setup, which is what "no state" means.
    return null;
  }
}

export function clearState() {
  if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
}

/**
 * Load state for 16b/16c/16d.
 *
 * Returns `{ ok: true, ctx }` or `{ ok: false, reason }`. The caller turns the
 * failure into a `skip()` with the reason attached, so "16a has not run yet"
 * reads as a skip in the report rather than as a silent pass.
 */
export function requireState(importMetaUrl) {
  const state = loadState();
  if (!state) {
    return {
      ok: false,
      reason:
        'no multisign-only account — run suite 16a first (it is the only part ' +
        'that creates the account, and it must run alone)',
    };
  }
  if (!Array.isArray(state.signers) || state.signers.length < 3) {
    return {
      ok: false,
      reason: `multisign-only state is malformed (${importMetaUrl}) — re-run 16a`,
    };
  }
  return { ok: true, ctx: state };
}
