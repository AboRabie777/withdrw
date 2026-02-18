require("dotenv").config();
const admin = require("firebase-admin");
const { TonClient, WalletContractV5R1, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");

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
// 🔹 TON Client (مع API Key)
// ==========================

const client = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
  apiKey: process.env.TON_API_KEY, // 🔥 مهم جداً
});

// ==========================
// 🔹 إنشاء المحفظة W5
// ==========================

async function getWallet() {
  const mnemonic = process.env.TON_MNEMONIC.split(" ");
  const key = await mnemonicToWalletKey(mnemonic);

  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: key.publicKey,
  });

  const contract = client.open(wallet);

  console.log("SERVER WALLET ADDRESS:", wallet.address.toString());

  return { contract, key };
}

// ==========================
// 🔹 إرسال TON
// ==========================

async function sendTON(toAddress, amount) {
  const { contract, key } = await getWallet();

  const seqno = await contract.getSeqno();

  await contract.sendTransfer({
    secretKey: key.secretKey,
    seqno: seqno,
    messages: [
      internal({
        to: toAddress,
        value: toNano(String(amount)),
        bounce: false,
      }),
    ],
  });

  return "sent";
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

    await sendTON(data.address, data.netAmount);

    await withdrawalsRef.child(withdrawId).update({
      status: "paid",
      updatedAt: Date.now(),
    });

    console.log("Paid:", withdrawId);

  } catch (error) {

    console.log("Error:", error.message);

    await withdrawalsRef.child(withdrawId).update({
      status: "failed",
      error: error.message,
      updatedAt: Date.now(),
    });

  }

});

console.log("🚀 TON Auto Withdraw Running (Wallet W5)...");
