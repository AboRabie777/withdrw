import express from "express";
import TonWeb from "tonweb";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { mnemonicToPrivateKey } from "ton-crypto";

dotenv.config();

const app = express();
app.use(express.json());

/* ================== ENV CHECK ================== */

const {
  TON_API_KEY,
  TON_MNEMONIC,
  TON_WALLET_ADDRESS,
  FIREBASE_DB_URL,
} = process.env;

if (!TON_API_KEY || !TON_MNEMONIC || !TON_WALLET_ADDRESS || !FIREBASE_DB_URL) {
  console.error("Missing required environment variables");
  process.exit(1);
}

/* ================== TON SETUP ================== */

const tonweb = new TonWeb(
  new TonWeb.HttpProvider("https://toncenter.com/api/v2/jsonRPC", {
    apiKey: TON_API_KEY,
  })
);

const mnemonicWords = TON_MNEMONIC.trim().split(" ");

if (mnemonicWords.length !== 12 && mnemonicWords.length !== 24) {
  console.error("Mnemonic must be 12 or 24 words");
  process.exit(1);
}

const keyPair = await mnemonicToPrivateKey(mnemonicWords);

const WalletClass = tonweb.wallet.all.v4R2;

const wallet = new WalletClass(tonweb.provider, {
  publicKey: keyPair.publicKey,
});

/* ================== ADDRESS VALIDATION ================== */

const derivedAddress = await wallet.getAddress();
const derivedString = derivedAddress.toString(true, true, true);

console.log("Derived Address:", derivedString);
console.log("Env Address:", TON_WALLET_ADDRESS);

if (derivedString !== TON_WALLET_ADDRESS) {
  console.error("❌ ERROR: Mnemonic does NOT match wallet address!");
  process.exit(1);
}

/* ================== FIREBASE ================== */

let isProcessing = false;

async function processWithdrawals() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const res = await fetch(`${FIREBASE_DB_URL}/withdrawals.json`);
    const data = await res.json();
    if (!data) {
      isProcessing = false;
      return;
    }

    for (const id in data) {
      const w = data[id];

      if (w.status !== "pending") continue;

      console.log("Processing:", id);

      // قفل العملية مؤقتًا
      await fetch(`${FIREBASE_DB_URL}/withdrawals/${id}.json`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "processing",
          updatedAt: Date.now(),
        }),
      });

      const seqno = await wallet.methods.seqno().call();

      if (typeof seqno !== "number") {
        console.log("Wallet not deployed or seqno unavailable");
        continue;
      }

      await wallet.methods
        .transfer({
          secretKey: keyPair.secretKey,
          toAddress: w.address,
          amount: TonWeb.utils.toNano(w.netAmount.toString()),
          seqno: seqno,
          sendMode: 3,
        })
        .send();

      await fetch(`${FIREBASE_DB_URL}/withdrawals/${id}.json`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "completed",
          updatedAt: Date.now(),
        }),
      });

      console.log("✅ Completed:", id);
    }
  } catch (err) {
    console.error("Auto withdraw error:", err);
  }

  isProcessing = false;
}

// كل 10 ثواني
setInterval(processWithdrawals, 10000);

/* ================== HEALTH ================== */

app.get("/", (req, res) => {
  res.send("TON Auto Withdraw Server Running");
});

/* ================== START ================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
