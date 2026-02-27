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
// 🔹 إعدادات التذكير
// ==========================

const ADMIN_CHAT_ID = "6970148965"; // ايدي التليجرام الخاص بك
let lastBalanceWarningTime = 0;
const BALANCE_WARNING_INTERVAL = 30 * 60 * 1000; // 30 دقيقة بين كل تذكير

// ==========================
// 🔹 دالة تقريب المبلغ
// ==========================

function roundAmount(amount) {
  try {
    let numAmount;
    
    if (typeof amount === 'string') {
      numAmount = parseFloat(amount);
    } else if (typeof amount === 'number') {
      numAmount = amount;
    } else {
      numAmount = Number(amount);
    }
    
    if (isNaN(numAmount) || numAmount <= 0) {
      console.log(`❌ Invalid amount: ${amount}`);
      return 0;
    }
    
    const rounded = Math.floor(numAmount * 100) / 100;
    
    if (rounded < 0.01) {
      console.log(`⚠️ Amount too small: ${rounded} TON`);
      return 0.01;
    }
    
    console.log(`💰 Original amount: ${numAmount}`);
    console.log(`💰 Rounded amount: ${rounded}`);
    
    return rounded;
  } catch (error) {
    console.log(`❌ Error in roundAmount: ${error.message}`);
    return 0.01;
  }
}

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
// 🔹 متغيرات المحفظة العامة
// ==========================

let walletContract = null;
let walletKey = null;
let walletAddress = null;

// ==========================
// 🔹 إنشاء المحفظة W5
// ==========================

async function getWallet() {
  try {
    if (walletContract && walletKey && walletAddress) {
      return { contract: walletContract, key: walletKey, address: walletAddress };
    }
    
    const mnemonic = process.env.TON_MNEMONIC.split(" ");
    const key = await mnemonicToWalletKey(mnemonic);

    const wallet = WalletContractV5R1.create({
      workchain: 0,
      publicKey: key.publicKey,
    });

    const contract = client.open(wallet);
    const address = contract.address.toString();
    
    // حفظ المتغيرات
    walletContract = contract;
    walletKey = key;
    walletAddress = address;
    
    console.log("✅ Wallet loaded:", address.substring(0, 10) + "...");
    
    // قراءة الرصيد بعد تحميل المحفظة
    await checkWalletBalance(true); // true = تجاهل وقت التذكير عند بدء التشغيل
    
    return { contract, key, address };
  } catch (error) {
    console.error("❌ Wallet error:", error.message);
    throw error;
  }
}

// ==========================
// 🔹 قراءة رصيد المحفظة
// ==========================

async function getWalletBalance() {
  try {
    const { contract } = await getWallet();
    const balance = await contract.getBalance();
    
    // تحويل من nano TON إلى TON
    const balanceInTON = Number(balance) / 1e9;
    
    console.log(`💰 Wallet Balance: ${balanceInTON.toFixed(2)} TON`);
    
    return balanceInTON;
  } catch (error) {
    console.log(`❌ Error getting balance: ${error.message}`);
    return 0;
  }
}

// ==========================
// 🔹 التحقق من الرصيد وإرسال تذكير
// ==========================

async function checkWalletBalance(ignoreTimeCheck = false) {
  try {
    const balance = await getWalletBalance();
    const now = Date.now();
    
    // إذا كان الرصيد أقل من 1 TON
    if (balance < 1) {
      console.log(`⚠️ Low wallet balance: ${balance.toFixed(2)} TON (minimum required: 1 TON)`);
      
      // التحقق من وقت آخر تذكير
      if (ignoreTimeCheck || (now - lastBalanceWarningTime) > BALANCE_WARNING_INTERVAL) {
        await sendBalanceWarning(balance);
        lastBalanceWarningTime = now;
      }
    }
    
    return balance;
  } catch (error) {
    console.log(`❌ Error in checkWalletBalance: ${error.message}`);
    return 0;
  }
}

// ==========================
// 🔹 إرسال تحذير الرصيد المنخفض
// ==========================

async function sendBalanceWarning(currentBalance) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  
  const walletLink = `https://tonviewer.com/${walletAddress}`;
  
  const warningMessage = `⚠️ *Low Wallet Balance Warning* ⚠️

💰 Current Balance: ${currentBalance.toFixed(2)} TON
📉 Minimum Required: 1 TON

🔗 [View Wallet](${walletLink})

Please add funds to the wallet to continue processing withdrawals.`;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: ADMIN_CHAT_ID,
    text: warningMessage,
    parse_mode: 'Markdown',
    disable_web_page_preview: false
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    if (response.ok) {
      console.log(`✅ Balance warning sent to admin`);
    } else {
      console.log(`❌ Failed to send balance warning`);
    }
  } catch (error) {
    console.log(`❌ Error sending balance warning: ${error.message}`);
  }
}

// ==========================
// 🔹 إرسال TON (معدل مع التحقق من الرصيد)
// ==========================

async function sendTON(toAddress, amount) {
  try {
    // تقريب المبلغ أولاً
    const roundedAmount = roundAmount(amount);
    
    // التحقق من صحة المبلغ بعد التقريب
    if (roundedAmount <= 0) {
      throw new Error(`Invalid amount after rounding: ${roundedAmount}`);
    }
    
    // قراءة رصيد المحفظة قبل الإرسال
    const currentBalance = await getWalletBalance();
    
    // التحقق من كفاية الرصيد
    if (currentBalance < roundedAmount) {
      console.log(`❌ Insufficient balance: ${currentBalance.toFixed(2)} TON (required: ${roundedAmount} TON)`);
      
      // إرسال تحذير فوري عن الرصيد المنخفض
      await sendBalanceWarning(currentBalance);
      
      throw new Error(`Insufficient balance. Available: ${currentBalance.toFixed(2)} TON, Required: ${roundedAmount} TON`);
    }
    
    const { contract, key } = await getWallet();
    const seqno = await contract.getSeqno();
    
    const senderAddress = contract.address.toString();
    
    console.log(`💰 Sending ${roundedAmount} TON to ${toAddress.substring(0,10)}...`);
    console.log(`💰 Balance before send: ${currentBalance.toFixed(2)} TON`);
    
    if (roundedAmount < 0.2) {
      console.log(`⚠️ Small amount: ${roundedAmount} TON`);
    }
    
    // تحويل المبلغ المقرب إلى nano TON
    const nanoAmount = toNano(roundedAmount.toFixed(2));
    
    await contract.sendTransfer({
      secretKey: key.secretKey,
      seqno: seqno,
      messages: [
        internal({
          to: toAddress,
          value: nanoAmount,
          bounce: true,
          body: "Withdrawal from @Crystal_Ranch_bot"
        }),
      ],
    });

    console.log(`✅ Transaction sent successfully`);
    
    // قراءة الرصيد بعد الإرسال للتحقق
    setTimeout(async () => {
      const newBalance = await getWalletBalance();
      console.log(`💰 Balance after send: ${newBalance.toFixed(2)} TON`);
      
      // التحقق من الرصيد بعد الإرسال
      await checkWalletBalance();
    }, 5000);
    
    return {
      status: "sent",
      hash: null,
      fromAddress: senderAddress,
      toAddress: toAddress,
      amount: roundedAmount
    };
  } catch (error) {
    console.log(`❌ Error in sendTON: ${error.message}`);
    throw error;
  }
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
// 🔹 إرسال إشعار للقناة
// ==========================

async function sendChannelNotification(amount, toAddress, userId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  
  const chatId = "@Crystal_Ranch_chat";
  const topicId = 5;
  
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
    message_thread_id: topicId
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    const data = await response.json();
    
    if (data.ok && data.result) {
      const messageLink = `https://t.me/Crystal_Ranch_chat/${topicId}/${data.result.message_id}`;
      console.log(`✅ Channel notification sent to topic #${topicId}: ${messageLink}`);
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
    
    // أمر /balance للمشرف فقط
    welcomeBot.onText(/\/balance/, async (msg) => {
      const chatId = msg.chat.id;
      
      // التحقق من أن المستخدم هو المشرف
      if (chatId.toString() !== ADMIN_CHAT_ID) {
        await welcomeBot.sendMessage(chatId, "⛔ Unauthorized");
        return;
      }
      
      try {
        const balance = await getWalletBalance();
        const walletLink = `https://tonviewer.com/${walletAddress}`;
        
        await welcomeBot.sendMessage(chatId, 
          `💰 *Wallet Balance*\n\n` +
          `Balance: ${balance.toFixed(2)} TON\n` +
          `[View Wallet](${walletLink})`,
          { parse_mode: 'Markdown', disable_web_page_preview: false }
        );
      } catch (error) {
        await welcomeBot.sendMessage(chatId, `❌ Error: ${error.message}`);
      }
    });
    
    // أمر /checkbalance للتأكد يدوياً
    welcomeBot.onText(/\/checkbalance/, async (msg) => {
      const chatId = msg.chat.id;
      
      if (chatId.toString() !== ADMIN_CHAT_ID) {
        await welcomeBot.sendMessage(chatId, "⛔ Unauthorized");
        return;
      }
      
      await checkWalletBalance(true);
      await welcomeBot.sendMessage(chatId, "✅ Balance check completed");
    });
    
    welcomeBot.onText(/\/help/, async (msg) => {
      const chatId = msg.chat.id;
      await welcomeBot.sendMessage(chatId, "/start - Welcome\n/help - Help\n/about - About");
    });
    
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

    // ✅ التحقق من رصيد المحفظة أولاً
    const currentBalance = await getWalletBalance();
    
    // ✅ تقريب المبلغ
    const roundedAmount = roundAmount(data.netAmount);
    
    // ✅ التحقق من كفاية الرصيد قبل أي شيء
    if (currentBalance < roundedAmount) {
      console.log(`⏭️ Insufficient balance: ${currentBalance.toFixed(2)} TON (required: ${roundedAmount} TON)`);
      
      // إرسال تذكير بالمشرف
      await sendBalanceWarning(currentBalance);
      
      // ترك السحب pending كما هو
      console.log(`⏭️ Withdrawal ${withdrawId} remains pending - will process when balance is added`);
      
      isProcessing = false;
      return;
    }
    
    // ✅ حد أقصى 10 TON
    if (roundedAmount > 10) {
      console.log(`⏭️ Amount exceeds limit: ${roundedAmount} TON`);
      await withdrawalsRef.child(withdrawId).update({
        status: "failed",
        updatedAt: Date.now(),
        error: "Amount exceeds maximum limit of 10 TON"
      });
      isProcessing = false;
      return;
    }

    // ✅ تحقق من العنوان
    if (!data.address || (!data.address.startsWith("EQ") && !data.address.startsWith("UQ"))) {
      console.log(`⏭️ Invalid address: ${data.address}`);
      await withdrawalsRef.child(withdrawId).update({
        status: "failed",
        updatedAt: Date.now(),
        error: "Invalid TON address"
      });
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

    // إرسال TON (بالمبلغ المقرب)
    console.log(`💰 Sending ${roundedAmount} TON to ${data.address.substring(0,10)}...`);
    console.log(`💰 Current balance: ${currentBalance.toFixed(2)} TON`);
    
    await sendTON(data.address, roundedAmount);

    // تحديث إلى paid
    const updateData = {
      status: "paid",
      updatedAt: Date.now(),
      toAddress: data.address,
      originalAmount: data.netAmount,
      sentAmount: roundedAmount,
      balanceBefore: currentBalance,
      balanceAfter: await getWalletBalance() // سيتم تحديثه بعد الإرسال
    };
    
    await withdrawalsRef.child(withdrawId).update(updateData);
    console.log(`✅ Withdrawal completed: ${withdrawId}`);

    // إرسال الإشعارات
    if (userId) {
      await sendUserNotification(userId, roundedAmount, data.address);
      await sendChannelNotification(roundedAmount, data.address, userId);
    }

  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    if (snapshot.key) {
      // في حالة الخطأ، نتركها pending عشان تجرب تاني
      await withdrawalsRef.child(snapshot.key).update({
        updatedAt: Date.now(),
        lastError: error.message,
        errorCount: admin.database.ServerValue.increment(1)
        // لا نغير status، نتركها pending
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
// 🔹 التحقق الدوري من الرصيد
// ==========================

setInterval(async () => {
  console.log("⏰ Running scheduled balance check...");
  await checkWalletBalance();
}, 15 * 60 * 1000); // كل 15 دقيقة

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

// تحميل المحفظة والتحقق من الرصيد
console.log("\n💰 Loading TON Wallet...");
getWallet().then(async () => {
  const balance = await getWalletBalance();
  console.log(`💰 Initial wallet balance: ${balance.toFixed(2)} TON`);
  
  if (balance < 1) {
    console.log(`⚠️ WARNING: Low wallet balance! Please add funds.`);
    await sendBalanceWarning(balance);
  }
}).catch(err => {
  console.error("❌ Wallet error:", err.message);
});

console.log("\n💸 TON Auto Withdraw Running (Max 10 TON)");
console.log("📬 Messages will be sent to topic #5 (Withdrawals & deposit 💰)");
console.log("👤 Admin notifications will be sent to: 6970148965");
console.log("=".repeat(50) + "\n");
