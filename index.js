require("dotenv").config();
const TonWeb = require("tonweb");
const admin = require("firebase-admin");

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

// 🔥 المفتاح السري
const secretKey = TonWeb.utils.hexToBytes(process.env.PRIVATE_KEY);

// 🔥 استخراج Public Key الصحيح
const keyPair = TonWeb.utils.keyPairFromSeed(secretKey);

// 🔥 إنشاء محفظة V3R2 الصحيحة
const WalletClass = tonweb.wallet.all.v3R2;
const wallet = new WalletClass(tonweb.provider, {
  publicKey: keyPair.publicKey,
  wc: 0,
});

// ==========================
// 🔹 إرسال TON
// ==========================

async function sendTON(toAddress, amount) {

  const walletAddress = await wallet.getAddress();
  const seqno = await wallet.methods.seqno().call();

  if (seqno === null || seqno === undefined) {
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

    if (!data.address || !data.netAmount || Number(data.netAmount) <= 0) {
      throw new Error("Invalid withdrawal data");
    }

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

console.log("🚀 TON Auto Withdraw Running...");
