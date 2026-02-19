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
// 🔹 TON Client
// ==========================

const client = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
  apiKey: process.env.TON_API_KEY,
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

  return { contract, key, wallet };
}

// ==========================
// 🔹 إرسال TON (مع Comment)
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
        body: "@Crystal_Ranch_bot" // 🔥 التعليق
      }),
    ],
  });

  return "sent";
}

// ==========================
// 🔹 إرسال إشعار للمستخدم عبر تليجرام
// ==========================

async function sendTelegramNotification(chatId, amount) {
  // معرف البوت الخاص بك (تحتاج إلى تخزينه في متغيرات البيئة)
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("⚠️ TELEGRAM_BOT_TOKEN is not set in .env file. Cannot send notification.");
    return;
  }

  // التأكد من أن chatId صالح
  if (!chatId) {
    console.log("⚠️ No chatId found for this withdrawal. Skipping notification.");
    return;
  }

  // إنشاء رابط عرض المعاملة (اختياري)
  // لا يمكننا الحصول على رابط المعاملة بسهولة هنا، لذلك سنتركه عاماً أو نضيفه لاحقاً
  // const transactionLink = `https://tonscan.org/tx/...`; 

  const message = `💰 The payment of ${amount} TON has been successfully completed.

🔎 View on TON Viewer (https://tonviewer.com/)`; // رابط عام للموقع

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML', // أو 'Markdown' إذا أردت تنسيق النص
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("❌ Failed to send Telegram notification:", errorData);
    } else {
      console.log(`✅ Telegram notification sent to chat ${chatId} for amount ${amount} TON.`);
    }
  } catch (error) {
    console.error("❌ Error sending Telegram notification:", error.message);
  }
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

    // ✅ حد أقصى 1 TON
    if (Number(data.netAmount) > 1) {
      console.log("Amount exceeds auto limit. Leaving pending.");
      return; // يظل pending
    }

    // ✅ تحقق من العنوان
    if (!data.address || (!data.address.startsWith("EQ") && !data.address.startsWith("UQ"))) {
      console.log("Invalid address. Leaving pending.");
      return;
    }

    // تحويل مؤقت إلى processing
    await withdrawalsRef.child(withdrawId).update({
      status: "processing",
      updatedAt: Date.now(),
    });

    await sendTON(data.address, data.netAmount);

    // تحديث الحالة إلى "paid"
    await withdrawalsRef.child(withdrawId).update({
      status: "paid",
      updatedAt: Date.now(),
    });

    console.log("Paid:", withdrawId);

    // ==========================
    // 🔹 إرسال إشعار تليجرام بعد الدفع الناجح
    // ==========================
    // تأكد من أن لديك حقل 'chatId' في بيانات السحب (data.chatId)
    // إذا كان اسم الحقل مختلفاً (مثل 'userId' أو 'telegramId')، غيّره هنا.
    if (data.chatId) {
        await sendTelegramNotification(data.chatId, data.netAmount);
    } else {
        console.log(`ℹ️ No chatId found for withdrawal ${withdrawId}. Skipping Telegram notification.`);
    }


  } catch (error) {

    console.log("Send error (kept pending):", error.message);

    // 🔥 يرجعها pending ولا يرفضها
    await withdrawalsRef.child(withdrawId).update({
      status: "pending",
      updatedAt: Date.now(),
    });

  }

});

console.log("🚀 TON Auto Withdraw Running (Wallet W5 Secure)...");
