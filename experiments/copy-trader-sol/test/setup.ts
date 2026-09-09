import { mkdirSync, rmSync } from "node:fs";

const TEST_DB = "./data/test.db";
process.env.DB_PATH = TEST_DB;
process.env.RPC_URL ??= "http://127.0.0.1:0";
process.env.WS_URL ??= "ws://127.0.0.1:0";
process.env.WALLET_SECRET_KEY ??=
  "5upMQeAZiKQhsXSKwmiLxfyFMwyWntbXBT4trfuQtVLoRHGgd8PJ1GkFi2ztt7S6CU3roWw7Pn19xmjfnyEDkxw1";
process.env.FOLLOWED_WALLETS ??= "";
process.env.FIXED_BUY_SOL ??= "0.01";
process.env.LOG_LEVEL ??= "silent";

try { rmSync(TEST_DB); } catch { /* ok */ }
try { rmSync(`${TEST_DB}-wal`); } catch { /* ok */ }
try { rmSync(`${TEST_DB}-shm`); } catch { /* ok */ }
mkdirSync("./data", { recursive: true });
