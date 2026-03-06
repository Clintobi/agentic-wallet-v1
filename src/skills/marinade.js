/**
 * src/skills/marinade.js
 *
 * Skills: marinade_stake, marinade_unstake, get_stake_rate
 *
 * Marinade Finance — liquid staking on Solana.
 * Stake SOL → receive mSOL (liquid, tradeable staking derivative).
 * Current APY: ~7-8%.
 *
 * Uses Marinade's REST API for rate queries and the SDK-compatible
 * instruction builder for actual staking (on devnet: simulated intent).
 */

import { z } from "zod";
import { register } from "./registry.js";
import { PROGRAMS } from "../config.js";

const MARINADE_STATS_URL = "https://api.marinade.finance/msol/apy/1y";
const MARINADE_STATE_URL = "https://api.marinade.finance/tlv";

async function getMarinadeApy() {
  try {
    const resp = await fetch(MARINADE_STATS_URL, { signal: AbortSignal.timeout(6_000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data === "number" ? data : data?.value ?? null;
  } catch {
    return null;
  }
}

async function getMarinadeTvl() {
  try {
    const resp = await fetch(MARINADE_STATE_URL, { signal: AbortSignal.timeout(6_000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.totalSol ?? null;
  } catch {
    return null;
  }
}

register({
  name:        "get_stake_rate",
  description: "Get current Marinade liquid staking APY and total SOL staked (TVL).",
  inputSchema: z.object({}),
  async handler() {
    const [apy, tvl] = await Promise.all([getMarinadeApy(), getMarinadeTvl()]);
    return {
      protocol:    "marinade_finance",
      stakingToken: "mSOL",
      apy:         apy   ?? 0.075,  // fallback ~7.5%
      tvlSol:      tvl   ?? null,
      source:      apy ? "marinade_api" : "simulated_fallback",
      fetchedAt:   new Date().toISOString(),
    };
  },
});

register({
  name:        "marinade_stake",
  description: "Liquid-stake SOL via Marinade Finance. You receive mSOL in return — a tradeable, yield-bearing token (~7-8% APY). mSOL can be swapped back to SOL at any time.",
  inputSchema: z.object({
    amountSol: z.number().describe("Amount of SOL to stake (min 0.01 SOL)"),
  }),
  programs: [PROGRAMS.MARINADE],
  async handler({ amountSol }, { signer }) {
    if (amountSol < 0.01) throw new Error("Minimum stake is 0.01 SOL");

    const apy = await getMarinadeApy() ?? 0.075;

    // In production: use @marinade.finance/marinade-ts-sdk
    //   const marinade = new Marinade(new MarinadeConfig({ connection, publicKey: signer.publicKey }));
    //   const { transaction } = await marinade.deposit(new BN(solToLamports(amountSol)));
    //   const sig = await signAndSend(transaction);

    // On devnet: simulate the stake intent with real APY data
    const mSolReceived = amountSol * (1 / 1.04); // approx mSOL/SOL rate
    const yearlyReturn = amountSol * apy;

    return {
      staked:           true,
      protocol:         "marinade_finance",
      solStaked:        amountSol,
      mSolReceived:     parseFloat(mSolReceived.toFixed(6)),
      stakingApy:       apy,
      projectedYearlyReturn: parseFloat(yearlyReturn.toFixed(6)),
      walletAddress:    signer.publicKey.toBase58(),
      note:             "devnet: stake intent recorded. Connect @marinade.finance/marinade-ts-sdk for live execution.",
    };
  },
});

register({
  name:        "marinade_unstake",
  description: "Unstake mSOL and receive SOL back via Marinade. Instant unstake available (small fee) or delayed unstake (free, ~2 epoch wait).",
  inputSchema: z.object({
    amountMsol: z.number().describe("Amount of mSOL to unstake"),
    instant:    z.boolean().optional().describe("Use instant unstake (small fee) vs delayed (free). Default: false"),
  }),
  programs: [PROGRAMS.MARINADE],
  async handler({ amountMsol, instant = false }, { signer }) {
    const solReceived = amountMsol * 1.04 * (instant ? 0.997 : 1); // ~0.3% instant fee

    return {
      unstaked:      true,
      protocol:      "marinade_finance",
      mSolUnstaked:  amountMsol,
      solReceived:   parseFloat(solReceived.toFixed(6)),
      method:        instant ? "instant_unstake" : "delayed_unstake",
      waitTime:      instant ? "immediate" : "~2 epochs (~4 days)",
      walletAddress: signer.publicKey.toBase58(),
      note:          "devnet: unstake intent recorded.",
    };
  },
});
