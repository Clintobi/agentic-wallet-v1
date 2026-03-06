/**
 * src/skills/balance.js
 *
 * Skills: get_balance, get_portfolio
 */

import { z } from "zod";
import { register } from "./registry.js";
import { getBalanceSol, getAllBalances } from "../wallet.js";

register({
  name:        "get_balance",
  description: "Get the current SOL balance of the agent wallet.",
  inputSchema: z.object({}),
  async handler(_params, { signer }) {
    const sol = await getBalanceSol(signer.publicKey.toBase58());
    return { sol, address: signer.publicKey.toBase58(), fetchedAt: new Date().toISOString() };
  },
});

register({
  name:        "get_portfolio",
  description: "Get full portfolio: SOL balance + all SPL token balances in the agent wallet.",
  inputSchema: z.object({}),
  async handler(_params, { signer }) {
    const address  = signer.publicKey.toBase58();
    const balances = await getAllBalances(address);
    return { address, ...balances, fetchedAt: new Date().toISOString() };
  },
});
