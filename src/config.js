import "dotenv/config";

export const RPC_URL     = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
export const NETWORK     = process.env.SOLANA_NETWORK || "devnet";
export const PORT        = Number(process.env.PORT) || 3000;

export const MINTS = {
  SOL:  "So11111111111111111111111111111111111111112",
  USDC: NETWORK === "mainnet-beta"
    ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    : "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // devnet USDC
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

export const PROGRAMS = {
  JUPITER_V6:   "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  MARGINFI_V2:  "MFv2hWf31Z9kbCa1snEPdcgp7oBFR2pUBHVHPiNvY7f",
  MARINADE:     "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD",
  TOKEN:        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN_2022:   "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ASSOCIATED_TOKEN: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bE",
};
