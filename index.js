require("dotenv").config();
const TonWeb = require("tonweb");
const admin = require("firebase-admin");

// ==========================
// 🔹 إعداد Firebase
// ==========================

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
  databaseURL: process.env.FIREBASE_DB_URL,
});

const db = admin.database();

// ==========================
// 🔹 إعداد TON
// ==========================

const provider = new TonWeb.HttpProvider(
  "https://toncenter.com/api/v2/jsonRPC"
);

const tonweb = new TonWeb(provider);

const secretKey = TonWeb.utils.hexToBytes(process.env.PRIVATE_KEY);

const wallet = tonweb.wallet.create({
  publicKey: secretKey,
});

// ==========================
// 🔹 إرسال TON (معدل لحل مشكلة الدقة)
// ==========================

async function sendTON(toAddress, amount) {
  const seqno = await wallet.methods.seqno().call();

  const transfer = await wallet.methods.transfer({
    secretKey: secretKey,
    toAddress: toAddress,
    amount: TonWeb.utils.toNano(String(amount)), // 🔥 الحل هنا
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

    // منع التكرار
    await withdrawalsRef.child(withdrawId).update({
      status: "processing",
      updatedAt: Date.now(),
    });

    if (!data.address || !data.netAmount || Number(data.netAmount) <= 0) {
      throw new Error("Invalid withdrawal data");
    }

    // إرسال TON
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
