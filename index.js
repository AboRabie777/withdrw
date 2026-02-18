require("dotenv").config();
const TonWeb = require("tonweb");
const admin = require("firebase-admin");
const nacl = require("tweetnacl");
const bip39 = require("bip39");

// ==========================
// 🔹 Firebase
// ==========================

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
  databaseURL: process.env.FIREBASE_DB_URL,
});

const db = admin.database();

// ==========================
// 🔹 TON Setup
// ==========================

const provider = new TonWeb.HttpProvider(
  "https://toncenter.com/api/v2/jsonRPC"
);

const tonweb = new TonWeb(provider);

// 🔥 mnemonic
const mnemonic = process.env.TON_MNEMONIC;
const seed = bip39.mnemonicToSeedSync(mnemonic).slice(0, 32);
const keyPair = nacl.sign.keyPair.fromSeed(seed);

// 🔥 Wallet V5
const WalletClass = tonweb.wallet.all.v5R1;

const wallet = new WalletClass(tonweb.provider, {
  publicKey: keyPair.publicKey,
  wc: 0,
});

// طباعة عنوان السيرفر
(async () => {
  const address = await wallet.getAddress();
  console.log("SERVER WALLET ADDRESS:", address.toString(true, true, true));
})();

// ==========================
// 🔹 إرسال TON
// ==========================

async function sendTON(toAddress, amount) {

  const seqno = await wallet.methods.seqno().call();

  if (typeof seqno !== "number") {
    throw new Error("Wallet not initialized on blockchain");
  }

  const transfer = await wallet.methods.transfer({
    secretKey: keyPair.secretKey,
    toAddress: toAddress,
    amount: TonWeb.utils.toNano(String(amount)),
    seqno: seqno,
    sendMode: 3,
  });

  const result = await transfer.send();
  return result;
}

// ==========================
// 🔹 مراقبة السحوبات
// ==========================

const withdrawalsRef = db.ref("withdrawals");

withdrawalsRef.on("child_added", async (snapshot) => {

  const withdrawId = snapshot.key;
  const data = snapshot.val();

  if (!data || data.status !== "pending") return;

  try {

    console.log("Processing:", withdrawId);

    await withdrawalsRef.child(withdrawId).update({
      status: "processing",
      updatedAt: Date.now(),
    });

    const txHash = await sendTON(data.address, data.netAmount);

    await withdrawalsRef.child(withdrawId).update({
      status: "paid",
      txHash: txHash,
      updatedAt: Date.now(),
    });

    console.log("Paid:", withdrawId);

  } catch (error) {

    console.log("Error:", error);

    await withdrawalsRef.child(withdrawId).update({
      status: "failed",
      error: error.message,
      updatedAt: Date.now(),
    });

  }

});

console.log("🚀 TON Auto Withdraw Running (Wallet V5)...");
