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
  
  // الحصول على عنوان المحفظة المرسلة
  const senderAddress = contract.address.toString();
  
  // إرسال المعاملة
  const transfer = await contract.sendTransfer({
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

  // محاولة الحصول على Hash المعاملة
  let transactionHash = null;
  
  try {
    // محاولة الحصول على آخر معاملة للمحفظة
    const transactions = await contract.getTransactions(1);
    if (transactions && transactions.length > 0) {
      transactionHash = transactions[0].hash.toString('hex');
    }
  } catch (error) {
    console.log("Could not fetch transaction hash:", error.message);
  }

  return {
    status: "sent",
    hash: transactionHash,
    fromAddress: senderAddress,
    toAddress: toAddress,
    amount: amount
  };
}

// ==========================
// 🔹 إرسال إشعار للمستخدم عبر تليجرام (للسحوبات)
// ==========================

async function sendWithdrawalNotification(chatId, amount) {
  // معرف البوت الخاص بك
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

  // رسالة السحب
  const message = `💰 The payment of ${amount} TON has been successfully completed.`;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML',
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
      console.log(`✅ Withdrawal notification sent to chat ${chatId} for amount ${amount} TON.`);
    }
  } catch (error) {
    console.error("❌ Error sending Telegram notification:", error.message);
  }
}

// ==========================
// 🔹 إرسال إشعار إيداع للمستخدم عبر تليجرام (مع رابط Tonscan)
// ==========================

async function sendDepositNotification(chatId, amount, transactionHash) {
  // معرف البوت الخاص بك
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("⚠️ TELEGRAM_BOT_TOKEN is not set in .env file. Cannot send notification.");
    return;
  }

  // التأكد من أن chatId صالح
  if (!chatId) {
    console.log("⚠️ No chatId found for this deposit. Skipping notification.");
    return;
  }

  // التأكد من وجود transactionHash
  if (!transactionHash) {
    console.log("⚠️ No transaction hash found for this deposit. Skipping notification.");
    return;
  }

  // إنشاء رابط Tonscan للمعاملة
  const tonscanLink = `https://tonscan.org/tx/${transactionHash}`;

  // رسالة الإيداع كما طلبت
  const message = `💰 Deposit Confirmed!

💵 Amount: ${amount} TON
🔗 <a href="${tonscanLink}">View on Tonscan</a>

Your balance has been updated. Time to grow your farm! 🐔`;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: false // لتمكين معاينة الرابط
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
      console.error("❌ Failed to send deposit notification:", errorData);
    } else {
      console.log(`✅ Deposit notification sent to chat ${chatId} for amount ${amount} TON.`);
      console.log(`   Transaction link: ${tonscanLink}`);
    }
  } catch (error) {
    console.error("❌ Error sending deposit notification:", error.message);
  }
}

// ==========================
// 🔹 مراقبة السحوبات (Withdrawals)
// ==========================

const withdrawalsRef = db.ref("withdrawals");

withdrawalsRef.on("child_added", async (snapshot) => {

  const withdrawId = snapshot.key; // مثلاً: wd_1771515897654_6970148965
  const data = snapshot.val();

  if (!data || data.status !== "pending") return;

  try {

    console.log("Processing withdrawal:", withdrawId);

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

    // ==========================
    // 🔹 استخراج User ID من withdrawId
    // ==========================
    let userId = null;
    if (withdrawId.startsWith("wd_")) {
      const parts = withdrawId.split("_");
      if (parts.length >= 3) {
        // parts[1] هو timestamp، parts[2] هو userId
        userId = parts[2];
        console.log(`✅ Extracted user ID: ${userId} from withdrawal ID`);
      }
    }

    // تحويل مؤقت إلى processing
    await withdrawalsRef.child(withdrawId).update({
      status: "processing",
      updatedAt: Date.now(),
    });

    // إرسال TON والحصول على تفاصيل المعاملة
    const result = await sendTON(data.address, data.netAmount);

    // تحديث الحالة إلى "paid" مع حفظ رابط المعاملة إن وجد
    const updateData = {
      status: "paid",
      updatedAt: Date.now(),
    };
    
    if (result.hash) {
      updateData.transactionHash = result.hash;
      updateData.transactionLink = `https://tonscan.org/tx/${result.hash}`;
    }

    await withdrawalsRef.child(withdrawId).update(updateData);

    console.log("Withdrawal paid:", withdrawId);
    if (result.hash) {
      console.log(`Transaction Hash: ${result.hash}`);
      console.log(`Tonscan Link: https://tonscan.org/tx/${result.hash}`);
    }

    // ==========================
    // 🔹 إرسال إشعار السحب للمستخدم
    // ==========================
    if (userId) {
        await sendWithdrawalNotification(userId, data.netAmount);
    } else {
        console.log(`ℹ️ Could not extract user ID from withdrawal ${withdrawId}. Skipping Telegram notification.`);
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

// ==========================
// 🔹 مراقبة الإيداعات (Deposits) - إذا كنت تريد مراقبة الإيداعات أيضاً
// ==========================
// هذا مثال لكيفية مراقبة الإيداعات وإرسال إشعار عند تأكيد الإيداع
// يمكنك تفعيل هذا الجزء إذا كان لديك هيكل مشابه في Firebase

const depositsRef = db.ref("deposits");

depositsRef.on("child_added", async (snapshot) => {

  const depositId = snapshot.key;
  const data = snapshot.val();

  // تحقق من أن الإيداع بحالة confirmed ولم يتم إرسال إشعار له بعد
  if (!data || data.status !== "confirmed" || data.notificationSent === true) return;

  try {

    console.log("Processing deposit notification:", depositId);

    // استخراج User ID (افترض أن لديك حقل userId في بيانات الإيداع)
    const userId = data.userId || data.chatId;
    
    if (!userId) {
      console.log(`⚠️ No user ID found for deposit ${depositId}. Skipping notification.`);
      return;
    }

    // التأكد من وجود transaction hash
    if (!data.transactionHash) {
      console.log(`⚠️ No transaction hash found for deposit ${depositId}. Skipping notification.`);
      return;
    }

    // إرسال إشعار الإيداع مع رابط Tonscan
    await sendDepositNotification(userId, data.amount, data.transactionHash);

    // تحديث حالة الإشعار في قاعدة البيانات
    await depositsRef.child(depositId).update({
      notificationSent: true,
      notificationSentAt: Date.now(),
    });

    console.log(`✅ Deposit notification sent for ${depositId}`);

  } catch (error) {
    console.error("❌ Error processing deposit notification:", error.message);
  }

});

console.log("🚀 TON Auto Withdraw & Deposit Notifications Running (Wallet W5 Secure)...");
