import express from "express";
import TonWeb from "tonweb";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { mnemonicToPrivateKey } from "ton-crypto";

dotenv.config();

const app = express();
app.use(express.json());

/* ================= TON CONFIG ================= */

if (
  !process.env.TON_API_KEY ||
  !process.env.TON_MNEMONIC ||
  !process.env.TON_WALLET_ADDRESS
) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const tonweb = new TonWeb(
  new TonWeb.HttpProvider("https://toncenter.com/api/v2/jsonRPC", {
    apiKey: process.env.TON_API_KEY,
  })
);

const mnemonic = process.env.TON_MNEMONIC.trim().split(" ");

if (mnemonic.length !== 12 && mnemonic.length !== 24) {
  console.error("Mnemonic must be 12 or 24 words");
  process.exit(1);
}

// اشتقاق المفاتيح
const keyPair = await mnemonicToPrivateKey(mnemonic);

// إنشاء Wallet v4R2
const WalletClass = tonweb.wallet.all.v4R2;

const wallet = new WalletClass(tonweb.provider, {
  publicKey: keyPair.publicKey,
  address: process.env.TON_WALLET_ADDRESS, // مهم جدًا
});

/* ================= FIREBASE ================= */

const FIREBASE_URL = process.env.FIREBASE_DB_URL;

/* ================= AUTO WITHDRAW ================= */

async function processWithdrawals() {
  try {
    const res = await fetch(`${FIREBASE_URL}/withdrawals.json`);
    const data = await res.json();
    if (!data) return;

    for (const id in data) {
      const w = data[id];
      if (w.status !== "pending") continue;

      console.log("Processing:", id);

      const seqno = await wallet.methods.seqno().call();

      if (typeof seqno !== "number") {
        console.log("Wallet not deployed or seqno unavailable");
        return;
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

      // تحديث Firebase
      await fetch(`${FIREBASE_URL}/withdrawals/${id}.json`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "completed",
          updatedAt: Date.now(),
        }),
      });

      console.log("Completed:", id);
    }
  } catch (err) {
    console.error("Auto withdraw error:", err);
  }
}

// تشغيل كل 10 ثواني
setInterval(processWithdrawals, 10000);

/* ================= HEALTH CHECK ================= */

app.get("/", (req, res) => {
  res.send("Auto TON Withdraw Server Running");
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
