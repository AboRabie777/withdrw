require("dotenv").config();
const admin = require("firebase-admin");
const { TonClient, WalletContractV5R1, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");
const TelegramBot = require('node-telegram-bot-api');

// ==========================
// 🔹 منع إنهاء التطبيق (مهم جداً لـ Railway)
// ==========================

process.stdin.resume();

// معالجة إشارات الإنهاء
process.on('SIGTERM', () => {
  console.log('📴 Received SIGTERM - Continuing...');
  // عدم إنهاء التطبيق
});

process.on('SIGINT', () => {
  console.log('📴 Received SIGINT - Continuing...');
  // عدم إنهاء التطبيق
});

// رسالة Keep-alive كل دقيقة
setInterval(() => {
  console.log('💓 Bot heartbeat: ' + new Date().toISOString());
}, 60000);

// ==========================
// 🔹 إعدادات الـ Logging (لتجنب Rate Limit)
// ==========================

let logCounter = 0;
const MAX_LOGS_PER_MINUTE = 100;

function smartLog(...args) {
  logCounter++;
  if (logCounter > MAX_LOGS_PER_MINUTE) {
    if (logCounter === MAX_LOGS_PER_MINUTE + 1) {
      console.log("⚠️ Too many logs, suppressing...");
    }
    return;
  }
  console.log(...args);
}

// إعادة تعيين عداد الـ logs كل دقيقة
setInterval(() => {
  logCounter = 0;
}, 60000);

// ==========================
// 🔹 نص الترحيب
// ==========================

const WELCOME_TEXT = `🚜 Welcome to Crystal Ranch — a scarcity-based economy where early entry matters 👇

🐄 Cow Machine is available to the first 1000 users only and produces ~1000 Milk per day, while 🐔 Chicken Machine unlocks after cows sell out, is also limited to the first 1000 users, and produces ~1000 Eggs per day.

⚠️ Once the limit is reached, no new user can buy Cows or Chickens, and only early buyers will continue producing every hour.

💎 Diamond Engine costs 5 TON and requires 20,000 Milk + 20,000 Eggs to produce 1 Diamond with a fixed price of 25 TON.

🔥 This is where real power begins: any new user who wants to run the Diamond Engine will need Milk and Eggs… but where will they get them if Cow and Chicken machines are no longer available?

📈 The only way is the market, and the early players who secured Cows and Chickens will control the Milk and Egg supply — and therefore control prices.

Owning Milk and Eggs after sell-out is like owning a rare resource 💎 — early entry is the key to market control 🚀`;

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
    console.log("✅ Wallet loaded:", contract.address.toString().substring(0, 10) + "...");
    return { contract, key, wallet };
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
  
  smartLog(`💰 Sending ${amount} TON to ${toAddress.substring(0,8)}...`);
  
  if (amount < 0.2) {
    smartLog(`⚠️ Small amount: ${amount} TON`);
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

  let transactionHash = null;
  
  try {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const transactions = await contract.getTransactions(1);
    if (transactions && transactions.length > 0) {
      transactionHash = transactions[0].hash.toString('hex');
      smartLog(`✅ Tx hash: ${transactionHash.substring(0,16)}...`);
    }
  } catch (error) {}

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

    if (!response.ok) return false;
    smartLog(`✅ Notif sent to ${chatId}`);
    return true;
  } catch (error) {
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
🔗 <a href="${walletLink}">View</a>`;

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
  } catch (error) {}
}

// ==========================
// 🔹 تشغيل بوت الترحيب
// ==========================

function startWelcomeBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!botToken) {
    console.log("⚠️ TELEGRAM_BOT_TOKEN missing - Welcome bot disabled");
    return null;
  }
  
  try {
    const welcomeBot = new TelegramBot(botToken, { polling: true });
    
    // أمر /start
    welcomeBot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      
      smartLog(`👋 New user: ${chatId}`);
      
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
    
    // تجاهل أخطاء polling
    welcomeBot.on('polling_error', () => {});
    
    console.log("✅ Welcome bot is running");
    return welcomeBot;
  } catch (error) {
    console.log("❌ Failed to start welcome bot:", error.message);
    return null;
  }
}

// ==========================
// 🔹 مراقبة السحوبات
// ==========================

const withdrawalsRef = db.ref("withdrawals");
let isProcessing = false;

withdrawalsRef.on("child_added", async (snapshot) => {
  if (isProcessing) {
    smartLog("⚠️ Already processing, skipping...");
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

    console.log(`\n🔄 Processing withdrawal: ${withdrawId}`);

    // ✅ حد أقصى 1 TON
    if (Number(data.netAmount) > 1) {
      console.log(`⏭️ Amount >1 TON: ${data.netAmount}`);
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
    const result = await sendTON(data.address, data.netAmount);

    // تحديث إلى paid
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
    console.log(`✅ Withdrawal completed: ${withdrawId}`);

    // إرسال الإشعارات
    if (userId) {
      const userNotified = await sendUserNotification(userId, data.netAmount, data.address);
      if (userNotified) {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        await sendChannelNotification(data.netAmount, data.address, userId, botToken);
      }
    }

  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    // إعادة الحالة إلى pending في حالة الخطأ
    if (snapshot.key) {
      await withdrawalsRef.child(snapshot.key).update({
        status: "pending",
        updatedAt: Date.now(),
      });
    }
  } finally {
    // تأخير بين المعالجات
    setTimeout(() => {
      isProcessing = false;
    }, 3000);
  }
});

// ==========================
// 🔹 تشغيل كل شيء
// ==========================

console.log("\n" + "=".repeat(40));
console.log("🚀 Crystal Ranch Bot Starting...");
console.log("=".repeat(40));

// التحقق من المتغيرات الأساسية
console.log("\n📋 Environment Check:");
console.log(`FIREBASE: ${process.env.FIREBASE_SERVICE_ACCOUNT ? '✅' : '❌'}`);
console.log(`TON_API_KEY: ${process.env.TON_API_KEY ? '✅' : '❌'}`);
console.log(`TON_MNEMONIC: ${process.env.TON_MNEMONIC ? '✅' : '❌'}`);
console.log(`TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? '✅' : '❌'}`);

// تشغيل بوت الترحيب
startWelcomeBot();

// التحقق من المحفظة
getWallet().catch(err => {
  console.error("❌ Failed to load wallet:", err.message);
});

console.log("\n💸 TON Auto Withdraw Running (Max 1 TON)");
console.log("✅ Bounce enabled to reduce spam");
console.log("⚠️ Amounts <0.2 TON may be marked as spam");
console.log("=".repeat(40) + "\n");
