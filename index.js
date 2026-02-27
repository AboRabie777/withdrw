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
// 🔹 إعدادات المعالجة
// ==========================

const MAX_RETRIES = 3; // عدد المحاولات لكل سحب
const RETRY_DELAY = 10000; // 10 ثواني بين المحاولات
const BATCH_DELAY = 5000; // 5 ثواني بين كل سحب
const MAX_BALANCE_BUFFER = 0.1; // ترك 0.1 TON كهامش أمان

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
    
    // تقريب لـ 3 منازل عشرية عشان الدقة
    const rounded = Math.floor(numAmount * 1000) / 1000;
    
    if (rounded < 0.001) {
      console.log(`⚠️ Amount too small: ${rounded} TON`);
      return 0.001;
    }
    
    return rounded;
  } catch (error) {
    console.log(`❌ Error in roundAmount: ${error.message}`);
    return 0.001;
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
const processingQueue = new Set();

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
// 🔹 التحقق من الرصيد مع هامش أمان
// ==========================

async function checkSufficientBalance(requiredAmount) {
  const balance = await getWalletBalance();
  const requiredWithBuffer = requiredAmount + MAX_BALANCE_BUFFER;
  
  console.log(`💰 Balance: ${balance.toFixed(3)} TON, Required: ${requiredAmount.toFixed(3)} TON`);
  
  return {
    sufficient: balance >= requiredWithBuffer,
    balance,
    required: requiredAmount,
    deficit: requiredWithBuffer - balance
  };
}

// ==========================
// 🔹 التحقق من الرصيد وإرسال تذكير
// ==========================

async function checkWalletBalance(ignoreTimeCheck = false) {
  try {
    const balance = await getWalletBalance();
    const now = Date.now();
    
    if (balance < 1) {
      console.log(`⚠️ Low wallet balance: ${balance.toFixed(3)} TON`);
      
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

async function sendBalanceWarning(currentBalance, requiredAmount = null) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  
  const walletLink = `https://tonviewer.com/${walletAddress}`;
  
  let warningMessage = `⚠️ *Low Wallet Balance Warning* ⚠️\n\n`;
  warningMessage += `💰 Current Balance: ${currentBalance.toFixed(3)} TON\n`;
  
  if (requiredAmount) {
    warningMessage += `📤 Required Amount: ${requiredAmount.toFixed(3)} TON\n`;
    warningMessage += `📉 Deficit: ${(requiredAmount - currentBalance).toFixed(3)} TON\n\n`;
  } else {
    warningMessage += `📉 Minimum Recommended: 1 TON\n\n`;
  }
  
  warningMessage += `🔗 [View Wallet](${walletLink})\n\n`;
  warningMessage += `Please add funds to continue processing withdrawals.`;

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
// 🔹 إرسال TON مع إعادة المحاولة
// ==========================

async function sendTONWithRetry(toAddress, amount, retryCount = 0) {
  try {
    const roundedAmount = roundAmount(amount);
    
    if (roundedAmount <= 0) {
      throw new Error(`Invalid amount: ${roundedAmount}`);
    }
    
    // التحقق من الرصيد
    const balanceCheck = await checkSufficientBalance(roundedAmount);
    
    if (!balanceCheck.sufficient) {
      await sendBalanceWarning(balanceCheck.balance, roundedAmount);
      throw new Error(`Insufficient balance: ${balanceCheck.balance.toFixed(3)} TON < ${roundedAmount.toFixed(3)} TON`);
    }
    
    const { contract, key } = await getWallet();
    const seqno = await contract.getSeqno();
    
    console.log(`💰 Sending ${roundedAmount} TON to ${toAddress.substring(0,8)}... (Attempt ${retryCount + 1})`);
    
    const nanoAmount = toNano(roundedAmount.toFixed(3));
    
    // إضافة تأخير قبل الإرسال
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    await contract.sendTransfer({
      secretKey: key.secretKey,
      seqno: seqno,
      messages: [
        internal({
          to: toAddress,
          value: nanoAmount,
          bounce: true, // رجوع للـ true لأنك كنت مستخدم bounce
          body: "@Crystal_Ranch_bot" // ✅ تم إعادة النص الأصلي
        }),
      ],
    });

    console.log(`✅ Transaction sent successfully`);
    
    // انتظار تأكيد المعاملة
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    return {
      status: "sent",
      fromAddress: contract.address.toString(),
      toAddress: toAddress,
      amount: roundedAmount
    };
    
  } catch (error) {
    console.log(`❌ Attempt ${retryCount + 1} failed: ${error.message}`);
    
    // إذا كان خطأ 500 أو أي خطأ شبكة ونحن في محاولة أقل من الحد الأقصى
    if ((error.message.includes('500') || error.message.includes('timeout') || error.message.includes('network')) && retryCount < MAX_RETRIES - 1) {
      const delay = RETRY_DELAY * (retryCount + 1);
      console.log(`⏱️ Retrying in ${delay/1000} seconds... (${retryCount + 2}/${MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return sendTONWithRetry(toAddress, amount, retryCount + 1);
    }
    
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

💰 Amount: ${amount.toFixed(3)} TON
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
// 🔹 إرسال إشعار للقناة - في الموضوع الصحيح
// ==========================

async function sendChannelNotification(amount, toAddress, userId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  
  const chatId = "@Crystal_Ranch_chat";
  const topicId = 5;
  
  const walletLink = `https://tonviewer.com/${toAddress}`;
  
  const channelMessage = `🎉 New Withdrawal! 🎉

🆔 User: \`${userId}\`
💰 Amount: ${amount.toFixed(3)} TON
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
// 🔹 معالجة سحب واحد مع إعادة المحاولة
// ==========================

async function processWithdrawal(withdrawId, data) {
  console.log("\n" + "=".repeat(40));
  console.log(`🔄 Processing: ${withdrawId}`);
  console.log("=".repeat(40));

  try {
    // التحقق من البيانات
    if (!data || !data.address || !data.netAmount) {
      console.log(`❌ Invalid withdrawal data`);
      await db.ref(`withdrawals/${withdrawId}`).update({
        status: "failed",
        error: "Invalid withdrawal data",
        updatedAt: Date.now()
      });
      return true;
    }
    
    const roundedAmount = roundAmount(data.netAmount);
    
    // التحقق من الحد الأقصى (10 TON كما كنت)
    if (roundedAmount > 10) {
      console.log(`⏭️ Amount exceeds limit: ${roundedAmount} TON`);
      await db.ref(`withdrawals/${withdrawId}`).update({
        status: "failed",
        error: "Amount exceeds maximum limit of 10 TON",
        updatedAt: Date.now()
      });
      return true;
    }

    // التحقق من العنوان
    if (!data.address.startsWith("EQ") && !data.address.startsWith("UQ")) {
      console.log(`⏭️ Invalid address: ${data.address}`);
      await db.ref(`withdrawals/${withdrawId}`).update({
        status: "failed",
        error: "Invalid TON address",
        updatedAt: Date.now()
      });
      return true;
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
    await db.ref(`withdrawals/${withdrawId}`).update({
      status: "processing",
      updatedAt: Date.now(),
      attempts: (data.attempts || 0) + 1
    });

    // إرسال TON مع إعادة المحاولة
    const result = await sendTONWithRetry(data.address, roundedAmount);

    // تحديث إلى paid
    await db.ref(`withdrawals/${withdrawId}`).update({
      status: "paid",
      updatedAt: Date.now(),
      completedAt: Date.now(),
      toAddress: data.address,
      originalAmount: data.netAmount,
      sentAmount: result.amount,
      balanceBefore: data.balanceBefore || null
    });
    
    console.log(`✅ Completed: ${withdrawId}`);

    // إرسال الإشعارات
    if (userId) {
      await sendUserNotification(userId, result.amount, data.address);
      await sendChannelNotification(result.amount, data.address, userId);
    }
    
    return true;

  } catch (error) {
    console.log(`❌ Failed: ${error.message}`);
    
    // زيادة عداد المحاولات
    const attempts = (data.attempts || 0) + 1;
    
    // إذا وصل لأقصى عدد محاولات، نضعها failed
    if (attempts >= MAX_RETRIES) {
      console.log(`⏭️ Max retries reached for ${withdrawId}`);
      await db.ref(`withdrawals/${withdrawId}`).update({
        status: "failed",
        updatedAt: Date.now(),
        lastError: error.message,
        attempts: attempts
      });
    } else {
      // نتركها pending للمحاولة مرة أخرى
      console.log(`⏭️ Will retry later (attempt ${attempts}/${MAX_RETRIES})`);
      await db.ref(`withdrawals/${withdrawId}`).update({
        status: "pending",
        updatedAt: Date.now(),
        lastError: error.message,
        attempts: attempts
      });
    }
    
    return false;
  }
}

// ==========================
// 🔹 معالجة السحوبات المعلقة
// ==========================

async function processPendingWithdrawals() {
  if (isProcessing) {
    console.log("⚠️ Already processing, skipping...");
    return;
  }
  
  try {
    isProcessing = true;
    
    // جلب السحوبات المعلقة
    const snapshot = await db.ref("withdrawals")
      .orderByChild("status")
      .equalTo("pending")
      .once("value");
    
    const withdrawals = snapshot.val();
    
    if (!withdrawals) {
      console.log("📭 No pending withdrawals");
      isProcessing = false;
      return;
    }
    
    // ترتيب السحوبات (الأقدم أولاً) وتصفية المكرر
    const withdrawalList = Object.entries(withdrawals)
      .filter(([id]) => !processingQueue.has(id))
      .map(([id, data]) => ({
        id,
        data,
        timestamp: data.createdAt || data.timestamp || 0
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
    
    if (withdrawalList.length === 0) {
      console.log("📭 All pending withdrawals are in queue");
      isProcessing = false;
      return;
    }
    
    console.log(`📋 Found ${withdrawalList.length} pending withdrawals`);
    
    // التحقق من الرصيد الكلي المطلوب
    const totalRequired = withdrawalList.reduce((sum, w) => {
      return sum + roundAmount(w.data.netAmount);
    }, 0);
    
    const currentBalance = await getWalletBalance();
    console.log(`💰 Total required: ${totalRequired.toFixed(3)} TON`);
    console.log(`💰 Current balance: ${currentBalance.toFixed(3)} TON`);
    
    if (currentBalance < totalRequired) {
      console.log(`⚠️ Insufficient total balance for all withdrawals`);
      await sendBalanceWarning(currentBalance, totalRequired);
    }
    
    // معالجة كل سحب
    for (let i = 0; i < withdrawalList.length; i++) {
      const { id, data } = withdrawalList[i];
      
      if (processingQueue.has(id)) continue;
      
      processingQueue.add(id);
      
      try {
        console.log(`\n🔄 Processing (${i + 1}/${withdrawalList.length}): ${id}`);
        
        // التحقق من الرصيد قبل كل سحب
        const requiredAmount = roundAmount(data.netAmount);
        const balanceCheck = await checkSufficientBalance(requiredAmount);
        
        if (!balanceCheck.sufficient) {
          console.log(`⏭️ Insufficient balance for this withdrawal (need ${requiredAmount.toFixed(3)} TON, have ${balanceCheck.balance.toFixed(3)} TON)`);
          await sendBalanceWarning(balanceCheck.balance, requiredAmount);
          
          // نخرج من الحلقة عشان الرصيد مش كفاية
          console.log(`⏭️ Stopping batch - insufficient balance`);
          break;
        }
        
        const success = await processWithdrawal(id, data);
        
        if (success) {
          console.log(`✅ Processed successfully`);
        } else {
          console.log(`⚠️ Will retry later`);
        }
        
        // ننتظر بين كل عملية
        if (i < withdrawalList.length - 1) {
          console.log(`⏱️ Waiting ${BATCH_DELAY/1000} seconds before next...`);
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
        }
        
      } catch (error) {
        console.log(`❌ Error in ${id}: ${error.message}`);
      } finally {
        processingQueue.delete(id);
      }
    }
    
  } catch (error) {
    console.log(`❌ Error in processPendingWithdrawals: ${error.message}`);
  } finally {
    isProcessing = false;
    console.log("\n✅ Finished processing batch\n");
  }
}

// ==========================
// 🔹 بوت الترحيب (معدل للاحتفاظ بكل الوظائف)
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
    
    // أمر /balance للمشرف
    welcomeBot.onText(/\/balance/, async (msg) => {
      const chatId = msg.chat.id;
      
      if (chatId.toString() !== ADMIN_CHAT_ID) {
        await welcomeBot.sendMessage(chatId, "⛔ Unauthorized");
        return;
      }
      
      try {
        const balance = await getWalletBalance();
        const pendingSnapshot = await db.ref("withdrawals")
          .orderByChild("status")
          .equalTo("pending")
          .once("value");
        
        const pendingCount = pendingSnapshot.numChildren();
        
        // حساب إجمالي المبالغ المعلقة
        let totalPending = 0;
        pendingSnapshot.forEach(child => {
          totalPending += roundAmount(child.val().netAmount || 0);
        });
        
        const walletLink = `https://tonviewer.com/${walletAddress}`;
        
        await welcomeBot.sendMessage(chatId, 
          `💰 *Wallet Status*\n\n` +
          `Balance: ${balance.toFixed(3)} TON\n` +
          `Pending: ${pendingCount} withdrawals\n` +
          `Total Pending: ${totalPending.toFixed(3)} TON\n` +
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
    
    // أمر /checkbalance للتأكد يدوياً
    welcomeBot.onText(/\/checkbalance/, async (msg) => {
      const chatId = msg.chat.id;
      
      if (chatId.toString() !== ADMIN_CHAT_ID) {
        await welcomeBot.sendMessage(chatId, "⛔ Unauthorized");
        return;
      }
      
      await checkWalletBalance(true);
      const balance = await getWalletBalance();
      await welcomeBot.sendMessage(chatId, `✅ Balance check completed: ${balance.toFixed(3)} TON`);
    });
    
    welcomeBot.on('polling_error', () => {});
    
    console.log("✅ Welcome bot is running with all commands");
  } catch (error) {
    console.log("❌ Failed to start welcome bot:", error.message);
  }
}

// ==========================
// 🔹 التشغيل
// ==========================

console.log("\n" + "=".repeat(50));
console.log("🚀 CRYSTAL RANCH WITHDRAWAL BOT");
console.log("=".repeat(50));

// التحقق من المتغيرات
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
  console.log(`💰 Initial wallet balance: ${balance.toFixed(3)} TON`);
  
  if (balance < 1) {
    console.log(`⚠️ WARNING: Low wallet balance!`);
    await sendBalanceWarning(balance);
  }
  
  // معالجة أولية
  console.log("\n🔄 Processing initial pending withdrawals...");
  await processPendingWithdrawals();
  
}).catch(err => {
  console.error("❌ Wallet error:", err.message);
});

// ==========================
// 🔹 تشغيل المعالجة الدورية
// ==========================

// معالجة كل 60 ثانية (بدلاً من 30 ثانية عشان نقلل الضغط)
setInterval(async () => {
  console.log("\n⏰ Running scheduled check for pending withdrawals...");
  await processPendingWithdrawals();
}, 60000); // 60 ثانية

// التحقق الدوري من الرصيد كل 15 دقيقة
setInterval(async () => {
  console.log("⏰ Running scheduled balance check...");
  await checkWalletBalance();
}, 15 * 60 * 1000);

// ==========================
// 🔹 الاستماع للسحوبات الجديدة
// ==========================

db.ref("withdrawals").on("child_added", async (snapshot) => {
  const withdrawId = snapshot.key;
  const data = snapshot.val();
  
  if (data && data.status === "pending" && !processingQueue.has(withdrawId)) {
    console.log(`📢 New pending withdrawal detected: ${withdrawId}`);
    
    // نشغل المعالجة بعد تأخير بسيط
    setTimeout(() => {
      processPendingWithdrawals();
    }, 2000);
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
