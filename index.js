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
  
  console.log(`Sending ${amount} TON to ${toAddress}...`);
  console.log(`Sender address: ${senderAddress}`);
  
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
    // انتظار 3 ثواني للتأكد من تسجيل المعاملة
    console.log("Waiting for transaction to be recorded...");
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // محاولة الحصول على آخر معاملة للمحفظة
    const transactions = await contract.getTransactions(1);
    if (transactions && transactions.length > 0) {
      transactionHash = transactions[0].hash.toString('hex');
      console.log(`✅ Transaction hash obtained: ${transactionHash}`);
    } else {
      console.log("⚠️ No transactions found after sending");
      
      // محاولة مرة أخرى بعد انتظار إضافي
      console.log("Waiting additional 3 seconds and trying again...");
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const transactionsRetry = await contract.getTransactions(1);
      if (transactionsRetry && transactionsRetry.length > 0) {
        transactionHash = transactionsRetry[0].hash.toString('hex');
        console.log(`✅ Transaction hash obtained on retry: ${transactionHash}`);
      }
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
// 🔹 إرسال إشعار للمستخدم عبر تليجرام
// ==========================

async function sendTelegramNotification(chatId, amount, transactionHash = null, fromAddress = null) {
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

  let message = '';
  
  if (transactionHash) {
    // إذا وجدنا هاش المعاملة
    const transactionLink = `https://tonscan.org/tx/${transactionHash}`;
    message = `✅ Withdrawal Successful! 🎉

💰 Amount: ${amount} TON
🔗 <a href="${transactionLink}">View Transaction on Tonscan</a>
📋 Hash: <code>${transactionHash.substring(0, 8)}...${transactionHash.substring(transactionHash.length - 8)}</code>

Your funds have been delivered.`;
    
    console.log(`🔗 Sending transaction link: ${transactionLink}`);
  } else if (fromAddress) {
    // إذا لم نجد هاش، نرسل رابط المحفظة
    const walletLink = `https://tonscan.org/address/${fromAddress}`;
    message = `✅ Withdrawal Successful! 🎉

💰 Amount: ${amount} TON
🔗 <a href="${walletLink}">View Wallet on Tonscan</a>

Your funds have been delivered. The transaction will appear in your wallet shortly.`;
    
    console.log(`🔗 Sending wallet link: ${walletLink}`);
  } else {
    // رسالة احتياطية
    message = `✅ Withdrawal Successful! 🎉

💰 Amount: ${amount} TON

Your funds have been delivered. The transaction will appear in your wallet shortly.`;
  }

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

    const responseData = await response.json();
    
    if (!response.ok) {
      console.error("❌ Failed to send Telegram notification:", responseData);
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

  const withdrawId = snapshot.key; // مثلاً: wd_1771515897654_6970148965
  const data = snapshot.val();

  if (!data || data.status !== "pending") return;

  try {

    console.log("\n=====================");
    console.log("Processing withdrawal:", withdrawId);
    console.log("Withdrawal data:", JSON.stringify(data, null, 2));
    console.log("=====================\n");

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
    
    console.log("\n📦 SendTON result:", JSON.stringify(result, null, 2));

    // تحديث الحالة إلى "paid" مع حفظ رابط المعاملة
    const updateData = {
      status: "paid",
      updatedAt: Date.now(),
    };
    
    if (result.hash) {
      updateData.transactionHash = result.hash;
      updateData.transactionLink = `https://tonscan.org/tx/${result.hash}`;
      console.log(`✅ Transaction hash saved: ${result.hash}`);
    } else {
      console.log("⚠️ No transaction hash from sendTON");
      // حفظ عنوان المحفظة كبديل
      updateData.fromAddress = result.fromAddress;
    }

    await withdrawalsRef.child(withdrawId).update(updateData);

    console.log("✅ Withdrawal marked as paid:", withdrawId);

    // ==========================
    // 🔹 إرسال إشعار تليجرام بعد الدفع الناجح
    // ==========================
    if (userId) {
        // تمرير الهاش إذا وجد، وإلا نمرر عنوان المحفظة
        await sendTelegramNotification(
          userId, 
          data.netAmount, 
          result.hash,
          result.fromAddress
        );
    } else {
        console.log(`ℹ️ Could not extract user ID from withdrawal ${withdrawId}. Skipping Telegram notification.`);
    }

  } catch (error) {

    console.log("❌ Send error:", error.message);
    console.log("Error details:", error);

    // 🔥 يرجعها pending ولا يرفضها
    await withdrawalsRef.child(withdrawId).update({
      status: "pending",
      updatedAt: Date.now(),
    });

  }

});

console.log("🚀 TON Auto Withdraw Running (Wallet W5 Secure)...");
