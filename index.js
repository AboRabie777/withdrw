import express from "express";
import TonWeb from "tonweb";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

/* ==============================
   TON CONFIGURATION
============================== */

const tonweb = new TonWeb(
  new TonWeb.HttpProvider("https://toncenter.com/api/v2/jsonRPC", {
    apiKey: process.env.TON_API_KEY,
  })
);

// تأكد إن عندك mnemonic
if (!process.env.TON_MNEMONIC) {
  console.error("TON_MNEMONIC is missing!");
  process.exit(1);
}

const mnemonicWords = process.env.TON_MNEMONIC.trim().split(" ");

if (mnemonicWords.length !== 24) {
  console.error("Mnemonic must be 24 words");
  process.exit(1);
}

// تحويل mnemonic إلى seed
const seed = await TonWeb.mnemonic.mnemonicToSeed(mnemonicWords);

// إنشاء keypair
const keyPair = TonWeb.utils.keyPairFromSeed(seed);

// استخدام Wallet v4R2
const WalletClass = tonweb.wallet.all.v4R2;

const wallet = new WalletClass(tonweb.provider, {
  publicKey: keyPair.publicKey,
});

/* ==============================
   WITHDRAW ROUTE
============================== */

app.post("/withdraw", async (req, res) => {
  try {
    const { address, amount } = req.body;

    if (!address || !amount) {
      return res.status(400).json({
        error: "Missing address or amount",
      });
    }

    const seqno = await wallet.methods.seqno().call();

    if (seqno === null) {
      return res.status(500).json({
        error: "Wallet not deployed or no seqno",
      });
    }

    await wallet.methods
      .transfer({
        secretKey: keyPair.secretKey,
        toAddress: address,
        amount: TonWeb.utils.toNano(amount.toString()),
        seqno: seqno,
        sendMode: 3,
      })
      .send();

    res.json({
      success: true,
      message: "Withdrawal sent successfully",
    });
  } catch (error) {
    console.error("Withdraw error:", error);
    res.status(500).json({
      error: "Withdrawal failed",
    });
  }
});

/* ==============================
   HEALTH CHECK
============================== */

app.get("/", (req, res) => {
  res.send("TON Withdraw Server Running");
});

/* ==============================
   START SERVER
============================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
