import express from "express";
import TonWeb from "tonweb";
import dotenv from "dotenv";
import { mnemonicToWalletKey } from "ton-crypto";

dotenv.config();

const app = express();

const {
  TON_API_KEY,
  TON_MNEMONIC,
  TON_WALLET_ADDRESS
} = process.env;

if (!TON_API_KEY || !TON_MNEMONIC || !TON_WALLET_ADDRESS) {
  console.error("Missing required environment variables");
  process.exit(1);
}

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

async function detectWalletIndex() {
  console.log("Env Address :", TON_WALLET_ADDRESS);
  console.log("------ Checking first 5 wallet indexes ------");

  const WalletClass = tonweb.wallet.all.v4R2;

  for (let i = 0; i < 5; i++) {
    try {
      const key = await mnemonicToWalletKey(mnemonicWords, i);

      const wallet = new WalletClass(tonweb.provider, {
        publicKey: key.publicKey,
      });

      const addr = await wallet.getAddress();

      const formatted = addr.toString(true, true, true);

      console.log(`Index ${i} : ${formatted}`);

      if (formatted === TON_WALLET_ADDRESS) {
        console.log("✅ MATCH FOUND AT INDEX:", i);
      }

    } catch (e) {
      console.log(`Index ${i} failed`);
    }
  }

  console.log("---------------------------------------------");
}

await detectWalletIndex();

app.get("/", (req, res) => {
  res.send("Wallet index detection completed. Check logs.");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
