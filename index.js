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
// 🔹 إعدادات المعالجة
// ==========================
const MAX_RETRIES         = 3;
const RETRY_DELAY         = 10000;

// ─── إعدادات Batch ──────────────────────────
const BATCH_SIZE          = 10;   // عدد السحوبات في كل دفعة
const BATCH_FLUSH_SECONDS = 30;   // أرسل ما تبقى كل 30 ثانية حتى لو < BATCH_SIZE
const BATCH_BETWEEN_DELAY = 3000; // تأخير 3 ثواني بين كل دفعتين (لتجنب rate limit)

let MAX_WITHDRAWAL_AMOUNT = 10;
let MIN_WITHDRAWAL_AMOUNT = 0.5;
let MAX_BALANCE_BUFFER    = 0.1;
let BAMBOO_TO_TON_RATE    = 10000;
let systemPaused          = false;

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
let botInstance    = null;

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
      if (ts >= startOfDay.getTime() && ['paid', 'processing', 'pending', 'awaiting_approval'].includes(status)) {
        count++;
      }
    });
    return count;
  } catch (e) { console.log(`❌ getUserDailyWithdrawalCount: ${e.message}`); return 0; }
}

// ==========================
// 🔹 إشعار الأدمن بطلب موافقة
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
// 🔹 التحقق من تأكيد المعاملة (للـ Batch)
// ==========================
async function confirmBatchTransaction(expectedSeqno, maxWaitMs = 120000) {
  const start = Date.now();
  console.log(`🔍 Waiting for batch seqno ${expectedSeqno + 1} to confirm...`);

  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const { contract } = await getWallet();
      const currentSeqno = await contract.getSeqno();
      if (currentSeqno > expectedSeqno) {
        console.log(`✅ Batch seqno advanced: ${expectedSeqno} → ${currentSeqno}`);
        return { confirmed: true, reason: 'seqno_advanced' };
      }
    } catch (e) { console.log(`⚠️ seqno check error: ${e.message}`); }
  }

  return { confirmed: false, reason: 'seqno_timeout' };
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
// 🔹 تحديث wdHistory
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
  } catch (e) { console.log(`❌ updateUserWdHistory: ${e.message}`); }
}

// ==========================
// 🔹 التحقق من صلاحية السحب قبل إدراجه في الدفعة
// ==========================
async function validateWithdrawal(withdrawId, data) {
  // تحقق من البيانات
  if (!data?.address || !data?.ton) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "failed", error: "Invalid data", updatedAt: Date.now() });
    return { valid: false, skip: true };
  }

  const roundedAmount = roundAmount(data.ton);
  const userId        = data.userId || null;
  const wdId          = data.wdId   || withdrawId;

  // تحقق من العنوان
  if (!data.address.startsWith("EQ") && !data.address.startsWith("UQ")) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "failed", error: "Invalid TON address", updatedAt: Date.now() });
    if (userId && wdId) await db.ref(`users/${userId}/wdHistory/${wdId}`).update({ status: "failed", updatedAt: Date.now() });
    return { valid: false, skip: true };
  }

  // فحص حظر المستخدم
  if (userId && await isUserBanned(userId)) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", error: "User is banned", updatedAt: Date.now() });
    if (wdId) await db.ref(`users/${userId}/wdHistory/${wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
    return { valid: false, skip: true };
  }

  // فحص حظر المحفظة
  if (await isWalletBanned(data.address)) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", error: "Wallet is banned", updatedAt: Date.now() });
    if (userId && wdId) await db.ref(`users/${userId}/wdHistory/${wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
    return { valid: false, skip: true };
  }

  // انتظار موافقة الأدمن
  if (data.status === 'awaiting_approval') {
    return { valid: false, skip: false }; // تجاهل مؤقتاً فقط
  }

  // فحص الحد اليومي
  if (userId) {
    const dailyCount = await getUserDailyWithdrawalCount(userId);
    if (dailyCount > 2) {
      await db.ref(`withdrawQueue/${withdrawId}`).update({
        status: "awaiting_approval", updatedAt: Date.now(),
        holdReason: `تجاوز الحد اليومي — ${dailyCount} سحوبات اليوم`,
      });
      if (botInstance) await sendAdminApprovalRequest(botInstance, withdrawId, data, dailyCount);
      return { valid: false, skip: false };
    }
  }

  // فحص الحدود (max/min)
  if (roundedAmount > MAX_WITHDRAWAL_AMOUNT) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", error: `Exceeds max ${MAX_WITHDRAWAL_AMOUNT} TON — waiting`, updatedAt: Date.now() });
    return { valid: false, skip: false };
  }
  if (roundedAmount < MIN_WITHDRAWAL_AMOUNT) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", error: `Below min ${MIN_WITHDRAWAL_AMOUNT} TON — waiting`, updatedAt: Date.now() });
    return { valid: false, skip: false };
  }

  return { valid: true, roundedAmount, userId, wdId };
}

// ==========================
// 🔹 إرسال دفعة Batch (الدالة الرئيسية الجديدة)
//    items = [{ id, data, roundedAmount, userId, wdId, amountCoins }]
// ==========================
async function sendBatchTransfer(items, attempt = 0) {
  const MAX_BATCH_RETRIES = 2;
  const batchIds = items.map(i => i.id).join(', ');
  const totalTON = items.reduce((s, i) => s + i.roundedAmount, 0);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📦 BATCH TRANSFER | ${items.length} items | ${totalTON.toFixed(4)} TON total`);
  console.log(`   IDs: ${batchIds}`);
  console.log(`${'='.repeat(50)}`);

  // فحص الرصيد الكلي للدفعة
  const balanceCheck = await checkSufficientBalance(totalTON);
  if (!balanceCheck.sufficient) {
    console.log(`⏭️ Insufficient balance for batch: ${balanceCheck.balance.toFixed(3)} TON < ${totalTON.toFixed(3)} TON`);
    // أرجع كل السحوبات لـ pending
    for (const item of items) {
      processingQueue.delete(item.id);
      await db.ref(`withdrawQueue/${item.id}`).update({
        status: "pending", updatedAt: Date.now(),
        lastError: `Insufficient balance: ${balanceCheck.balance.toFixed(3)} TON`
      }).catch(() => {});
    }
    return { success: false, reason: 'insufficient_balance' };
  }

  try {
    const { contract, key } = await getWallet();
    const seqno = await contract.getSeqno();

    // بناء قائمة الرسائل
    const messages = items.map(item =>
      internal({
        to:     item.data.address,
        value:  toNano(item.roundedAmount.toFixed(3)),
        bounce: false,
      })
    );

    // تأخير صغير قبل الإرسال
    await new Promise(r => setTimeout(r, 1000));

    // إرسال كل الرسائل في معاملة واحدة
    await contract.sendTransfer({ secretKey: key.secretKey, seqno, messages });

    console.log(`📤 Batch submitted — seqno: ${seqno} | ${items.length} msgs | attempt: ${attempt + 1}`);

    // انتظار تأكيد الـ seqno (حتى 120 ثانية)
    const confirmation = await confirmBatchTransaction(seqno, 120000);

    if (!confirmation.confirmed) {
      // TIMEOUT — لا نعيد الإرسال لأن الفلوس ممكن تكون راحت
      console.log(`⚠️ Batch TIMEOUT — seqno ${seqno} not advanced. Marking as needs_review.`);
      for (const item of items) {
        await db.ref(`withdrawQueue/${item.id}`).update({
          status: "needs_review", updatedAt: Date.now(),
          lastError: `Batch timeout — seqno ${seqno} — verify manually`,
          batchSeqno: seqno,
        }).catch(() => {});
        processingQueue.delete(item.id);
      }
      // إشعار الأدمن
      if (botInstance) {
        await botInstance.sendMessage(ADMIN_CHAT_ID,
          `⚠️ <b>Batch Timeout</b>\n\n` +
          `${items.length} سحوبات تحتاج مراجعة يدوية\n` +
          `Seqno: <code>${seqno}</code>\n\n` +
          `IDs:\n${items.map(i => `• <code>${i.id}</code>`).join('\n')}`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
      return { success: false, reason: 'timeout', seqno };
    }

    // ✅ الدفعة نجحت — جيب hash من آخر معاملة
    let batchTxHash = null;
    try {
      const txRes  = await fetch(
        `https://toncenter.com/api/v2/getTransactions?address=${walletAddress}&limit=5`,
        { headers: { "X-API-Key": process.env.TON_API_KEY } }
      );
      const txData = await txRes.json();
      batchTxHash = txData.result?.[0]?.transaction_id?.hash || null;
    } catch (e) { console.log(`⚠️ Could not fetch batch tx hash: ${e.message}`); }

    console.log(`✅ Batch confirmed | hash: ${batchTxHash ? batchTxHash.substring(0, 14) + '...' : 'N/A'}`);

    // تحديث Firebase لكل سحب في الدفعة
    const updatePromises = items.map(async (item) => {
      try {
        await db.ref(`withdrawQueue/${item.id}`).update({
          status:      "paid",
          updatedAt:   Date.now(),
          completedAt: Date.now(),
          txHash:      batchTxHash || null,
          sentAmount:  item.roundedAmount,
          batchSize:   items.length,
        });
        await updateUserWdHistory(item.userId, item.wdId, batchTxHash, item.roundedAmount);
        processingQueue.delete(item.id);
        console.log(`   ✅ Marked paid: ${item.id}`);
      } catch (e) {
        console.log(`   ❌ Failed to update ${item.id}: ${e.message}`);
      }
    });
    await Promise.all(updatePromises);

    // إشعارات المستخدمين وإشعار القناة (بشكل متوازي)
    const notifPromises = items.map(item =>
      sendUserNotification(item.userId, item.roundedAmount, item.amountCoins, batchTxHash).catch(() => {})
    );
    notifPromises.push(
      sendChannelNotification(totalTON, batchTxHash, `${items.length} users`).catch(() => {})
    );
    await Promise.all(notifPromises);

    console.log(`🎉 Batch complete: ${items.length} withdrawals paid`);
    return { success: true, txHash: batchTxHash, count: items.length };

  } catch (error) {
    const msg = error.message;
    console.log(`❌ Batch attempt ${attempt + 1} failed: ${msg}`);

    const isNetworkError = msg.includes('500') || msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('network');

    if (isNetworkError && attempt < MAX_BATCH_RETRIES) {
      const waitSec = 20 * (attempt + 1);
      console.log(`🔁 Network error — retrying batch in ${waitSec}s (attempt ${attempt + 2})`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      return sendBatchTransfer(items, attempt + 1);
    }

    // فشل نهائي — أرجع كل السحوبات لـ pending مع تسجيل الخطأ
    console.log(`🔴 Batch FINAL FAIL — reverting ${items.length} items to pending`);
    for (const item of items) {
      await db.ref(`withdrawQueue/${item.id}`).update({
        status:    "pending",
        updatedAt: Date.now(),
        lastError: `Batch failed (attempt ${attempt + 1}): ${msg}`,
        attempts:  (item.data.attempts || 0) + 1,
      }).catch(() => {});
      processingQueue.delete(item.id);
    }

    // إشعار الأدمن
    if (botInstance) {
      await botInstance.sendMessage(ADMIN_CHAT_ID,
        `🔴 <b>Batch Failed</b>\n\n` +
        `${items.length} سحوبات فشلت وأُعيدت لـ pending\n\n` +
        `<i>${msg.substring(0, 300)}</i>\n\n` +
        `IDs:\n${items.map(i => `• <code>${i.id}</code>`).join('\n')}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    return { success: false, reason: 'error', error: msg };
  }
}

// ==========================
// 🔹 معالجة السحوبات المعلقة — نظام Batch الجديد
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
      .filter(([id]) => !processingQueue.has(id))
      .map(([id, d]) => ({ id, data: d, timestamp: d.ts || d.timestamp || 0 }))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (!list.length) { console.log("📭 All pending already in processingQueue"); isProcessing = false; return; }

    console.log(`\n📋 ${list.length} pending withdrawals — building batches (size: ${BATCH_SIZE})...`);

    // ─── المرحلة 1: التحقق من كل السحوبات ──────────────
    const validItems = [];
    for (const { id, data } of list) {
      processingQueue.add(id);
      const validation = await validateWithdrawal(id, data);

      if (!validation.valid) {
        if (validation.skip) {
          processingQueue.delete(id);
        } else {
          processingQueue.delete(id); // مش valid لكن مش skip — تُعالج لاحقاً
        }
        continue;
      }

      // ─── قفل ذري في Firebase ──
      let locked = false;
      await db.ref(`withdrawQueue/${id}`).transaction((current) => {
        if (!current || current.status !== "pending") return;
        locked = true;
        return { ...current, status: "processing", updatedAt: Date.now(), attempts: (current.attempts || 0) + 1 };
      });

      if (!locked) {
        console.log(`⏭️ ${id} already taken — skipping`);
        processingQueue.delete(id);
        continue;
      }

      validItems.push({
        id,
        data,
        roundedAmount: validation.roundedAmount,
        userId:       validation.userId,
        wdId:         validation.wdId,
        amountCoins:  data.amt || 0,
      });
    }

    if (!validItems.length) {
      console.log("📭 No valid withdrawals after checks");
      isProcessing = false;
      return;
    }

    // ─── المرحلة 2: تقسيم لدفعات وإرسال ─────────────
    const totalTON = validItems.reduce((s, i) => s + i.roundedAmount, 0);
    const batchCount = Math.ceil(validItems.length / BATCH_SIZE);
    console.log(`\n🚀 Sending ${validItems.length} items in ${batchCount} batch(es) | Total: ${totalTON.toFixed(4)} TON`);

    for (let b = 0; b < batchCount; b++) {
      const batch = validItems.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
      console.log(`\n▶️ Sending batch ${b + 1}/${batchCount} (${batch.length} items)...`);

      await sendBatchTransfer(batch);

      // تأخير بين الدفعات
      if (b < batchCount - 1) {
        console.log(`⏳ Waiting ${BATCH_BETWEEN_DELAY / 1000}s before next batch...`);
        await new Promise(r => setTimeout(r, BATCH_BETWEEN_DELAY));
      }
    }

  } catch (e) {
    console.log(`❌ processPendingWithdrawals: ${e.message}`);
  } finally {
    isProcessing = false;
    console.log("✅ processPendingWithdrawals cycle done");
  }
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
      `/balance — رصيد المحفظة\n` +
      `/queue — عدد السحوبات في الانتظار\n` +
      `/pending_reasons — تفاصيل المعلقة\n` +
      `/stats — إحصائيات عامة\n\n` +

      `⚙️ <b>الإعدادات</b>\n` +
      `/setmax [رقم] — الحد الأقصى للسحب (TON)\n` +
      `/setmin [رقم] — الحد الأدنى للسحب (TON)\n` +
      `/setrate [رقم] — سعر التحويل Bamboo→TON\n\n` +

      `📦 <b>إعدادات Batch</b>\n` +
      `/batchstatus — حالة نظام Batch\n\n` +

      `🔧 <b>التحكم</b>\n` +
      `/process — تشغيل المعالجة يدوياً\n` +
      `/pause — إيقاف المعالجة\n` +
      `/resume — استئناف المعالجة\n\n` +

      `🕵️ <b>كشف التلاعب</b>\n` +
      `/check_suspicious — كشف محافظ مشتركة بين +3 مستخدمين\n` +
      `/reject_suspicious — رفض وحظر جميع المشبوهين\n`
    );
  });

  // ─── /balance ─────────────────────────────────────────
  bot.onText(/\/balance/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const b = await getWalletBalance();
    await adminReply(bot, msg.chat.id, `💰 <b>Wallet Balance:</b> ${b.toFixed(6)} TON\n📬 <code>${walletAddress || 'not loaded'}</code>`);
  });

  // ─── /queue ───────────────────────────────────────────
  bot.onText(/\/queue/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value");
      const count = snap.exists() ? Object.keys(snap.val()).length : 0;
      const totalTON = snap.exists()
        ? Object.values(snap.val()).reduce((s, d) => s + roundAmount(d.ton), 0).toFixed(4)
        : '0';
      await adminReply(bot, msg.chat.id,
        `📋 <b>Queue Status</b>\n\n` +
        `⏳ Pending: <b>${count}</b> withdrawals\n` +
        `💰 Total: <b>${totalTON} TON</b>\n\n` +
        `📦 Batch size: <b>${BATCH_SIZE}</b> per batch\n` +
        `⚡ Est. batches needed: <b>${Math.ceil(count / BATCH_SIZE)}</b>`
      );
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /batchstatus ─────────────────────────────────────
  bot.onText(/\/batchstatus/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    await adminReply(bot, msg.chat.id,
      `📦 <b>Batch System Status</b>\n\n` +
      `🔢 Batch size: <b>${BATCH_SIZE}</b> items/batch\n` +
      `⏱ Flush interval: <b>${BATCH_FLUSH_SECONDS}s</b>\n` +
      `⏳ Between batches: <b>${BATCH_BETWEEN_DELAY / 1000}s</b>\n` +
      `🔄 Currently processing: <b>${isProcessing ? 'Yes' : 'No'}</b>\n` +
      `⏸ System paused: <b>${systemPaused ? 'Yes ⏸' : 'No ✅'}</b>\n` +
      `🔒 In processingQueue: <b>${processingQueue.size}</b>`
    );
  });

  // ─── /stats ───────────────────────────────────────────
  bot.onText(/\/stats/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").once("value");
      const items = snap.val() || {};
      const counts = { pending: 0, processing: 0, paid: 0, failed: 0, bounced: 0, cancelled: 0, awaiting_approval: 0, needs_review: 0 };
      let totalPaid = 0;
      Object.values(items).forEach(d => {
        counts[d.status] = (counts[d.status] || 0) + 1;
        if (d.status === 'paid') totalPaid += roundAmount(d.ton);
      });
      const bal = await getWalletBalance();
      await adminReply(bot, msg.chat.id,
        `📊 <b>Stats</b>\n\n` +
        `✅ Paid: <b>${counts.paid}</b> (${totalPaid.toFixed(3)} TON)\n` +
        `⏳ Pending: <b>${counts.pending}</b>\n` +
        `🔄 Processing: <b>${counts.processing}</b>\n` +
        `⏸ Awaiting approval: <b>${counts.awaiting_approval}</b>\n` +
        `🔴 Bounced: <b>${counts.bounced}</b>\n` +
        `❌ Failed: <b>${counts.failed}</b>\n` +
        `🔍 Needs review: <b>${counts.needs_review}</b>\n` +
        `🚫 Cancelled: <b>${counts.cancelled}</b>\n\n` +
        `💰 Wallet balance: <b>${bal.toFixed(4)} TON</b>\n\n` +
        `⚙️ Max: ${MAX_WITHDRAWAL_AMOUNT} | Min: ${MIN_WITHDRAWAL_AMOUNT} | Rate: ${BAMBOO_TO_TON_RATE}`
      );
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /setmax ──────────────────────────────────────────
  bot.onText(/\/setmax (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseFloat(match[1]);
    if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح"); return; }
    MAX_WITHDRAWAL_AMOUNT = v;
    await adminReply(bot, msg.chat.id, `✅ الحد الأقصى: <b>${v} TON</b>`);
  });

  // ─── /setmin ──────────────────────────────────────────
  bot.onText(/\/setmin (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseFloat(match[1]);
    if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح"); return; }
    MIN_WITHDRAWAL_AMOUNT = v;
    await adminReply(bot, msg.chat.id, `✅ الحد الأدنى: <b>${v} TON</b>`);
  });

  // ─── /setrate ─────────────────────────────────────────
  bot.onText(/\/setrate (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseInt(match[1]);
    if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح"); return; }
    BAMBOO_TO_TON_RATE = v;
    await adminReply(bot, msg.chat.id, `✅ السعر: <b>1 TON = ${v} Bamboo</b>`);
  });

  // ─── /pause & /resume ─────────────────────────────────
  bot.onText(/\/pause/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    systemPaused = true;
    await adminReply(bot, msg.chat.id, "⏸ System paused");
  });

  bot.onText(/\/resume/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    systemPaused = false;
    await adminReply(bot, msg.chat.id, "▶️ System resumed");
    setTimeout(() => processPendingWithdrawals(), 1000);
  });

  // ─── /process ─────────────────────────────────────────
  bot.onText(/\/process/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    await adminReply(bot, msg.chat.id, "🔄 Starting batch processing...");
    setTimeout(() => processPendingWithdrawals(), 500);
  });

  // ─── /check_suspicious ────────────────────────────────
  // يفحص السحوبات المعلقة ويكشف المحافظ المشتركة بين أكثر من 3 مستخدمين مختلفين
  bot.onText(/\/check_suspicious/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      await adminReply(bot, msg.chat.id, "🔍 جاري فحص السحوبات المعلقة بحثاً عن التلاعب...");

      const snap  = await db.ref("withdrawQueue").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات في القائمة"); return; }

      // تجميع: محفظة → Set من userIds
      const walletUsers = {}; // { address: { userIds: Set, withdrawIds: [] } }

      Object.entries(items).forEach(([id, d]) => {
        const status = d.status || '';
        if (!['pending', 'awaiting_approval', 'processing'].includes(status)) return;
        if (!d.address || !d.userId) return;

        const addr = d.address;
        if (!walletUsers[addr]) walletUsers[addr] = { userIds: new Set(), withdrawIds: [], totalTon: 0 };
        walletUsers[addr].userIds.add(String(d.userId));
        walletUsers[addr].withdrawIds.push(id);
        walletUsers[addr].totalTon += roundAmount(d.ton);
      });

      // فلترة: فقط المحافظ التي استخدمها أكثر من 3 مستخدمين
      const suspicious = Object.entries(walletUsers)
        .filter(([, v]) => v.userIds.size > 3)
        .sort((a, b) => b[1].userIds.size - a[1].userIds.size);

      if (!suspicious.length) {
        await adminReply(bot, msg.chat.id,
          `✅ <b>لم يتم اكتشاف أي نشاط مشبوه</b>\n\nلا توجد محفظة استخدمها أكثر من 3 مستخدمين في السحوبات المعلقة.`
        );
        return;
      }

      let text = `🚨 <b>محافظ مشبوهة — تعدد حسابات</b>\n`;
      text += `اكتُشفت <b>${suspicious.length}</b> محفظة مشتركة بين أكثر من 3 مستخدمين\n`;
      text += `${'━'.repeat(32)}\n\n`;

      for (let i = 0; i < suspicious.length; i++) {
        const [addr, data] = suspicious[i];
        const shortAddr = addr.substring(0, 6) + '...' + addr.substring(addr.length - 4);
        const userList  = [...data.userIds].join(', ');
        text +=
          `🔴 <b>محفظة ${i + 1}</b>\n` +
          `📬 <code>${addr}</code>\n` +
          `👥 عدد المستخدمين: <b>${data.userIds.size}</b>\n` +
          `🆔 المستخدمون: <code>${userList}</code>\n` +
          `📋 طلبات معلقة: <b>${data.withdrawIds.length}</b>\n` +
          `💰 إجمالي مطلوب: <b>${data.totalTon.toFixed(3)} TON</b>\n\n`;

        // إذا الرسالة طويلة — أرسلها وابدأ رسالة جديدة
        if (text.length > 3000 && i < suspicious.length - 1) {
          await adminReply(bot, msg.chat.id, text, {
            reply_markup: { inline_keyboard: [[
              { text: "🚫 رفض جميع المشبوهين", callback_data: "reject_all_suspicious" }
            ]]}
          });
          text = `🚨 <b>تابع — محافظ مشبوهة</b>\n\n`;
        }
      }

      text += `${'━'.repeat(32)}\n`;
      text += `⚡ استخدم /reject_suspicious لرفض جميع طلباتهم دفعةً واحدة`;

      await adminReply(bot, msg.chat.id, text, {
        reply_markup: { inline_keyboard: [[
          { text: "🚫 رفض جميع المشبوهين الآن", callback_data: "reject_all_suspicious" }
        ]]}
      });

    } catch (e) { await adminReply(bot, msg.chat.id, `❌ خطأ: ${e.message}`); }
  });

  // ─── /reject_suspicious ───────────────────────────────
  // يرفض جميع طلبات السحب المعلقة للمستخدمين المشبوهين (محفظة مشتركة > 3)
  bot.onText(/\/reject_suspicious/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      await adminReply(bot, msg.chat.id, "🔍 جاري تحليل البيانات وتنفيذ الرفض...");

      const snap  = await db.ref("withdrawQueue").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات"); return; }

      // تجميع المحافظ المشبوهة
      const walletUsers = {};
      Object.entries(items).forEach(([id, d]) => {
        const status = d.status || '';
        if (!['pending', 'awaiting_approval', 'processing'].includes(status)) return;
        if (!d.address || !d.userId) return;
        const addr = d.address;
        if (!walletUsers[addr]) walletUsers[addr] = { userIds: new Set(), entries: [] };
        walletUsers[addr].userIds.add(String(d.userId));
        walletUsers[addr].entries.push({ id, ...d });
      });

      // جمع كل الطلبات والمستخدمين المشبوهين
      const suspiciousUserIds = new Set();
      const suspiciousWallets = new Set();
      Object.entries(walletUsers).forEach(([addr, v]) => {
        if (v.userIds.size > 3) {
          suspiciousWallets.add(addr);
          v.userIds.forEach(uid => suspiciousUserIds.add(uid));
        }
      });

      if (!suspiciousUserIds.size) {
        await adminReply(bot, msg.chat.id, "✅ لا يوجد مستخدمون مشبوهون للرفض");
        return;
      }

      // رفض جميع طلبات هؤلاء المستخدمين (المعلقة فقط)
      let rejectedCount = 0;
      const rejectPromises = [];

      Object.entries(items).forEach(([id, d]) => {
        const status = d.status || '';
        if (!['pending', 'awaiting_approval', 'processing'].includes(status)) return;
        if (!suspiciousUserIds.has(String(d.userId))) return;

        rejectPromises.push(
          db.ref(`withdrawQueue/${id}`).update({
            status:    "cancelled",
            updatedAt: Date.now(),
            holdReason: `مرفوض تلقائياً — تعدد حسابات (محفظة مشتركة مع ${walletUsers[d.address]?.userIds.size || '?'} مستخدمين)`,
          }).then(async () => {
            if (d.userId && d.wdId) {
              await db.ref(`users/${d.userId}/wdHistory/${d.wdId}`).update({
                status: "cancelled", updatedAt: Date.now()
              }).catch(() => {});
            }
            rejectedCount++;
          }).catch(() => {})
        );
      });

      await Promise.all(rejectPromises);

      // تسجيل المحافظ المشبوهة في bannedWallets تلقائياً
      const banPromises = [];
      suspiciousWallets.forEach(addr => {
        const key = addr.replace(/[.$#[\]/]/g, '_');
        banPromises.push(
          db.ref(`bannedWallets/${key}`).set({
            address:   addr,
            reason:    "تعدد حسابات — كشف تلقائي",
            bannedAt:  Date.now(),
            userCount: walletUsers[addr]?.userIds.size || 0,
          }).catch(() => {})
        );
      });
      await Promise.all(banPromises);

      await adminReply(bot, msg.chat.id,
        `✅ <b>تم تنفيذ الرفض الجماعي</b>\n\n` +
        `${'━'.repeat(30)}\n` +
        `🚫 طلبات مرفوضة: <b>${rejectedCount}</b>\n` +
        `👥 مستخدمون متأثرون: <b>${suspiciousUserIds.size}</b>\n` +
        `📬 محافظ محظورة: <b>${suspiciousWallets.size}</b>\n` +
        `${'━'.repeat(30)}\n\n` +
        `🔒 تم حظر المحافظ المشبوهة تلقائياً في <code>bannedWallets</code>\n` +
        `🆔 المستخدمون: <code>${[...suspiciousUserIds].join(', ')}</code>`
      );

    } catch (e) { await adminReply(bot, msg.chat.id, `❌ خطأ: ${e.message}`); }
  });

  // ─── Callback: رفض جميع المشبوهين بضغطة زر ──────────
  // (يُعيد توجيه لنفس منطق /reject_suspicious)
  bot.on('callback_query', async (query) => {
    if (query.message.chat.id.toString() !== ADMIN_CHAT_ID) return;
    if (query.data === 'reject_all_suspicious') {
      await bot.answerCallbackQuery(query.id, { text: "🔄 جاري تنفيذ الرفض..." });
      // نفّذ نفس منطق reject_suspicious مباشرة
      await bot.sendMessage(ADMIN_CHAT_ID, "/reject_suspicious");
    }
  });

  // ─── Callback: موافقة / رفض السحب ────────────────────
  bot.on('callback_query', async (query) => {
    if (query.message.chat.id.toString() !== ADMIN_CHAT_ID) return;
    const data   = query.data || '';
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;

    // ── إعادة معالجة ──
    if (data.startsWith('reprocess_wd:')) {
      const withdrawId = data.replace('reprocess_wd:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once("value");
        const wd   = snap.val();
        if (!wd) { await bot.answerCallbackQuery(query.id, { text: "❌ السحب غير موجود!" }); return; }
        await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", updatedAt: Date.now(), lastError: null });
        await bot.editMessageText(
          query.message.text + `\n\n🔄 <b>تمت إعادة الإضافة للمعالجة</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
        );
        await bot.answerCallbackQuery(query.id, { text: "🔄 تمت إعادة الإضافة للقائمة" });
        setTimeout(() => processPendingWithdrawals(), 1000);
      } catch (e) {
        await bot.answerCallbackQuery(query.id, { text: `❌ خطأ: ${e.message}` });
      }
    }

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
        await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", approvedByAdmin: true, updatedAt: Date.now(), holdReason: null });
        await bot.editMessageText(
          query.message.text + `\n\n✅ <b>تمت الموافقة</b> — جاري الدفع...`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
        );
        await bot.answerCallbackQuery(query.id, { text: "✅ تمت الموافقة — سيتم الدفع الآن" });
        console.log(`✅ Admin approved: ${withdrawId}`);
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

      const held = Object.entries(items)
        .map(([id, d]) => ({ id, ...d }))
        .filter(w => ['pending', 'awaiting_approval'].includes(w.status))
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));

      if (!held.length) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات معلقة حالياً"); return; }

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
  console.log("✅ Bot running with all admin commands + Batch system");
}

// ==========================
// 🔹 استرداد السحوبات العالقة
// ==========================
setInterval(async () => {
  if (systemPaused) return;
  try {
    const snap = await db.ref("withdrawQueue").orderByChild("status").equalTo("processing").once("value");
    const items = snap.val();
    if (!items) return;
    const stuckThreshold = Date.now() - 5 * 60 * 1000;
    let recovered = 0;
    for (const [id, data] of Object.entries(items)) {
      if ((data.updatedAt || 0) < stuckThreshold) {
        await db.ref(`withdrawQueue/${id}`).update({
          status: "pending", updatedAt: Date.now(),
          lastError: "Recovered from stuck processing state",
        });
        processingQueue.delete(id);
        console.log(`♻️ Recovered stuck withdrawal: ${id}`);
        recovered++;
      }
    }
    if (recovered > 0) {
      console.log(`♻️ Recovered ${recovered} stuck — triggering re-process`);
      setTimeout(() => processPendingWithdrawals(), 2000);
    }
  } catch (e) { console.log(`❌ stuckRecovery: ${e.message}`); }
}, 2 * 60 * 1000);

// ==========================
// 🔹 Flush Timer (كل 30 ثانية — يعالج الدفعات الجزئية)
// ==========================
setInterval(async () => {
  if (!systemPaused && !isProcessing) {
    const snap = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value").catch(() => null);
    if (snap && snap.exists()) {
      console.log(`⏰ Flush timer — running batch process`);
      processPendingWithdrawals();
    }
  }
}, BATCH_FLUSH_SECONDS * 1000);

// ==========================
// 🔹 Start
// ==========================
console.log("\n" + "=".repeat(50));
console.log("🐼 PANDA BAMBOO WITHDRAWAL BOT — BATCH MODE");
console.log("=".repeat(50));
console.log(`FIREBASE: ${process.env.FIREBASE_SERVICE_ACCOUNT ? '✅' : '❌'}`);
console.log(`TON_API_KEY: ${process.env.TON_API_KEY ? '✅' : '❌'}`);
console.log(`TON_MNEMONIC: ${process.env.TON_MNEMONIC ? '✅' : '❌'}`);
console.log(`TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? '✅' : '❌'}`);
console.log(`📦 Batch size: ${BATCH_SIZE} | Flush: ${BATCH_FLUSH_SECONDS}s | Between batches: ${BATCH_BETWEEN_DELAY / 1000}s`);

startWelcomeBot();

getWallet().then(async () => {
  const b = await getWalletBalance();
  console.log(`💰 Wallet balance: ${b.toFixed(4)} TON`);
  await processPendingWithdrawals();
}).catch(err => { console.error("❌ Wallet error:", err.message); });

// دورة معالجة كل دقيقة
setInterval(async () => {
  if (!systemPaused) await processPendingWithdrawals();
}, 60000);

// listener لأي سحب جديد
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
