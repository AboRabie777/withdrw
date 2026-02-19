require("dotenv").config();
const admin = require("firebase-admin");
const { TonClient, WalletContractV5R1, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");
const TelegramBot = require('node-telegram-bot-api');

// ==========================
// 🔹 منع إنهاء التطبيق
// ==========================

process.stdin.resume();

// تجاهل جميع إشارات الإنهاء
process.on('SIGTERM', () => {
  console.log('⚠️ Received SIGTERM - IGNORING');
});

process.on('SIGINT', () => {
  console.log('⚠️ Received SIGINT - IGNORING');
});

// Keep-alive كل 20 ثانية
setInterval(() => {
  console.log('💓 BOT ALIVE - ' + new Date().toISOString());
  
  const fs = require('fs');
  try {
    fs.writeFileSync('/tmp/bot-alive.txt', Date.now().toString());
  } catch(e) {}
}, 20000);

// ==========================
// 🔹 إعدادات الـ Logging
// ==========================

let logCounter = 0;
const MAX_LOGS_PER_MINUTE = 50;

function smartLog(...args) {
  logCounter++;
  if (logCounter > MAX_LOGS_PER_MINUTE) return;
  console.log(...args);
}

setInterval(() => {
  logCounter = 0;
}, 60000);

// ==========================
// 🔹 Firebase
// ==========================

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT is missing");
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
  console.log("✅ Firebase connected");
} catch (error) {
  console.error("❌ Firebase error:", error.message);
  process.exit(1);
}

const db = admin.database();

// ==========================
// 🔹 TON Client
// ==========================

if (!process.env.TON_API_KEY) {
  console.error("❌ TON_API_KEY is missing");
  process.exit(1);
}

const client = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
  apiKey: process.env.TON_API_KEY,
});

// ==========================
// 🔹 إنشاء المحفظة W5
// ==========================

async function getWallet() {
  try {
    const mnemonic = process.env.TON_MNEMONIC.split(" ");
    const key = await mnemonicToWalletKey(mnemonic);

    const wallet = WalletContractV5R1.create({
      workchain: 0,
      publicKey: key.publicKey,
    });

    const contract = client.open(wallet);
    const address = contract.address.toString();
    console.log("✅ Wallet loaded:", address.substring(0, 10) + "...");
    return { contract, key, wallet, address };
  } catch (error) {
    console.error("❌ Wallet error:", error.message);
    throw error;
  }
}

// ==========================
// 🔹 إرسال TON
// ==========================

async function sendTON(toAddress, amount) {
  const { contract, key } = await getWallet();
  const seqno = await contract.getSeqno();
  
  const senderAddress = contract.address.toString();
  
  console.log(`💰 Sending ${amount} TON to ${toAddress.substring(0,8)}...`);
  
  if (amount < 0.2) {
    console.log(`⚠️ Small amount: ${amount} TON`);
  }
  
  await contract.sendTransfer({
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

  console.log(`✅ Transaction sent successfully`);
  
  return {
    status: "sent",
    hash: null,
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
🔗 ${walletLink}

Your funds have been delivered.`;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: userMessage,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    if (response.ok) {
      console.log(`✅ Notification sent to user ${chatId}`);
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

// ==========================
// 🔹 إرسال إشعار للقناة - في الموضوع الصحيح
// ==========================

async function sendChannelNotification(amount, toAddress, userId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  
  // معرف المجموعة
  const chatId = "@Crystal_Ranch_chat";
  
  // معرف الموضوع الصحيح لـ "Withdrawals & deposit 💰"
  // من الرابط: https://t.me/Crystal_Ranch_chat/5
  const topicId = 5; // هذا هو الرقم الصحيح من الرابط
  
  const walletLink = `https://tonviewer.com/${toAddress}`;
  
  const channelMessage = `🎉 New Withdrawal! 🎉

🆔 User: \`${userId}\`
💰 Amount: ${amount} TON
🔗 <a href="${walletLink}">View Transaction</a>`;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: channelMessage,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    message_thread_id: topicId // هذا هو المفتاح! يحدد الموضوع
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    const data = await response.json();
    
    if (data.ok && data.result) {
      // الرابط الصحيح للرسالة في الموضوع
      const messageLink = `https://t.me/Crystal_Ranch_chat/${topicId}/${data.result.message_id}`;
      console.log(`✅ Channel notification sent to topic #${topicId}: ${messageLink}`);
      
      // إرسال تأكيد简短
      console.log(`📬 Message posted in Withdrawals topic`);
    } else {
      console.log("❌ Failed to send channel notification:", data);
    }
  } catch (error) {
    console.log("❌ Error sending channel notification:", error.message);
  }
}

// ==========================
// 🔹 بوت الترحيب
// ==========================

function startWelcomeBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.log("⚠️ TELEGRAM_BOT_TOKEN missing - Welcome bot disabled");
    return;
  }
  
  try {
    const welcomeBot = new TelegramBot(botToken, { polling: true });
    
    const WELCOME_TEXT = `🚜 Welcome to Crystal Ranch — a scarcity-based economy where early entry matters 👇

🐄 Cow Machine is available to the first 1000 users only
🐔 Chicken Machine unlocks after cows sell out
💎 Diamond Engine costs 5 TON

Early entry is the key to market control 🚀`;

    // أمر /start
    welcomeBot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      
      console.log(`👋 New user started: ${chatId}`);
      
      const keyboard = {
        inline_keyboard: [
          [{ text: "🚀 Open App", url: "https://t.me/Crystal_Ranch_bot?startapp=" }],
          [
            { text: "💬 Chat", url: "https://t.me/Crystal_Ranch_chat" },
            { text: "📢 Channel", url: "https://t.me/earnmoney139482" }
          ]
        ]
      };
      
      try {
        await welcomeBot.sendMessage(chatId, WELCOME_TEXT, {
          reply_markup: keyboard,
          disable_web_page_preview: true
        });
        console.log(`✅ Welcome sent to ${chatId}`);
      } catch (error) {}
    });
    
    // أمر /help
    welcomeBot.onText(/\/help/, async (msg) => {
      const chatId = msg.chat.id;
      await welcomeBot.sendMessage(chatId, "/start - Welcome\n/help - Help\n/about - About");
    });
    
    // أمر /about
    welcomeBot.onText(/\/about/, async (msg) => {
      const chatId = msg.chat.id;
      await welcomeBot.sendMessage(chatId, "💎 Crystal Ranch\nApp: @Crystal_Ranch_bot\nChat: @Crystal_Ranch_chat");
    });
    
    welcomeBot.on('polling_error', () => {});
    
    console.log("✅ Welcome bot is running");
  } catch (error) {
    console.log("❌ Failed to start welcome bot:", error.message);
  }
}

// ==========================
// 🔹 مراقبة السحوبات
// ==========================

const withdrawalsRef = db.ref("withdrawals");
let isProcessing = false;

withdrawalsRef.on("child_added", async (snapshot) => {
  if (isProcessing) {
    console.log("⚠️ Already processing a withdrawal, skipping...");
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

    console.log("\n" + "=".repeat(40));
    console.log(`🔄 Processing withdrawal: ${withdrawId}`);
    console.log("=".repeat(40));

    // ✅ حد أقصى 1 TON
    if (Number(data.netAmount) > 1) {
      console.log(`⏭️ Amount exceeds limit: ${data.netAmount} TON`);
      isProcessing = false;
      return;
    }

    // ✅ تحقق من العنوان
    if (!data.address || (!data.address.startsWith("EQ") && !data.address.startsWith("UQ"))) {
      console.log(`⏭️ Invalid address: ${data.address}`);
      isProcessing = false;
      return;
    }

    // استخراج User ID
    let userId = null;
    if (withdrawId.startsWith("wd_")) {
      const parts = withdrawId.split("_");
      if (parts.length >= 3) {
        userId = parts[2];
        console.log(`✅ User ID: ${userId}`);
      }
    }

    // تحديث إلى processing
    await withdrawalsRef.child(withdrawId).update({
      status: "processing",
      updatedAt: Date.now(),
    });

    // إرسال TON
    console.log(`💰 Sending ${data.netAmount} TON to ${data.address.substring(0,10)}...`);
    await sendTON(data.address, data.netAmount);

    // تحديث إلى paid
    const updateData = {
      status: "paid",
      updatedAt: Date.now(),
      toAddress: data.address
    };
    
    await withdrawalsRef.child(withdrawId).update(updateData);
    console.log(`✅ Withdrawal completed: ${withdrawId}`);

    // إرسال الإشعارات
    if (userId) {
      // إشعار المستخدم
      await sendUserNotification(userId, data.netAmount, data.address);
      
      // إشعار القناة في الموضوع الصحيح (رقم 5)
      await sendChannelNotification(data.netAmount, data.address, userId);
    }

  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    if (snapshot.key) {
      await withdrawalsRef.child(snapshot.key).update({
        status: "pending",
        updatedAt: Date.now(),
      });
    }
  } finally {
    setTimeout(() => {
      isProcessing = false;
      console.log("✅ Ready for next withdrawal\n");
    }, 3000);
  }
});

// ==========================
// 🔹 التحقق من Firebase
// ==========================

db.ref(".info/connected").on("value", (snap) => {
  if (snap.val() === true) {
    console.log("📡 Firebase connected");
  }
});

// ==========================
// 🔹 تشغيل كل شيء
// ==========================

console.log("\n" + "=".repeat(50));
console.log("🚀 CRYSTAL RANCH BOT STARTING...");
console.log("=".repeat(50));

// التحقق من المتغيرات البيئية
console.log("\n📋 Environment Check:");
console.log(`FIREBASE: ${process.env.FIREBASE_SERVICE_ACCOUNT ? '✅' : '❌'}`);
console.log(`TON_API_KEY: ${process.env.TON_API_KEY ? '✅' : '❌'}`);
console.log(`TON_MNEMONIC: ${process.env.TON_MNEMONIC ? '✅' : '❌'}`);
console.log(`TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? '✅' : '❌'}`);

// تشغيل بوت الترحيب
console.log("\n🤖 Starting Welcome Bot...");
startWelcomeBot();

// تحميل المحفظة
console.log("\n💰 Loading TON Wallet...");
getWallet().catch(err => {
  console.error("❌ Wallet error:", err.message);
});

console.log("\n💸 TON Auto Withdraw Running (Max 1 TON)");
console.log("📬 Messages will be sent to topic #5 (Withdrawals & deposit 💰)");
console.log("=".repeat(50) + "\n");
