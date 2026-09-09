import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";

export function loadKeypair(): Keypair {
  const secret = config.walletSecret.trim();
  if (secret.startsWith("[")) {
    const arr = JSON.parse(secret) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(secret));
}
