require("dotenv").config();
const admin = require("firebase-admin");
const { TonClient, WalletContractV5R1, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");
const { startWelcomeBot } = require("./welcomeBot");

// ==========================
// 🔹 إعدادات الـ Logging
// ==========================

const DEBUG_MODE = false; // غيرها إلى true إذا تريد رؤية كل التفاصيل
let logCounter = 0;
const MAX_LOGS_PER_MINUTE = 100;

function smartLog(...args) {
  logCounter++;
  if (logCounter > MAX_LOGS_PER_MINUTE) {
    if (logCounter === MAX_LOGS_PER_MINUTE + 1) {
      console.log(`⚠️ Too many logs (${logCounter-1}/${MAX_LOGS_PER_MINUTE}), suppressing...`);
    }
    return;
  }
  console.log(...args);
}

function debugLog(...args) {
  if (DEBUG_MODE) {
    console.log(...args);
  }
}

// إعادة تعيين العداد كل دقيقة
setInterval(() => {
  logCounter = 0;
}, 60000);

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
// 🔹 إرسال TON
// ==========================

async function sendTON(toAddress, amount) {
  const { contract, key } = await getWallet();
  const seqno = await contract.getSeqno();
  
  const senderAddress = contract.address.toString();
  
  smartLog(`💰 Sending ${amount} TON to ${toAddress.substring(0,8)}...`);
  debugLog(`Sender address: ${senderAddress}`);
  
  if (amount < 0.2) {
    smartLog(`⚠️ Small amount: ${amount} TON`);
  }
  
  const transfer = await contract.sendTransfer({
    secretKey: key.secretKey,
    seqno: seqno,
    messages: [
      internal({
        to: toAddress,
        value: toNano(String(amount)),
        bounce: true,
        body: "Withdrawal from @Crystal_Ranch_bot"
      }),
    ],
  });

  let transactionHash = null;
  
  try {
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const transactions = await contract.getTransactions(1);
    if (transactions && transactions.length > 0) {
      transactionHash = transactions[0].hash.toString('hex');
      smartLog(`✅ Tx hash: ${transactionHash.substring(0,16)}...`);
    }
  } catch (error) {
    debugLog("Could not fetch transaction hash:", error.message);
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
// 🔹 إرسال إشعار للمستخدم
// ==========================

async function sendUserNotification(chatId, amount, toAddress) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chatId) return false;

  const walletLink = `https://tonviewer.com/${toAddress}`;
  
  const userMessage = `✅ Withdrawal Successful! 🎉

💰 Amount: ${amount} TON
🔗 <a href="${walletLink}">View Transaction on Tonviewer</a>

Your funds have been delivered.`;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: userMessage,
    parse_mode: 'HTML',
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      debugLog("Failed to send user notification");
      return false;
    } else {
      smartLog(`✅ Notif sent to ${chatId}`);
      return true;
    }
  } catch (error) {
    debugLog("Error:", error.message);
    return false;
  }
}

// ==========================
// 🔹 إرسال إشعار للقناة
// ==========================

async function sendChannelNotification(amount, toAddress, userId, botToken) {
  const channelId = "@Crystal_Ranch_chat";
  const walletLink = `https://tonviewer.com/${toAddress}`;
  
  const channelMessage = `🎉 New Withdrawal! 🎉

🆔 User: \`${userId}\`
💰 Amount: ${amount} TON
🔗 <a href="${walletLink}>Tx</a>`;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: channelId,
    text: channelMessage,
    parse_mode: 'HTML',
  };

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    smartLog(`✅ Channel notif sent`);
  } catch (error) {
    debugLog("Error:", error.message);
  }
}

// ==========================
// 🔹 مراقبة السحوبات (معدل)
// ==========================

const withdrawalsRef = db.ref("withdrawals");
let isProcessing = false; // لمنع المعالجة المتزامنة

withdrawalsRef.on("child_added", async (snapshot) => {
  if (isProcessing) {
    debugLog("⚠️ Already processing, skipping...");
    return;
  }
  
  isProcessing = true;
  
  try {
    const withdrawId = snapshot.key;
    const data = snapshot.val();

    if (!data || data.status !== "pending") {
      isProcessing = false;
      return;
    }

    smartLog(`\n🔄 Processing: ${withdrawId.substring(0,10)}...`);

    // التحقق من المبلغ
    if (Number(data.netAmount) > 1) {
      smartLog(`⏭️ Amount >1 TON: ${data.netAmount}`);
      isProcessing = false;
      return;
    }

    // التحقق من العنوان
    if (!data.address || (!data.address.startsWith("EQ") && !data.address.startsWith("UQ"))) {
      smartLog(`⏭️ Invalid address`);
      isProcessing = false;
      return;
    }

    // استخراج userId
    let userId = null;
    if (withdrawId.startsWith("wd_")) {
      const parts = withdrawId.split("_");
      if (parts.length >= 3) userId = parts[2];
    }

    // تحديث الحالة إلى processing
    await withdrawalsRef.child(withdrawId).update({
      status: "processing",
      updatedAt: Date.now(),
    });

    // إرسال TON
    const result = await sendTON(data.address, data.netAmount);

    // تحديث الحالة إلى paid
    const updateData = {
      status: "paid",
      updatedAt: Date.now(),
      toAddress: data.address
    };
    
    if (result.hash) {
      updateData.transactionHash = result.hash;
      updateData.transactionLink = `https://tonviewer.com/transaction/${result.hash}`;
    }

    await withdrawalsRef.child(withdrawId).update(updateData);
    smartLog(`✅ Completed: ${withdrawId.substring(0,10)}...`);

    // إرسال الإشعارات
    if (userId) {
      const userNotified = await sendUserNotification(userId, data.netAmount, data.address);
      if (userNotified) {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        await sendChannelNotification(data.netAmount, data.address, userId, botToken);
      }
    }

  } catch (error) {
    smartLog(`❌ Error: ${error.message}`);
    // إعادة الحالة إلى pending في حالة الخطأ
    if (snapshot.key) {
      await withdrawalsRef.child(snapshot.key).update({
        status: "pending",
        updatedAt: Date.now(),
      });
    }
  } finally {
    // تأخير بسيط بين المعالجات
    setTimeout(() => {
      isProcessing = false;
    }, 2000);
  }
});

// ==========================
// 🔹 تشغيل كل شيء
// ==========================

console.log("\n🚀 Crystal Ranch Bot Started");
console.log("📊 Logs limited to 100/min (Railway limit: 500/sec)");
console.log("💸 Auto-withdraw active (max 1 TON)");

// تشغيل بوت الترحيب
startWelcomeBot();

// مراقبة الأداء
setInterval(() => {
  const memoryUsage = process.memoryUsage();
  debugLog(`📊 Memory: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`);
}, 300000); // كل 5 دقائق
