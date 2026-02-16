import express from "express";
import TonWeb from "tonweb";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const tonweb = new TonWeb(
  new TonWeb.HttpProvider("https://toncenter.com/api/v2/jsonRPC", {
    apiKey: process.env.TON_API_KEY,
  })
);

const WalletClass = tonweb.wallet.all.v4R2;

const keyPair = TonWeb.utils.keyPairFromSeed(
  TonWeb.utils.hexToBytes(process.env.TON_PRIVATE_KEY)
);

const wallet = new WalletClass(tonweb.provider, {
  publicKey: keyPair.publicKey,
});

app.post("/withdraw", async (req, res) => {
  try {
    const { address, amount } = req.body;

    const seqno = await wallet.methods.seqno().call();

    await wallet.methods
      .transfer({
        secretKey: keyPair.secretKey,
        toAddress: address,
        amount: TonWeb.utils.toNano(amount),
        seqno: seqno,
        sendMode: 3,
      })
      .send();

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Withdrawal failed" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
