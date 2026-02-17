import express from "express";
import TonWeb from "tonweb";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(express.json());

/* ================= TON SETUP ================= */

const tonweb = new TonWeb(
  new TonWeb.HttpProvider("https://toncenter.com/api/v2/jsonRPC", {
    apiKey: process.env.TON_API_KEY,
  })
);

const mnemonicWords = process.env.TON_MNEMONIC.trim().split(" ");
const seed = await TonWeb.mnemonic.mnemonicToSeed(mnemonicWords);
const keyPair = TonWeb.utils.keyPairFromSeed(seed);

const WalletClass = tonweb.wallet.all.v4R2;
const wallet = new WalletClass(tonweb.provider, {
  publicKey: keyPair.publicKey,
});

/* ================= FIREBASE ================= */

const FIREBASE_URL = process.env.FIREBASE_DB_URL;

/* ================= AUTO PROCESS ================= */

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

      const tx = await wallet.methods
        .transfer({
          secretKey: keyPair.secretKey,
          toAddress: w.address,
          amount: TonWeb.utils.toNano(w.netAmount.toString()),
          seqno: seqno,
          sendMode: 3,
        })
        .send();

      // تحديث الحالة في Firebase
      await fetch(`${FIREBASE_URL}/withdrawals/${id}.json`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "completed",
          txHash: tx,
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

/* ================= HEALTH ================= */

app.get("/", (req, res) => {
  res.send("Auto TON Withdraw Server Running");
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
