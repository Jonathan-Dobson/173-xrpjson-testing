/**
 * Submit without waiting for validation.
 *
 * `submitAndWait` polls until the transaction is validated or expires, which
 * is the wrong tool for a transaction rippled intends to HOLD. An underpaid
 * transaction is not refused — it sits in the queue waiting for a better fee
 * offer, so a `submitAndWait` on `Fee: 0` blocks for the whole window and
 * then reports an expiry that says nothing about the fee.
 *
 * The synchronous `submit` returns `engine_result` immediately, and `tel*`
 * codes — the pre-queue, "this will never be applied" family — are exactly
 * where a fee deficiency lands. Returns `{ code, error }`; `code` is the
 * engine result with any `tel`/`tef` prefix stripped.
 */
export async function submitNoWait(client, tx_blob) {
  try {
    const res = await client.request({ command: 'submit', tx_blob });
    const result = res.result ?? {};
    if (result.engine_result === undefined) {
      // Never hand back `undefined`: it surfaces three frames away as
      // "DIDSet returned undefined", with none of the cause attached.
      return {
        code: `NO_ENGINE_RESULT(${JSON.stringify(result).slice(0, 200)})`,
        accepted: false,
        error: 'submit succeeded but carried no engine_result',
      };
    }
    return {
      code: result.engine_result,
      // `accepted` is NOT a verdict. rippled can return `accepted: true`
      // alongside a `tel*` code, so treat `engine_result` as authoritative
      // and this only as an extra signal that the tx entered the queue.
      accepted: result.accepted ?? false,
      error: result.error,
    };
  } catch (e) {
    const msg = String(e?.message ?? e);
    const m = msg.match(/\b(te[lfm][A-Z_]+)\b/);
    return {
      code: m ? m[1] : (msg.split('\n')[0].trim() || 'UNKNOWN_REJECTION'),
      accepted: false,
      error: msg,
    };
  }
}
