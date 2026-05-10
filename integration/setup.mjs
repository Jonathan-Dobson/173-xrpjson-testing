/**
 * Connection and wallet funding helpers.
 * Used by individual test files (standalone) and run-all.mjs.
 */

import { Client } from 'xrpl';
import { TESTNET_WSS } from './helpers.mjs';

/** Connect to XRPL Testnet and return the connected client. */
export async function createClient() {
  const client = new Client(TESTNET_WSS);
  process.stdout.write('Connecting to XRPL Testnet … ');
  await client.connect();
  console.log('connected.\n');
  return client;
}

/**
 * Fund `count` fresh wallets via the faucet (in parallel).
 * Returns an array of Wallet instances.
 */
export async function fundWallets(client, count = 2) {
  console.log(`Funding ${count} wallet(s) via faucet …`);
  const results = await Promise.all(
    Array.from({ length: count }, () => client.fundWallet()),
  );
  const wallets = results.map(r => r.wallet);
  wallets.forEach((w, i) =>
    console.log(`  Wallet ${i + 1}: ${w.classicAddress}`),
  );
  console.log('');
  return wallets;
}

/**
 * Convenience wrapper for standalone test files.
 * Connects, funds two wallets, runs fn(client, alice, bob),
 * prints the grand total, then disconnects.
 */
export async function withStandaloneSetup(fn) {
  const client = await createClient();
  const [alice, bob] = await fundWallets(client, 2);
  let stats = { passed: 0, failed: 0, skipped: 0 };
  try {
    stats = await fn(client, alice, bob) ?? stats;
  } finally {
    await client.disconnect();
  }
  const total = stats.passed + stats.failed + stats.skipped;
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Total: ${stats.passed}/${total} passed  |  ${stats.failed} failed  |  ${stats.skipped} skipped`);
  if (stats.failed > 0) process.exit(1);
}
