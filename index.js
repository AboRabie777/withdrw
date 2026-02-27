require("dotenv").config();
const admin = require("firebase-admin");
const { TonClient, WalletContractV5R1, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");
const TelegramBot = require('node-telegram-bot-api');

// ==========================
// 🔹 منع إنهاء التطبيق
// ==========================

process.stdin.resume();

process.on('SIGTERM', () => {
  console.log('⚠️ Received SIGTERM - IGNORING');
});

process.on('SIGINT', () => {
  console.log('⚠️ Received SIGINT - IGNORING');
});

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

const ADMIN_CHAT_ID = "6970148965";
let lastBalanceWarningTime = 0;
const BALANCE_WARNING_INTERVAL = 30 * 60 * 1000;

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
// 🔹 متغيرات المحفظة
// ==========================

let walletContract = null;
let walletKey = null;
let walletAddress = null;
let isProcessing = false;
const processingQueue = new Set(); // لتتبع السحوبات قيد المعالجة

// ==========================
// 🔹 إنشاء المحفظة
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
    
    walletContract = contract;
    walletKey = key;
    walletAddress = address;
    
    console.log("✅ Wallet loaded:", address.substring(0, 10) + "...");
    await checkWalletBalance(true);
    
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
    const balanceInTON = Number(balance) / 1e9;
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
    
    if (balance < 1) {
      console.log(`⚠️ Low wallet balance: ${balance.toFixed(2)} TON`);
      
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
// 🔹 إرسال تحذير الرصيد
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
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    console.log(`✅ Balance warning sent to admin`);
  } catch (error) {
    console.log(`❌ Error sending balance warning: ${error.message}`);
  }
}

// ==========================
// 🔹 إرسال TON
// ==========================

async function sendTON(toAddress, amount) {
  try {
    const roundedAmount = roundAmount(amount);
    
    if (roundedAmount <= 0) {
      throw new Error(`Invalid amount after rounding: ${roundedAmount}`);
    }
    
    const currentBalance = await getWalletBalance();
    
    if (currentBalance < roundedAmount) {
      await sendBalanceWarning(currentBalance);
      throw new Error(`Insufficient balance. Available: ${currentBalance.toFixed(2)} TON, Required: ${roundedAmount} TON`);
    }
    
    const { contract, key } = await getWallet();
    const seqno = await contract.getSeqno();
    
    console.log(`💰 Sending ${roundedAmount} TON to ${toAddress.substring(0,10)}...`);
    
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
    
    setTimeout(async () => {
      await checkWalletBalance();
    }, 5000);
    
    return {
      status: "sent",
      fromAddress: contract.address.toString(),
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
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return true;
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
      console.log(`✅ Channel notification sent to topic #${topicId}`);
    }
  } catch (error) {
    console.log(`❌ Error sending channel notification: ${error.message}`);
  }
}

// ==========================
// 🔹 معالجة سحب واحد
// ==========================

async function processWithdrawal(withdrawId, data) {
  console.log("\n" + "=".repeat(40));
  console.log(`🔄 Processing withdrawal: ${withdrawId}`);
  console.log("=".repeat(40));

  try {
    // التحقق من الرصيد
    const currentBalance = await getWalletBalance();
    const roundedAmount = roundAmount(data.netAmount);
    
    // التحقق من كفاية الرصيد
    if (currentBalance < roundedAmount) {
      console.log(`⏭️ Insufficient balance: ${currentBalance.toFixed(2)} TON (required: ${roundedAmount} TON)`);
      await sendBalanceWarning(currentBalance);
      return false; // لم يتم المعالجة
    }
    
    // التحقق من الحد الأقصى
    if (roundedAmount > 10) {
      console.log(`⏭️ Amount exceeds limit: ${roundedAmount} TON`);
      await db.ref(`withdrawals/${withdrawId}`).update({
        status: "failed",
        updatedAt: Date.now(),
        error: "Amount exceeds maximum limit of 10 TON"
      });
      return true; // تمت المعالجة (فشل)
    }

    // التحقق من العنوان
    if (!data.address || (!data.address.startsWith("EQ") && !data.address.startsWith("UQ"))) {
      console.log(`⏭️ Invalid address: ${data.address}`);
      await db.ref(`withdrawals/${withdrawId}`).update({
        status: "failed",
        updatedAt: Date.now(),
        error: "Invalid TON address"
      });
      return true; // تمت المعالجة (فشل)
    }

    // استخراج User ID
    let userId = null;
    if (withdrawId.startsWith("wd_")) {
      const parts = withdrawId.split("_");
      if (parts.length >= 3) {
        userId = parts[2];
      }
    }

    // تحديث إلى processing
    await db.ref(`withdrawals/${withdrawId}`).update({
      status: "processing",
      updatedAt: Date.now(),
    });

    // إرسال TON
    await sendTON(data.address, roundedAmount);

    // تحديث إلى paid
    await db.ref(`withdrawals/${withdrawId}`).update({
      status: "paid",
      updatedAt: Date.now(),
      toAddress: data.address,
      originalAmount: data.netAmount,
      sentAmount: roundedAmount,
      completedAt: Date.now()
    });
    
    console.log(`✅ Withdrawal completed: ${withdrawId}`);

    // إرسال الإشعارات
    if (userId) {
      await sendUserNotification(userId, roundedAmount, data.address);
      await sendChannelNotification(roundedAmount, data.address, userId);
    }
    
    return true; // تمت المعالجة بنجاح

  } catch (error) {
    console.log(`❌ Error processing ${withdrawId}: ${error.message}`);
    
    // في حالة الخطأ، نزيد count المحاولات
    await db.ref(`withdrawals/${withdrawId}`).update({
      updatedAt: Date.now(),
      lastError: error.message,
      errorCount: admin.database.ServerValue.increment(1)
      // نتركها pending
    });
    
    return false; // لم تنجح المعالجة
  }
}

// ==========================
// 🔹 البحث عن السحوبات المعلقة ومعالجتها
// ==========================

async function processPendingWithdrawals() {
  // إذا كان فيه عملية قيد التنفيذ، نخرج
  if (isProcessing) {
    console.log("⚠️ Already processing, skipping check...");
    return;
  }
  
  try {
    isProcessing = true;
    
    // جلب كل السحوبات المعلقة
    const snapshot = await db.ref("withdrawals")
      .orderByChild("status")
      .equalTo("pending")
      .once("value");
    
    const withdrawals = snapshot.val();
    
    if (!withdrawals) {
      console.log("📭 No pending withdrawals found");
      isProcessing = false;
      return;
    }
    
    // تحويل الكائن إلى مصفوفة وترتيبها حسب الوقت (الأقدم أولاً)
    const withdrawalList = Object.entries(withdrawals)
      .map(([id, data]) => ({
        id,
        data,
        timestamp: data.createdAt || data.timestamp || 0
      }))
      .sort((a, b) => a.timestamp - b.timestamp); // الأقدم أولاً
    
    console.log(`📋 Found ${withdrawalList.length} pending withdrawals`);
    
    // معالجة كل سحب على حدة
    for (const withdrawal of withdrawalList) {
      const { id, data } = withdrawal;
      
      // نتأكد إن السحب لسه pending ومش في قائمة المعالجة
      if (data.status !== "pending") continue;
      if (processingQueue.has(id)) continue;
      
      // نضيف للسيت عشان منكررش المعالجة
      processingQueue.add(id);
      
      try {
        // نقرأ البيانات تاني عشان نتأكد إنها لسه pending
        const currentSnapshot = await db.ref(`withdrawals/${id}`).once("value");
        const currentData = currentSnapshot.val();
        
        if (currentData && currentData.status === "pending") {
          console.log(`\n🔄 Processing withdrawal ${id} (${withdrawalList.indexOf(withdrawal) + 1}/${withdrawalList.length})`);
          
          // معالجة السحب
          await processWithdrawal(id, currentData);
          
          // ننتظر 3 ثواني بين كل عملية
          if (withdrawalList.length > 1) {
            console.log(`⏱️ Waiting 3 seconds before next withdrawal...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
      } catch (error) {
        console.log(`❌ Error in withdrawal ${id}: ${error.message}`);
      } finally {
        // نشيل من السيت بعد المعالجة
        processingQueue.delete(id);
      }
    }
    
  } catch (error) {
    console.log(`❌ Error in processPendingWithdrawals: ${error.message}`);
  } finally {
    isProcessing = false;
    console.log("✅ Finished processing pending withdrawals\n");
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
    
    // أمر /balance
    welcomeBot.onText(/\/balance/, async (msg) => {
      const chatId = msg.chat.id;
      
      if (chatId.toString() !== ADMIN_CHAT_ID) {
        await welcomeBot.sendMessage(chatId, "⛔ Unauthorized");
        return;
      }
      
      try {
        const balance = await getWalletBalance();
        const pendingCount = await db.ref("withdrawals")
          .orderByChild("status")
          .equalTo("pending")
          .once("value")
          .then(snapshot => snapshot.numChildren());
        
        const walletLink = `https://tonviewer.com/${walletAddress}`;
        
        await welcomeBot.sendMessage(chatId, 
          `💰 *Wallet Status*\n\n` +
          `Balance: ${balance.toFixed(2)} TON\n` +
          `Pending Withdrawals: ${pendingCount}\n` +
          `[View Wallet](${walletLink})`,
          { parse_mode: 'Markdown', disable_web_page_preview: false }
        );
      } catch (error) {
        await welcomeBot.sendMessage(chatId, `❌ Error: ${error.message}`);
      }
    });
    
    // أمر /process للتشغيل اليدوي
    welcomeBot.onText(/\/process/, async (msg) => {
      const chatId = msg.chat.id;
      
      if (chatId.toString() !== ADMIN_CHAT_ID) {
        await welcomeBot.sendMessage(chatId, "⛔ Unauthorized");
        return;
      }
      
      await welcomeBot.sendMessage(chatId, "🔄 Processing pending withdrawals...");
      await processPendingWithdrawals();
      await welcomeBot.sendMessage(chatId, "✅ Processing completed");
    });
    
    welcomeBot.on('polling_error', () => {});
    
    console.log("✅ Welcome bot is running");
  } catch (error) {
    console.log("❌ Failed to start welcome bot:", error.message);
  }
}

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
getWallet().then(async () => {
  const balance = await getWalletBalance();
  console.log(`💰 Initial wallet balance: ${balance.toFixed(2)} TON`);
  
  if (balance < 1) {
    console.log(`⚠️ WARNING: Low wallet balance!`);
    await sendBalanceWarning(balance);
  }
  
  // تشغيل المعالجة الأولية
  console.log("\n🔄 Processing initial pending withdrawals...");
  await processPendingWithdrawals();
  
}).catch(err => {
  console.error("❌ Wallet error:", err.message);
});

// ==========================
// 🔹 تشغيل المعالجة الدورية
// ==========================

// معالجة كل 30 ثانية
setInterval(async () => {
  console.log("\n⏰ Running scheduled check for pending withdrawals...");
  await processPendingWithdrawals();
}, 30000); // 30 ثانية

// التحقق الدوري من الرصيد كل 15 دقيقة
setInterval(async () => {
  console.log("⏰ Running scheduled balance check...");
  await checkWalletBalance();
}, 15 * 60 * 1000);

// ==========================
// 🔹 الاستماع للسحوبات الجديدة (كخطة احتياطية)
// ==========================

db.ref("withdrawals").on("child_added", async (snapshot) => {
  const withdrawId = snapshot.key;
  const data = snapshot.val();
  
  // نتأكد إن السحب pending ومش قيد المعالجة
  if (data && data.status === "pending" && !processingQueue.has(withdrawId)) {
    console.log(`📢 New pending withdrawal detected: ${withdrawId}`);
    
    // نشغل المعالجة على طول
    setTimeout(() => {
      processPendingWithdrawals();
    }, 1000);
  }
});

db.ref(".info/connected").on("value", (snap) => {
  if (snap.val() === true) {
    console.log("📡 Firebase connected");
  }
});

console.log("\n💸 TON Auto Withdraw Running (Max 10 TON)");
console.log("📬 Messages will be sent to topic #5 (Withdrawals & deposit 💰)");
console.log("👤 Admin notifications will be sent to: 6970148965");
console.log("=".repeat(50) + "\n");
