import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { SOL_MINT } from "./config.js";
import { log } from "./log.js";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const WSOL_MINT = new PublicKey(SOL_MINT);

function getAssociatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [addr] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return addr;
}

/**
 * Build a raw CloseAccount instruction. web3.js doesn't expose SPL builders
 * without @solana/spl-token; hand-build the 1-byte instruction data.
 */
function closeAccountIx(account: PublicKey, dest: PublicKey, owner: PublicKey) {
  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]), // SPL Token program: instruction 9 = CloseAccount
  };
}

/**
 * Look for the wallet's wSOL ATA and unwrap it back to native SOL if it holds
 * any balance (leftover from a Jupiter swap that failed to auto-unwrap).
 * Idempotent: no-op when there's no ATA or it's already zero.
 */
export async function unwrapStrayWsol(
  conn: Connection,
  kp: Keypair,
): Promise<{ unwrapped: number; sig: string | null }> {
  const ata = getAssociatedTokenAddress(kp.publicKey, WSOL_MINT);
  const info = await conn.getParsedAccountInfo(ata, "confirmed");
  const data = info.value?.data as
    | { parsed?: { info?: { tokenAmount?: { amount: string } } } }
    | undefined;
  const balance = Number(data?.parsed?.info?.tokenAmount?.amount ?? "0");
  if (!info.value || balance === 0) return { unwrapped: 0, sig: null };

  log.warn({ ata: ata.toBase58(), balance }, "unwrapping stray wSOL");
  const tx = new Transaction().add(closeAccountIx(ata, kp.publicKey, kp.publicKey));
  const sig = await sendAndConfirmTransaction(conn, tx, [kp], {
    commitment: "confirmed",
  });
  return { unwrapped: balance, sig };
}
