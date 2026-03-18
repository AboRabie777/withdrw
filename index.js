require("dotenv").config();
const admin = require("firebase-admin");
const { TonClient, WalletContractV5R1, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");
const TelegramBot = require('node-telegram-bot-api');

process.stdin.resume();
process.on('SIGTERM', () => { console.log('⚠️ SIGTERM - IGNORING'); });
process.on('SIGINT',  () => { console.log('⚠️ SIGINT - IGNORING');  });

setInterval(() => {
  console.log('💓 BOT ALIVE - ' + new Date().toISOString());
  const fs = require('fs');
  try { fs.writeFileSync('/tmp/bot-alive.txt', Date.now().toString()); } catch(e) {}
}, 20000);

// ==========================
// 🔹 Logging
// ==========================
let logCounter = 0;
function smartLog(...args) { if (++logCounter <= 50) console.log(...args); }
setInterval(() => { logCounter = 0; }, 60000);

// ==========================
// 🔹 إعدادات الأدمن
// ==========================
const ADMIN_CHAT_ID = "6970148965";

// ==========================
// 🔹 إعدادات المعالجة (ديناميكية عبر أوامر البوت)
// ==========================
const MAX_RETRIES = 3;
const RETRY_DELAY = 10000;
const BATCH_DELAY = 3000; // تأخير بسيط 3 ثواني بين السحوبات (فقط للحماية من rate limit)

let MAX_WITHDRAWAL_AMOUNT = 10;    // /setmax
let MIN_WITHDRAWAL_AMOUNT = 0.5;   // /setmin
let MAX_BALANCE_BUFFER    = 0.1;   // هامش أمان
let BAMBOO_TO_TON_RATE    = 10000; // /setrate  — 1 TON = N Bamboo
let systemPaused          = false; // /pause /resume

// ==========================
// 🔹 دالة تقريب المبلغ
// ==========================
function roundAmount(amount) {
  try {
    const n = typeof amount === 'string' ? parseFloat(amount) : Number(amount);
    if (isNaN(n) || n <= 0) return 0;
    const r = Math.floor(n * 1000) / 1000;
    return r < 0.001 ? 0.001 : r;
  } catch { return 0.001; }
}

// ==========================
// 🔹 Firebase
// ==========================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error("❌ FIREBASE_SERVICE_ACCOUNT missing"); process.exit(1); }
try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
  console.log("✅ Firebase connected");
} catch (e) { console.error("❌ Firebase error:", e.message); process.exit(1); }
const db = admin.database();

// ==========================
// 🔹 TON Client
// ==========================
if (!process.env.TON_API_KEY) { console.error("❌ TON_API_KEY missing"); process.exit(1); }
const client = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
  apiKey: process.env.TON_API_KEY,
});

// ==========================
// 🔹 متغيرات المحفظة
// ==========================
let walletContract = null;
let walletKey      = null;
let walletAddress  = null;
let isProcessing   = false;
const processingQueue = new Set();
let botInstance    = null; // مرجع البوت للاستخدام خارج startWelcomeBot

// ==========================
// 🔹 إنشاء المحفظة
// ==========================
async function getWallet() {
  if (walletContract && walletKey && walletAddress)
    return { contract: walletContract, key: walletKey, address: walletAddress };
  const mnemonic = process.env.TON_MNEMONIC.split(" ");
  const key      = await mnemonicToWalletKey(mnemonic);
  const wallet   = WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey });
  const contract = client.open(wallet);
  const address  = contract.address.toString();
  walletContract = contract; walletKey = key; walletAddress = address;
  console.log("✅ Wallet loaded:", address.substring(0, 10) + "...");
  return { contract, key, address };
}

async function getWalletBalance() {
  try {
    const { contract } = await getWallet();
    return Number(await contract.getBalance()) / 1e9;
  } catch (e) { console.log(`❌ getWalletBalance: ${e.message}`); return 0; }
}

// ==========================
// 🔹 فحص الحظر
// ==========================
async function isWalletBanned(address) {
  try {
    const snap = await db.ref(`bannedWallets/${address.replace(/[.$#[\]/]/g, '_')}`).once("value");
    return snap.exists();
  } catch { return false; }
}

async function isUserBanned(userId) {
  try {
    const snap = await db.ref(`bannedUsers/${userId}`).once("value");
    return snap.exists();
  } catch { return false; }
}

// ==========================
// 🔹 فحص عدد السحوبات اليومية
// ==========================
async function getUserDailyWithdrawalCount(userId) {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const snap = await db.ref("withdrawQueue")
      .orderByChild("userId").equalTo(userId).once("value");
    if (!snap.exists()) return 0;
    let count = 0;
    snap.forEach(child => {
      const d = child.val();
      const ts = d.ts || d.timestamp || 0;
      const status = d.status || '';
      // عد السحوبات المدفوعة + المعالجة + المعلقة + بانتظار موافقة اليوم
      if (ts >= startOfDay.getTime() && ['paid', 'processing', 'pending', 'awaiting_approval'].includes(status)) {
        count++;
      }
    });
    return count;
  } catch (e) { console.log(`❌ getUserDailyWithdrawalCount: ${e.message}`); return 0; }
}

// ==========================
// 🔹 إشعار الأدمن بطلب موافقة على سحب
// ==========================
async function sendAdminApprovalRequest(botInstance, withdrawId, data, dailyCount) {
  const roundedAmount = roundAmount(data.ton);
  const userId        = data.userId || 'unknown';
  const address       = data.address || '—';
  const amountCoins   = data.amt || 0;
  const requestTime   = new Date(data.ts || Date.now()).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });

  const text =
    `⚠️ <b>سحب يحتاج موافقة</b>\n\n` +
    `👤 User: <code>${userId}</code>\n` +
    `📅 عدد السحوبات اليوم: <b>${dailyCount}</b> (تجاوز الحد المسموح)\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `🆔 ID: <code>${withdrawId}</code>\n` +
    `💰 المبلغ: <b>${roundedAmount} TON</b>\n` +
    `🪙 Bamboo: <b>${Number(amountCoins).toLocaleString()}</b>\n` +
    `📬 المحفظة:\n<code>${address}</code>\n` +
    `🕐 الوقت: ${requestTime} UTC\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `هل توافق على هذا السحب؟`;

  try {
    await botInstance.sendMessage(ADMIN_CHAT_ID, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ موافقة — ادفع الآن", callback_data: `approve_wd:${withdrawId}` },
          { text: "❌ رفض — إلغاء",        callback_data: `reject_wd:${withdrawId}`  },
        ]]
      }
    });
    console.log(`📨 Approval request sent for ${withdrawId}`);
  } catch (e) { console.log(`❌ sendAdminApprovalRequest: ${e.message}`); }
}

async function checkSufficientBalance(requiredAmount) {
  const balance = await getWalletBalance();
  return {
    sufficient: balance >= (requiredAmount + MAX_BALANCE_BUFFER),
    balance, required: requiredAmount
  };
}

// ==========================
// 🔹 دالة مساعدة للرد على الأدمن
// ==========================
async function adminReply(bot, chatId, text, extra = {}) {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  } catch (e) { console.log(`❌ adminReply: ${e.message}`); }
}

// ==========================
// 🔹 التحقق من تأكيد المعاملة على الشبكة
// ==========================
async function confirmTransaction(expectedSeqno, maxWaitMs = 60000) {
  const start = Date.now();
  console.log(`🔍 Waiting for seqno ${expectedSeqno + 1} to confirm...`);
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const { contract } = await getWallet();
      const currentSeqno = await contract.getSeqno();
      if (currentSeqno > expectedSeqno) {
        console.log(`✅ Seqno confirmed: ${expectedSeqno} → ${currentSeqno}`);
        return true;
      }
    } catch (e) { console.log(`⚠️ seqno check error: ${e.message}`); }
  }
  console.log(`⚠️ Seqno confirmation timeout after ${maxWaitMs / 1000}s`);
  return false;
}

// ==========================
// 🔹 إرسال TON مع إعادة المحاولة + تأكيد على الشبكة
// ==========================
async function sendTONWithRetry(toAddress, amount, retryCount = 0) {
  const roundedAmount = roundAmount(amount);
  if (roundedAmount <= 0) throw new Error(`Invalid amount: ${roundedAmount}`);

  const balanceCheck = await checkSufficientBalance(roundedAmount);
  if (!balanceCheck.sufficient)
    throw new Error(`Insufficient balance: ${balanceCheck.balance.toFixed(3)} TON needed ${roundedAmount} TON`);

  try {
    const { contract, key } = await getWallet();
    const seqno      = await contract.getSeqno();
    const nanoAmount = toNano(roundedAmount.toFixed(3));

    await new Promise(r => setTimeout(r, 2000));
    await contract.sendTransfer({
      secretKey: key.secretKey, seqno,
      messages: [internal({ to: toAddress, value: nanoAmount, bounce: true })],
    });
    console.log(`📤 Transfer submitted — seqno: ${seqno}`);

    // ✅ انتظر تأكيد الـ seqno على الشبكة (حتى 60 ثانية)
    const confirmed = await confirmTransaction(seqno, 60000);
    if (!confirmed) {
      throw new Error(`Transaction not confirmed on-chain within 60s (seqno ${seqno}) — may be pending or dropped`);
    }

    // جلب tx hash بعد التأكيد
    let txHash = null;
    try {
      await new Promise(r => setTimeout(r, 3000));
      const txRes  = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${walletAddress}&limit=5`, { headers: { "X-API-Key": process.env.TON_API_KEY } });
      const txData = await txRes.json();
      if (txData.result?.length > 0) txHash = txData.result[0].transaction_id.hash;
    } catch (e) { console.log(`⚠️ tx hash fetch failed: ${e.message}`); }

    console.log(`✅ Transaction confirmed on-chain${txHash ? ' | hash: ' + txHash.substring(0, 10) + '...' : ''}`);
    return { amount: roundedAmount, txHash };

  } catch (error) {
    console.log(`❌ Attempt ${retryCount + 1} failed: ${error.message}`);
    // لا نعيد المحاولة لو المشكلة في التأكيد — المعاملة ممكن تكون اتبعتت فعلاً
    const isNetworkRetryable = retryCount < MAX_RETRIES - 1 &&
      (error.message.includes('500') || error.message.includes('timeout') || error.message.includes('network')) &&
      !error.message.includes('not confirmed on-chain');
    if (isNetworkRetryable) {
      await new Promise(r => setTimeout(r, RETRY_DELAY * (retryCount + 1)));
      return sendTONWithRetry(toAddress, amount, retryCount + 1);
    }
    throw error;
  }
}

// ==========================
// 🔹 إشعار المستخدم
// ==========================
async function sendUserNotification(chatId, amountTon, amountCoins, txHash) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chatId) return false;
  const txLink  = txHash ? `https://tonscan.org/tx/${encodeURIComponent(txHash)}` : null;
  const caption =
    `🐼 <b>Panda Treasury Released!</b>\n\nWithdrawal Successful ✅\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `💰 <b>Amount:</b> ${amountTon.toFixed(6)} TON\n` +
    `🪙 <b>Bamboo Used:</b> ${Number(amountCoins).toLocaleString()}\n` +
    (txHash ? `🔑 <b>TxID:</b> <code>${txHash}</code>\n` : ``) +
    `━━━━━━━━━━━━━━━━\n\n` +
    `The panda warriors have delivered your reward from the Bamboo Empire treasury.\n\n` +
    `Thank you for being part of Panda Bamboo Factory. 🎋`;
  const keys = [];
  if (txLink) keys.push({ text: "🔍 View TX", url: txLink });
  keys.push({ text: "🐼 Open App", url: "https://t.me/PandaBamboBot?startapp=" });
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: "https://i.supaimg.com/ec27537b-aa6a-42cf-8ba1-d6850eeea36d/7c71ad42-e22a-4e4d-86a4-a636b8b7d3a1.jpg",
        caption, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [keys] }
      }),
    });
    const data = await res.json();
    if (data.ok) { console.log(`✅ User notified: ${chatId}`); return true; }
    console.log(`❌ Telegram: ${data.description}`); return false;
  } catch (e) { console.log(`❌ sendUserNotification: ${e.message}`); return false; }
}

// ==========================
// 🔹 إشعار قناة المدفوعات
// ==========================
async function sendChannelNotification(amountTon, txHash, userId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  const txLink = txHash ? `https://tonscan.org/tx/${encodeURIComponent(txHash)}` : null;

  // إخفاء جزء من User ID: 7236875323 → 723******23
  let maskedId = userId || 'Unknown';
  if (userId && userId.length > 5) {
    const uid = String(userId);
    maskedId = uid.substring(0, 3) + '*'.repeat(uid.length - 5) + uid.substring(uid.length - 2);
  }

  const caption =
    `🐼 <b>Bamboo Withdrawal Successful!</b>\n\n` +
    `👤 User: <b>${maskedId}</b>\n` +
    `💰 Amount: <b>${amountTon.toFixed(7)} TON</b>\n` +
    (txLink ? `🔗 TxID: <a href="${txLink}">${txHash.substring(0, 8)}...${txHash.substring(txHash.length - 6)}</a>` : ``);

  const keys = [];
  if (txLink) keys.push({ text: "🔍 View TX", url: txLink });
  keys.push({ text: "🐼 Open App", url: "https://t.me/PandaBamboBot?startapp=" });
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: "@PandaBambooPayouts",
        photo: "https://i.supaimg.com/ec27537b-aa6a-42cf-8ba1-d6850eeea36d/7c71ad42-e22a-4e4d-86a4-a636b8b7d3a1.jpg",
        caption, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [keys] }
      }),
    });
    console.log(`✅ Channel notified`);
  } catch (e) { console.log(`❌ sendChannelNotification: ${e.message}`); }
}

// ==========================
// 🔹 تحديث wdHistory داخل المستخدم
// ==========================
async function updateUserWdHistory(userId, wdId, txHash, amountTon) {
  if (!userId || !wdId) return;
  try {
    await db.ref(`users/${userId}/wdHistory/${wdId}`).update({
      status:      "paid",
      txHash:      txHash || null,
      sentAmount:  amountTon,
      paidAt:      Date.now(),
    });
    console.log(`✅ wdHistory updated: users/${userId}/wdHistory/${wdId}`);
  } catch (e) {
    console.log(`❌ updateUserWdHistory: ${e.message}`);
  }
}

// ==========================
// 🔹 معالجة سحب واحد
// ==========================
async function processWithdrawal(withdrawId, data) {
  console.log("\n" + "=".repeat(40) + `\n🔄 ${withdrawId}\n` + "=".repeat(40));
  try {
    // تحقق من البيانات
    if (!data?.address || !data?.ton) {
      await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "failed", error: "Invalid data", updatedAt: Date.now() });
      return true;
    }

    const roundedAmount = roundAmount(data.ton);
    const userId        = data.userId || null;
    const wdId          = data.wdId   || withdrawId;
    const amountCoins   = data.amt    || 0;

    // تحقق من العنوان — فشل نهائي لأنه لن يتصلح
    if (!data.address.startsWith("EQ") && !data.address.startsWith("UQ")) {
      await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "failed", error: "Invalid TON address", updatedAt: Date.now() });
      if (userId && wdId) await db.ref(`users/${userId}/wdHistory/${wdId}`).update({ status: "failed", updatedAt: Date.now() });
      return true;
    }

    // 🚫 فحص حظر المستخدم
    if (userId && await isUserBanned(userId)) {
      console.log(`🚫 Banned user: ${userId} — cancelling ${withdrawId}`);
      await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", error: "User is banned", updatedAt: Date.now() });
      if (wdId) await db.ref(`users/${userId}/wdHistory/${wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
      return true;
    }

    // 🚫 فحص حظر المحفظة
    if (await isWalletBanned(data.address)) {
      console.log(`🚫 Banned wallet: ${data.address} — cancelling ${withdrawId}`);
      await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", error: "Wallet is banned", updatedAt: Date.now() });
      if (userId && wdId) await db.ref(`users/${userId}/wdHistory/${wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
      return true;
    }

    // ⏳ لو الطلب بانتظار موافقة الأدمن — لا تعالجه تلقائياً
    if (data.status === 'awaiting_approval') {
      console.log(`⏳ ${withdrawId} awaiting admin approval — skipping auto-process`);
      return false;
    }

    // 📅 فحص عدد السحوبات اليومية
    if (userId) {
      const dailyCount = await getUserDailyWithdrawalCount(userId);
      if (dailyCount > 2) {
        console.log(`📅 User ${userId} exceeded daily limit (${dailyCount} withdrawals) — awaiting approval`);
        await db.ref(`withdrawQueue/${withdrawId}`).update({
          status:    "awaiting_approval",
          updatedAt: Date.now(),
          holdReason: `تجاوز الحد اليومي — ${dailyCount} سحوبات اليوم`,
        });
        if (botInstance) await sendAdminApprovalRequest(botInstance, withdrawId, data, dailyCount);
        return false;
      }
    }

    // تحقق من الحدود — نتركه pending لأن الأدمن قد يغير الحد لاحقاً
    if (roundedAmount > MAX_WITHDRAWAL_AMOUNT) {
      console.log(`⏸ ${withdrawId} exceeds max (${roundedAmount} > ${MAX_WITHDRAWAL_AMOUNT} TON) — keeping pending`);
      await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", error: `Exceeds max ${MAX_WITHDRAWAL_AMOUNT} TON — waiting`, updatedAt: Date.now() });
      return false;
    }
    if (roundedAmount < MIN_WITHDRAWAL_AMOUNT) {
      console.log(`⏸ ${withdrawId} below min (${roundedAmount} < ${MIN_WITHDRAWAL_AMOUNT} TON) — keeping pending`);
      await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", error: `Below min ${MIN_WITHDRAWAL_AMOUNT} TON — waiting`, updatedAt: Date.now() });
      return false;
    }

    // 🔒 قفل ذري — لو سحبين وصلوا في نفس اللحظة، واحد بس يفوز بالقفل
    let locked = false;
    await db.ref(`withdrawQueue/${withdrawId}`).transaction((current) => {
      if (!current || current.status !== "pending") return; // abort — شخص تاني أخذه
      locked = true;
      return { ...current, status: "processing", updatedAt: Date.now(), attempts: (current.attempts || 0) + 1 };
    });
    if (!locked) {
      console.log(`⏭️ ${withdrawId} already taken by another process — skipping`);
      return false;
    }

    // إرسال TON
    const result = await sendTONWithRetry(data.address, roundedAmount);

    // ✅ تحديث withdrawQueue → paid
    await db.ref(`withdrawQueue/${withdrawId}`).update({
      status:      "paid",
      updatedAt:   Date.now(),
      completedAt: Date.now(),
      txHash:      result.txHash || null,
      sentAmount:  result.amount,
    });

    // ✅ تحديث wdHistory داخل المستخدم → paid
    await updateUserWdHistory(userId, wdId, result.txHash, result.amount);

    console.log(`✅ Done: ${withdrawId}`);

    // إشعار المستخدم
    if (userId) {
      await sendUserNotification(userId, result.amount, amountCoins, result.txHash);
    } else {
      console.log(`⚠️ No userId for ${withdrawId} — skipping user notification`);
    }

    // إشعار القناة
    await sendChannelNotification(result.amount, result.txHash, userId);
    return true;

  } catch (error) {
    console.log(`❌ processWithdrawal: ${error.message}`);
    const attempts = (data.attempts || 0) + 1;
    // دايماً pending — مش failed — عشان يتعالج مرة تانية
    await db.ref(`withdrawQueue/${withdrawId}`).update({
      status: "pending", updatedAt: Date.now(), lastError: error.message, attempts
    });
    return false;
  }
}

// ==========================
// 🔹 معالجة السحوبات المعلقة
// ==========================
async function processPendingWithdrawals() {
  if (systemPaused) { console.log("⏸️ Paused — skipping"); return; }
  if (isProcessing)  { console.log("⚠️ Already processing — skipping"); return; }
  try {
    isProcessing = true;
    const snapshot    = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value");
    const withdrawals = snapshot.val();
    if (!withdrawals) { console.log("📭 No pending withdrawals"); isProcessing = false; return; }

    const list = Object.entries(withdrawals)
      .filter(([id, d]) => !processingQueue.has(id))
      .map(([id, d]) => ({ id, data: d, timestamp: d.ts || d.timestamp || 0 }))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (!list.length) { isProcessing = false; return; }
    console.log(`📋 ${list.length} pending withdrawals`);

    for (let i = 0; i < list.length; i++) {
      const { id, data } = list[i];
      if (processingQueue.has(id)) continue;
      processingQueue.add(id);
      try {
        const check = await checkSufficientBalance(roundAmount(data.ton));
        if (!check.sufficient) {
          console.log(`⏭️ Insufficient balance (${check.balance.toFixed(3)} TON) — stopping`);
          break;
        }
        await processWithdrawal(id, data);
        if (i < list.length - 1) await new Promise(r => setTimeout(r, BATCH_DELAY));
      } catch (e) { console.log(`❌ Error in ${id}: ${e.message}`); }
      finally { processingQueue.delete(id); }
    }
  } catch (e) { console.log(`❌ processPendingWithdrawals: ${e.message}`); }
  finally { isProcessing = false; console.log("✅ Batch done"); }
}

// ==========================
// 🔹 بوت الترحيب + أوامر الأدمن
// ==========================
function startWelcomeBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) { console.log("⚠️ TELEGRAM_BOT_TOKEN missing"); return; }

  const bot = new TelegramBot(botToken, { polling: true });
  botInstance = bot;

  const isAdmin = (msg) => msg.chat.id.toString() === ADMIN_CHAT_ID;
  const unauth  = async (msg) => await bot.sendMessage(msg.chat.id, "⛔ Unauthorized");

  // ─── /start ───────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId    = msg.chat.id;
    const firstName = msg.from.first_name || "Warrior";
    console.log(`👋 /start: ${chatId}`);
    await adminReply(bot, chatId,
      `Hey ${firstName}! 👋 You've just joined the coolest virtual factory on Telegram.\n\n` +
      `🎁 <b>Your starter pack is ready:</b>\n• 200 Coins — free to withdraw right away\n• 100 Bamboo/day — free mining starts immediately\n\n` +
      `⚙️ <b>How it works:</b>\n1️⃣ Mine — Bamboo accumulates in your tank automatically\n2️⃣ Exchange — Convert Bamboo → Coins in Finance\n3️⃣ Withdraw — Send Coins to your TON wallet 💎\n\n` +
      `🚀 <b>Boost your earnings:</b>\n— Buy machines from the Market to increase daily output\n— Complete Tasks for bonus Bamboo & Coins\n— Invite friends and earn 20% commission on their purchases`,
      { reply_markup: { inline_keyboard: [
        [{ text: "🐼 Open App", url: "https://t.me/PandaBamboBot?startapp=" }],
        [{ text: "📢 News", url: "https://t.me/PandaMiningNews" }, { text: "💸 Payouts", url: "https://t.me/PandaBambooPayouts" }]
      ]}}
    );
  });

  // ─── /help ────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    if (!isAdmin(msg)) return;
    await adminReply(bot, msg.chat.id,
      `🐼 <b>Panda Bamboo — Admin Commands</b>\n` +
      `${'─'.repeat(30)}\n\n` +

      `📊 <b>المعلومات والمراقبة</b>\n` +
      `/status — حالة النظام الكاملة (رصيد، pending، paid، failed، الحدود)\n` +
      `/balance — رصيد المحفظة + عدد السحوبات المعلقة وإجماليها\n` +
      `/checkbalance — فحص الرصيد الفوري للمحفظة\n` +
      `/checkuser <code>[userId]</code> — تقرير مفصّل لمستخدم: إيداعاته، سحوباته، إحالاته، رصيده\n\n` +

      `📋 <b>إدارة قائمة السحوبات</b>\n` +
      `/queue — عرض السحوبات المعلقة (pending) مرتبة من الأقدم\n` +
      `/queueall — آخر 30 سحب بكل الحالات (pending / paid / failed)\n` +
      `/pending_reasons — السحوبات المعلقة مع سبب تعليق كل واحدة بالتفصيل\n` +
      `/process — تشغيل دورة المعالجة يدوياً الآن\n` +
      `/cancel <code>[wdId]</code> — إلغاء سحب معلق بالـ ID\n\n` +

      `⚙️ <b>ضبط الحدود والإعدادات</b>\n` +
      `/setmax <code>[TON]</code> — تغيير الحد الأقصى للسحب الواحد\n` +
      `/setmin <code>[TON]</code> — تغيير الحد الأدنى للسحب الواحد\n` +
      `/setbuffer <code>[TON]</code> — هامش الأمان المحجوز في المحفظة\n` +
      `/setrate <code>[N]</code> — سعر الصرف (1 TON = N Bamboo)\n\n` +

      `⏸ <b>التحكم في النظام</b>\n` +
      `/pause — إيقاف المعالجة التلقائية مؤقتاً\n` +
      `/resume — استئناف المعالجة التلقائية\n\n` +

      `🚫 <b>الحظر وفك الحظر</b>\n` +
      `/banuser <code>[userId]</code> — حظر مستخدم (تُلغى سحوباته تلقائياً)\n` +
      `/unbanuser <code>[userId]</code> — فك حظر مستخدم\n` +
      `/banwallet <code>[address]</code> — حظر محفظة TON بعينها\n` +
      `/unbanwallet <code>[address]</code> — فك حظر محفظة\n` +
      `/banlists — عرض كل المستخدمين والمحافظ المحظورة\n\n` +

      `${'─'.repeat(30)}\n` +
      `💡 <b>ملاحظات:</b>\n` +
      `• السحب الثالث فأكثر في اليوم يحتاج موافقتك\n` +
      `• الموافقة/الرفض بيجيلك زرار مباشرةً في الرسالة\n` +
      `• المعالجة التلقائية كل 60 ثانية + تأخير 30ث بين كل سحب`
    );
  });

  // ─── /status ──────────────────────────────────────────
  bot.onText(/\/status/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const balance     = await getWalletBalance();
    const pendingSnap = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value");
    const paidSnap    = await db.ref("withdrawQueue").orderByChild("status").equalTo("paid").once("value");
    const failedSnap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("failed").once("value");
    await adminReply(bot, msg.chat.id,
      `📊 <b>System Status</b>\n\n` +
      `${systemPaused ? '⏸ <b>PAUSED</b>' : '✅ <b>Active</b>'}\n\n` +
      `💰 Balance: <b>${balance.toFixed(4)} TON</b>\n` +
      `📋 Pending: <b>${pendingSnap.numChildren()}</b>\n` +
      `✅ Paid: <b>${paidSnap.numChildren()}</b>\n` +
      `❌ Failed: <b>${failedSnap.numChildren()}</b>\n` +
      `🔁 Processing now: <b>${isProcessing ? 'Yes' : 'No'}</b>\n\n` +
      `🔼 Max withdrawal: <b>${MAX_WITHDRAWAL_AMOUNT} TON</b>\n` +
      `🔽 Min withdrawal: <b>${MIN_WITHDRAWAL_AMOUNT} TON</b>\n` +
      `🛡 Safety buffer: <b>${MAX_BALANCE_BUFFER} TON</b>\n` +
      `💱 Rate: <b>1 TON = ${BAMBOO_TO_TON_RATE.toLocaleString()} Bamboo</b>`
    );
  });

  // ─── /balance ─────────────────────────────────────────
  bot.onText(/\/balance/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const balance     = await getWalletBalance();
      const pendingSnap = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value");
      let totalPending  = 0;
      pendingSnap.forEach(c => { totalPending += roundAmount(c.val().ton || 0); });
      await adminReply(bot, msg.chat.id,
        `💰 <b>Wallet</b>\n\n` +
        `Balance: <b>${balance.toFixed(4)} TON</b>\n` +
        `Pending withdrawals: <b>${pendingSnap.numChildren()}</b>\n` +
        `Total pending: <b>${totalPending.toFixed(4)} TON</b>\n` +
        `After processing: <b>${(balance - totalPending).toFixed(4)} TON</b>\n\n` +
        `<a href="https://tonviewer.com/${walletAddress}">View Wallet</a>`
      );
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /checkbalance ────────────────────────────────────
  bot.onText(/\/checkbalance/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const balance = await getWalletBalance();
    await adminReply(bot, msg.chat.id, `💰 الرصيد الحالي: <b>${balance.toFixed(4)} TON</b>`);
  });

  // ─── /setmax [value] ──────────────────────────────────
  bot.onText(/\/setmax(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const val = parseFloat(match[1]);
    if (isNaN(val) || val <= 0) {
      await adminReply(bot, msg.chat.id, `❌ الاستخدام: /setmax <code>20</code>\nالحالي: <b>${MAX_WITHDRAWAL_AMOUNT} TON</b>`);
      return;
    }
    MAX_WITHDRAWAL_AMOUNT = val;
    await adminReply(bot, msg.chat.id, `✅ الحد الأقصى للسحب → <b>${val} TON</b>`);
  });

  // ─── /setmin [value] ──────────────────────────────────
  bot.onText(/\/setmin(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const val = parseFloat(match[1]);
    if (isNaN(val) || val <= 0) {
      await adminReply(bot, msg.chat.id, `❌ الاستخدام: /setmin <code>0.5</code>\nالحالي: <b>${MIN_WITHDRAWAL_AMOUNT} TON</b>`);
      return;
    }
    MIN_WITHDRAWAL_AMOUNT = val;
    await adminReply(bot, msg.chat.id, `✅ الحد الأدنى للسحب → <b>${val} TON</b>`);
  });

  // ─── /setbuffer [value] ───────────────────────────────
  bot.onText(/\/setbuffer(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const val = parseFloat(match[1]);
    if (isNaN(val) || val < 0) {
      await adminReply(bot, msg.chat.id, `❌ الاستخدام: /setbuffer <code>0.1</code>\nالحالي: <b>${MAX_BALANCE_BUFFER} TON</b>`);
      return;
    }
    MAX_BALANCE_BUFFER = val;
    await adminReply(bot, msg.chat.id, `✅ هامش الأمان → <b>${val} TON</b>`);
  });

  // ─── /setrate [value] ─────────────────────────────────
  bot.onText(/\/setrate(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const val = parseFloat(match[1]);
    if (isNaN(val) || val <= 0) {
      await adminReply(bot, msg.chat.id, `❌ الاستخدام: /setrate <code>10000</code>\nالحالي: 1 TON = <b>${BAMBOO_TO_TON_RATE.toLocaleString()} Bamboo</b>`);
      return;
    }
    BAMBOO_TO_TON_RATE = val;
    await adminReply(bot, msg.chat.id, `✅ سعر الصرف → 1 TON = <b>${val.toLocaleString()} Bamboo</b>`);
  });

  // ─── /pause ───────────────────────────────────────────
  bot.onText(/\/pause/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    if (systemPaused) { await adminReply(bot, msg.chat.id, "⏸ النظام متوقف بالفعل"); return; }
    systemPaused = true;
    await adminReply(bot, msg.chat.id, "⏸ <b>تم إيقاف المعالجة التلقائية</b>\n\nاستخدم /resume للاستئناف");
  });

  // ─── /resume ──────────────────────────────────────────
  bot.onText(/\/resume/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    if (!systemPaused) { await adminReply(bot, msg.chat.id, "✅ النظام يعمل بالفعل"); return; }
    systemPaused = false;
    await adminReply(bot, msg.chat.id, "✅ <b>تم استئناف المعالجة</b>\n\nجاري معالجة السحوبات المعلقة...");
    setTimeout(() => processPendingWithdrawals(), 1000);
  });

  // ─── /queue ───────────────────────────────────────────
  bot.onText(/\/queue/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا يوجد سحوبات معلقة"); return; }
      const list     = Object.entries(items).map(([id, d]) => ({ id, ...d })).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      let text       = `📋 <b>Pending (${list.length})</b>\n\n`;
      let totalTon   = 0;
      list.slice(0, 20).forEach((w, i) => {
        const ton  = roundAmount(w.ton);
        totalTon  += ton;
        const time = w.ts ? new Date(w.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';
        text += `${i + 1}. <code>${w.userId || '?'}</code> | <b>${ton} TON</b> | ${w.amt || 0} coins | ${time}\n`;
      });
      if (list.length > 20) text += `\n...و ${list.length - 20} أخرى\n`;
      text += `\n💰 <b>الإجمالي: ${totalTon.toFixed(4)} TON</b>`;
      await adminReply(bot, msg.chat.id, text);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /queueall ────────────────────────────────────────
  bot.onText(/\/queueall/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").limitToLast(30).once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 القائمة فارغة"); return; }
      const list = Object.entries(items).map(([id, d]) => ({ id, ...d })).sort((a, b) => (b.ts || 0) - (a.ts || 0));
      const statusIcon = { pending: '⏳', processing: '🔄', paid: '✅', failed: '❌' };
      let text = `📋 <b>آخر ${list.length} سحب</b>\n\n`;
      list.slice(0, 20).forEach((w, i) => {
        const icon = statusIcon[w.status] || '❓';
        const ton  = roundAmount(w.ton);
        text += `${icon} <code>${w.userId || '?'}</code> | <b>${ton} TON</b> | ${w.status}\n`;
      });
      await adminReply(bot, msg.chat.id, text);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /cancel [wdId] ───────────────────────────────────
  bot.onText(/\/cancel(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const wdId = (match[1] || '').trim();
    if (!wdId) { await adminReply(bot, msg.chat.id, `❌ الاستخدام: /cancel <code>wd_xxx_xxx</code>`); return; }
    try {
      const snap = await db.ref(`withdrawQueue/${wdId}`).once("value");
      const data = snap.val();
      if (!data) { await adminReply(bot, msg.chat.id, `❌ لم يُعثر على السحب: <code>${wdId}</code>`); return; }
      if (data.status !== "pending") { await adminReply(bot, msg.chat.id, `⚠️ لا يمكن إلغاؤه — الحالة الحالية: <b>${data.status}</b>`); return; }
      await db.ref(`withdrawQueue/${wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
      if (data.userId && data.wdId) {
        await db.ref(`users/${data.userId}/wdHistory/${data.wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
      }
      await adminReply(bot, msg.chat.id, `✅ تم إلغاء السحب: <code>${wdId}</code>\nالمستخدم: <code>${data.userId || '?'}</code> | ${roundAmount(data.ton)} TON`);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /process ─────────────────────────────────────────
  bot.onText(/\/process/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    if (systemPaused) { await adminReply(bot, msg.chat.id, "⏸ النظام متوقف — استخدم /resume أولاً"); return; }
    await adminReply(bot, msg.chat.id, "🔄 جاري المعالجة...");
    await processPendingWithdrawals();
    await adminReply(bot, msg.chat.id, "✅ انتهت المعالجة");
  });

  // ─── /banwallet [address] ─────────────────────────────
  bot.onText(/\/banwallet(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const address = (match[1] || '').trim();
    if (!address) {
      await adminReply(bot, msg.chat.id, `❌ الاستخدام: /banwallet <code>EQxxx...</code>`);
      return;
    }
    const key = address.replace(/[.$#[\]/]/g, '_');
    await db.ref(`bannedWallets/${key}`).set({ address, bannedAt: Date.now() });
    console.log(`🚫 Wallet banned: ${address}`);
    await adminReply(bot, msg.chat.id, `🚫 <b>تم حظر المحفظة:</b>\n<code>${address}</code>\n\nأي سحب لهذه المحفظة سيُلغى تلقائياً.`);
  });

  // ─── /unbanwallet [address] ───────────────────────────
  bot.onText(/\/unbanwallet(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const address = (match[1] || '').trim();
    if (!address) {
      await adminReply(bot, msg.chat.id, `❌ الاستخدام: /unbanwallet <code>EQxxx...</code>`);
      return;
    }
    const key = address.replace(/[.$#[\]/]/g, '_');
    const snap = await db.ref(`bannedWallets/${key}`).once("value");
    if (!snap.exists()) {
      await adminReply(bot, msg.chat.id, `⚠️ المحفظة غير محظورة:\n<code>${address}</code>`);
      return;
    }
    await db.ref(`bannedWallets/${key}`).remove();
    console.log(`✅ Wallet unbanned: ${address}`);
    await adminReply(bot, msg.chat.id, `✅ <b>تم فك حظر المحفظة:</b>\n<code>${address}</code>`);
  });

  // ─── /banuser [userId] ────────────────────────────────
  bot.onText(/\/banuser(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const userId = (match[1] || '').trim();
    if (!userId) {
      await adminReply(bot, msg.chat.id, `❌ الاستخدام: /banuser <code>123456789</code>`);
      return;
    }
    await db.ref(`bannedUsers/${userId}`).set({ userId, bannedAt: Date.now() });
    console.log(`🚫 User banned: ${userId}`);
    await adminReply(bot, msg.chat.id, `🚫 <b>تم حظر المستخدم:</b> <code>${userId}</code>\n\nأي سحب لهذا المستخدم سيُلغى تلقائياً.`);
  });

  // ─── /unbanuser [userId] ──────────────────────────────
  bot.onText(/\/unbanuser(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const userId = (match[1] || '').trim();
    if (!userId) {
      await adminReply(bot, msg.chat.id, `❌ الاستخدام: /unbanuser <code>123456789</code>`);
      return;
    }
    const snap = await db.ref(`bannedUsers/${userId}`).once("value");
    if (!snap.exists()) {
      await adminReply(bot, msg.chat.id, `⚠️ المستخدم غير محظور: <code>${userId}</code>`);
      return;
    }
    await db.ref(`bannedUsers/${userId}`).remove();
    console.log(`✅ User unbanned: ${userId}`);
    await adminReply(bot, msg.chat.id, `✅ <b>تم فك حظر المستخدم:</b> <code>${userId}</code>`);
  });

  // ─── /checkuser [userId] ──────────────────────────────
  bot.onText(/\/checkuser(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const userId = (match[1] || '').trim();
    if (!userId) {
      await adminReply(bot, msg.chat.id, `❌ الاستخدام: /checkuser <code>123456789</code>`);
      return;
    }
    try {
      await adminReply(bot, msg.chat.id, `🔍 جاري جلب بيانات المستخدم <code>${userId}</code>...`);

      // ── جلب كل البيانات بالتوازي ──
      const [depositsSnap, wdQueueSnap, referralsSnap, userSnap, bannedSnap] = await Promise.all([
        db.ref(`users/${userId}/deposits`).once("value"),
        db.ref("withdrawQueue").orderByChild("userId").equalTo(userId).once("value"),
        db.ref(`users/${userId}/referrals`).once("value"),
        db.ref(`users/${userId}`).once("value"),
        db.ref(`bannedUsers/${userId}`).once("value"),
      ]);

      // ── إجمالي الإيداعات ──
      let totalDeposits    = 0;
      let depositCount     = 0;
      let lastDepositDate  = null;
      if (depositsSnap.exists()) {
        depositsSnap.forEach(child => {
          const d = child.val();
          totalDeposits += Number(d.amount || 0);
          depositCount++;
          const ts = d.timestamp || 0;
          if (!lastDepositDate || ts > lastDepositDate) lastDepositDate = ts;
        });
      }

      // ── إجمالي السحوبات (مقسّمة حسب الحالة) ──
      let totalPaid        = 0;  let paidCount    = 0;
      let totalPending     = 0;  let pendingCount = 0;
      let totalCancelled   = 0;  let cancelCount  = 0;
      let awaitingCount    = 0;
      let lastWdDate       = null;

      if (wdQueueSnap.exists()) {
        wdQueueSnap.forEach(child => {
          const d   = child.val();
          const amt = roundAmount(d.ton || 0);
          const ts  = d.ts || d.timestamp || 0;
          if (!lastWdDate || ts > lastWdDate) lastWdDate = ts;

          if (d.status === 'paid')               { totalPaid      += amt; paidCount++;    }
          else if (d.status === 'pending')        { totalPending   += amt; pendingCount++; }
          else if (d.status === 'cancelled')      { totalCancelled += amt; cancelCount++;  }
          else if (d.status === 'awaiting_approval') { totalPending += amt; awaitingCount++; }
        });
      }

      // ── الإحالات ──
      const referralCount = referralsSnap.exists() ? Object.keys(referralsSnap.val()).length : 0;

      // ── بيانات المستخدم الأساسية ──
      const userData   = userSnap.val() || {};
      const balance    = userData.balance    || userData.coins   || 0;
      const bamboo     = userData.bamboo     || 0;
      const isBanned   = bannedSnap.exists();

      // ── السحوبات المعلقة التفصيلية ──
      let pendingDetails = '';
      if (wdQueueSnap.exists()) {
        const pendingList = [];
        wdQueueSnap.forEach(child => {
          const d = child.val();
          if (['pending', 'awaiting_approval'].includes(d.status)) {
            pendingList.push({ id: child.key, ...d });
          }
        });
        if (pendingList.length > 0) {
          pendingDetails = `\n📋 <b>السحوبات المعلقة:</b>\n`;
          pendingList.slice(0, 5).forEach(w => {
            const statusLabel = w.status === 'awaiting_approval' ? '⏳ بانتظار موافقة' : '🔄 pending';
            const reason = w.holdReason || w.lastError || w.error || '—';
            pendingDetails +=
              `  • <code>${w.id}</code> | ${roundAmount(w.ton)} TON | ${statusLabel}\n` +
              `    ⚠️ ${reason}\n`;
          });
          if (pendingList.length > 5) pendingDetails += `  ... و ${pendingList.length - 5} أخرى\n`;
        }
      }

      // ── بناء الرسالة ──
      const formatDate = (ts) => ts ? new Date(ts).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC' : '—';
      const netFlow    = totalDeposits - totalPaid;

      let text =
        `👤 <b>تقرير المستخدم</b>\n` +
        `🆔 <code>${userId}</code>${isBanned ? '  🚫 <b>محظور</b>' : ''}\n\n` +

        `━━━━ 💰 الإيداعات ━━━━\n` +
        `📥 عدد الإيداعات: <b>${depositCount}</b>\n` +
        `💵 إجمالي المُودع: <b>${totalDeposits.toFixed(4)} TON</b>\n` +
        (lastDepositDate ? `🕐 آخر إيداع: ${formatDate(lastDepositDate)}\n` : '') +

        `\n━━━━ 💸 السحوبات ━━━━\n` +
        `✅ مدفوعة: <b>${paidCount} سحب</b> = <b>${totalPaid.toFixed(4)} TON</b>\n` +
        `🔄 معلقة: <b>${pendingCount + awaitingCount} سحب</b> = <b>${totalPending.toFixed(4)} TON</b>\n` +
        (awaitingCount > 0 ? `⏳ بانتظار موافقة: <b>${awaitingCount}</b>\n` : '') +
        `❌ ملغية: <b>${cancelCount} سحب</b>\n` +
        (lastWdDate ? `🕐 آخر سحب: ${formatDate(lastWdDate)}\n` : '') +

        `\n━━━━ 📊 الملخص ━━━━\n` +
        `🔄 صافي التدفق: <b>${netFlow >= 0 ? '+' : ''}${netFlow.toFixed(4)} TON</b>\n` +
        `👥 الإحالات: <b>${referralCount}</b>\n` +
        (balance ? `🪙 رصيد Coins: <b>${Number(balance).toLocaleString()}</b>\n` : '') +
        (bamboo  ? `🎋 رصيد Bamboo: <b>${Number(bamboo).toLocaleString()}</b>\n` : '') +

        pendingDetails;

      await adminReply(bot, msg.chat.id, text);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /banlists ────────────────────────────────────────
  bot.onText(/\/banlists/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const [walletsSnap, usersSnap] = await Promise.all([
        db.ref("bannedWallets").once("value"),
        db.ref("bannedUsers").once("value"),
      ]);
      const wallets = walletsSnap.val() ? Object.values(walletsSnap.val()) : [];
      const users   = usersSnap.val()   ? Object.values(usersSnap.val())   : [];

      let text = `🚫 <b>قوائم الحظر</b>\n\n`;
      text += `💳 <b>محافظ محظورة (${wallets.length}):</b>\n`;
      if (wallets.length === 0) text += `— لا يوجد\n`;
      else wallets.forEach(w => { text += `• <code>${w.address}</code>\n`; });

      text += `\n👤 <b>مستخدمون محظورون (${users.length}):</b>\n`;
      if (users.length === 0) text += `— لا يوجد\n`;
      else users.forEach(u => { text += `• <code>${u.userId}</code>\n`; });

      await adminReply(bot, msg.chat.id, text);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── Callback: موافقة / رفض السحب ────────────────────
  bot.on('callback_query', async (query) => {
    if (query.message.chat.id.toString() !== ADMIN_CHAT_ID) return;
    const data   = query.data || '';
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;

    // ── موافقة ──
    if (data.startsWith('approve_wd:')) {
      const withdrawId = data.replace('approve_wd:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once("value");
        const wd   = snap.val();
        if (!wd) { await bot.answerCallbackQuery(query.id, { text: "❌ السحب غير موجود!" }); return; }
        if (wd.status !== 'awaiting_approval') {
          await bot.answerCallbackQuery(query.id, { text: `⚠️ الحالة الحالية: ${wd.status}` });
          return;
        }
        // ارجع لـ pending عشان processPendingWithdrawals تشتغل بس ضع علم approved
        await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", approvedByAdmin: true, updatedAt: Date.now(), holdReason: null });
        await bot.editMessageText(
          query.message.text + `\n\n✅ <b>تمت الموافقة</b> — جاري الدفع...`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
        );
        await bot.answerCallbackQuery(query.id, { text: "✅ تمت الموافقة — سيتم الدفع الآن" });
        console.log(`✅ Admin approved: ${withdrawId}`);
        // شغّل المعالجة فوراً
        setTimeout(() => processPendingWithdrawals(), 1000);
      } catch (e) {
        await bot.answerCallbackQuery(query.id, { text: `❌ خطأ: ${e.message}` });
        console.log(`❌ approve_wd error: ${e.message}`);
      }
    }

    // ── رفض ──
    if (data.startsWith('reject_wd:')) {
      const withdrawId = data.replace('reject_wd:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once("value");
        const wd   = snap.val();
        if (!wd) { await bot.answerCallbackQuery(query.id, { text: "❌ السحب غير موجود!" }); return; }
        if (wd.status !== 'awaiting_approval') {
          await bot.answerCallbackQuery(query.id, { text: `⚠️ الحالة الحالية: ${wd.status}` });
          return;
        }
        await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", updatedAt: Date.now(), holdReason: "رُفض من الأدمن" });
        if (wd.userId && wd.wdId) {
          await db.ref(`users/${wd.userId}/wdHistory/${wd.wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
        }
        await bot.editMessageText(
          query.message.text + `\n\n❌ <b>تم الرفض والإلغاء</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
        );
        await bot.answerCallbackQuery(query.id, { text: "❌ تم رفض وإلغاء السحب" });
        console.log(`❌ Admin rejected: ${withdrawId}`);
      } catch (e) {
        await bot.answerCallbackQuery(query.id, { text: `❌ خطأ: ${e.message}` });
        console.log(`❌ reject_wd error: ${e.message}`);
      }
    }
  });

  // ─── /pending_reasons ─────────────────────────────────
  bot.onText(/\/pending_reasons/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات"); return; }

      // جمع السحوبات المعلقة بكل أنواعها
      const held = Object.entries(items)
        .map(([id, d]) => ({ id, ...d }))
        .filter(w => ['pending', 'awaiting_approval'].includes(w.status))
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));

      if (!held.length) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات معلقة حالياً"); return; }

      // إرسال على شكل مجموعات عشان ما يتجاوز حد Telegram
      const CHUNK = 15;
      for (let i = 0; i < held.length; i += CHUNK) {
        const chunk = held.slice(i, i + CHUNK);
        let text = i === 0
          ? `📋 <b>السحوبات المعلقة (${held.length})</b>\n\n`
          : `📋 <b>تابع... (${i + 1}–${Math.min(i + CHUNK, held.length)})</b>\n\n`;

        chunk.forEach((w, idx) => {
          const ton    = roundAmount(w.ton);
          const time   = w.ts ? new Date(w.ts).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) : '—';
          const status = w.status === 'awaiting_approval' ? '⏳ بانتظار موافقة' : '🔄 pending';

          // سبب التعليق
          let reason = '—';
          if (w.holdReason)  reason = w.holdReason;
          else if (w.lastError) reason = w.lastError;
          else if (w.error)     reason = w.error;
          else if (w.status === 'awaiting_approval') reason = 'تجاوز الحد اليومي';
          else if (ton > MAX_WITHDRAWAL_AMOUNT)      reason = `يتجاوز الحد الأقصى (${MAX_WITHDRAWAL_AMOUNT} TON)`;
          else if (ton < MIN_WITHDRAWAL_AMOUNT)      reason = `أقل من الحد الأدنى (${MIN_WITHDRAWAL_AMOUNT} TON)`;

          text +=
            `${i + idx + 1}. ${status}\n` +
            `   🆔 <code>${w.id}</code>\n` +
            `   👤 User: <code>${w.userId || '?'}</code>\n` +
            `   💰 ${ton} TON | 🪙 ${Number(w.amt || 0).toLocaleString()}\n` +
            `   ⚠️ السبب: ${reason}\n` +
            `   🕐 ${time} UTC\n\n`;
        });

        await adminReply(bot, msg.chat.id, text);
        if (i + CHUNK < held.length) await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  bot.on('polling_error', () => {});
  console.log("✅ Bot running with all admin commands");
}

setInterval(async () => {
  if (systemPaused) return;
  try {
    const snap = await db.ref("withdrawQueue").orderByChild("status").equalTo("processing").once("value");
    const items = snap.val();
    if (!items) return;
    const stuckThreshold = Date.now() - 5 * 60 * 1000; // 5 دقايق
    let recovered = 0;
    for (const [id, data] of Object.entries(items)) {
      if ((data.updatedAt || 0) < stuckThreshold) {
        await db.ref(`withdrawQueue/${id}`).update({
          status: "pending",
          updatedAt: Date.now(),
          lastError: "Recovered from stuck processing state",
        });
        console.log(`♻️ Recovered stuck withdrawal: ${id}`);
        recovered++;
      }
    }
    if (recovered > 0) {
      console.log(`♻️ Recovered ${recovered} stuck withdrawal(s) — triggering re-process`);
      setTimeout(() => processPendingWithdrawals(), 2000);
    }
  } catch (e) { console.log(`❌ stuckRecovery: ${e.message}`); }
}, 2 * 60 * 1000); // كل دقيقتين


console.log("\n" + "=".repeat(50));
console.log("🐼 PANDA BAMBOO WITHDRAWAL BOT");
console.log("=".repeat(50));
console.log(`FIREBASE: ${process.env.FIREBASE_SERVICE_ACCOUNT ? '✅' : '❌'}`);
console.log(`TON_API_KEY: ${process.env.TON_API_KEY ? '✅' : '❌'}`);
console.log(`TON_MNEMONIC: ${process.env.TON_MNEMONIC ? '✅' : '❌'}`);
console.log(`TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? '✅' : '❌'}`);

startWelcomeBot();

getWallet().then(async () => {
  const b = await getWalletBalance();
  console.log(`💰 Wallet balance: ${b.toFixed(4)} TON`);
  await processPendingWithdrawals();
}).catch(err => { console.error("❌ Wallet error:", err.message); });

setInterval(async () => {
  if (!systemPaused) await processPendingWithdrawals();
}, 60000);

db.ref("withdrawQueue").on("child_added", async (snap) => {
  const data = snap.val();
  if (data?.status === "pending" && !processingQueue.has(snap.key)) {
    console.log(`📢 New withdrawal: ${snap.key}`);
    setTimeout(() => processPendingWithdrawals(), 2000);
  }
});

db.ref(".info/connected").on("value", (snap) => { if (snap.val()) console.log("📡 Firebase connected"); });

console.log("💸 Running | 📬 @PandaBambooPayouts | 👤 Admin:", ADMIN_CHAT_ID);
console.log("=".repeat(50) + "\n");
