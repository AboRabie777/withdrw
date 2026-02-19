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
        body: "@Crystal_Ranch_bot"
      }),
    ],
  });

  // محاولة الحصول على Hash المعاملة
  let transactionHash = null;
  
  try {
    console.log("Waiting for transaction to be recorded...");
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const transactions = await contract.getTransactions(1);
    if (transactions && transactions.length > 0) {
      transactionHash = transactions[0].hash.toString('hex');
      console.log(`✅ Transaction hash obtained: ${transactionHash}`);
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
// 🔹 إرسال إشعار للمستخدم عبر تليجرام (بالإنجليزية)
// ==========================

async function sendUserNotification(chatId, amount, toAddress) {
  // معرف البوت الخاص بك
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("⚠️ TELEGRAM_BOT_TOKEN is not set in .env file. Cannot send notification.");
    return false;
  }

  // التأكد من أن chatId صالح
  if (!chatId) {
    console.log("⚠️ No chatId found for this withdrawal. Skipping notification.");
    return false;
  }

  // إنشاء رابط المحفظة المستلمة على Tonviewer
  const walletLink = `https://tonviewer.com/${toAddress}`;
  
  // رسالة المستخدم - بالإنجليزية
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
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseData = await response.json();
    
    if (!response.ok) {
      console.error("❌ Failed to send user notification:", responseData);
      return false;
    } else {
      console.log(`✅ User notification sent to chat ${chatId} for amount ${amount} TON.`);
      return true;
    }
  } catch (error) {
    console.error("❌ Error sending user notification:", error.message);
    return false;
  }
}

// ==========================
// 🔹 إرسال إشعار للقناة (بالإنجليزية - معدلة)
// ==========================

async function sendChannelNotification(amount, toAddress, userId, botToken) {
  // معرف القناة
  const channelId = "@Crystal_Ranch_chat";
  
  // إنشاء رابط المحفظة المستلمة على Tonviewer
  const walletLink = `https://tonviewer.com/${toAddress}`;
  
  // رسالة القناة - معدلة حسب الطلب
  const channelMessage = `🎉 New Withdrawal Completed! 🎉

🆔 User ID: \`${userId}\`
💰 Amount: ${amount} TON
🔗 <a href="${walletLink}">View Transaction on Tonviewer</a>`;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: channelId,
    text: channelMessage,
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
      console.error("❌ Failed to send channel notification:", responseData);
    } else {
      console.log(`✅ Channel notification sent for amount ${amount} TON.`);
      console.log(`🔗 Post link: https://t.me/Crystal_Ranch_chat/${responseData.result.message_id}`);
    }
  } catch (error) {
    console.error("❌ Error sending channel notification:", error.message);
  }
}

// ==========================
// 🔹 مراقبة السحوبات
// ==========================

const withdrawalsRef = db.ref("withdrawals");

withdrawalsRef.on("child_added", async (snapshot) => {

  const withdrawId = snapshot.key;
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
      return;
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

    // تحديث الحالة إلى "paid"
    const updateData = {
      status: "paid",
      updatedAt: Date.now(),
      toAddress: data.address
    };
    
    if (result.hash) {
      updateData.transactionHash = result.hash;
      updateData.transactionLink = `https://tonviewer.com/transaction/${result.hash}`;
      console.log(`✅ Transaction hash saved: ${result.hash}`);
    }

    await withdrawalsRef.child(withdrawId).update(updateData);
    console.log("✅ Withdrawal marked as paid:", withdrawId);

    // ==========================
    // 🔹 إرسال إشعارات تليجرام
    // ==========================
    if (userId) {
        // 1. إرسال إشعار للمستخدم
        const userNotified = await sendUserNotification(
          userId, 
          data.netAmount, 
          data.address
        );
        
        // 2. إرسال إشعار للقناة
        if (userNotified) {
          const botToken = process.env.TELEGRAM_BOT_TOKEN;
          await sendChannelNotification(
            data.netAmount,
            data.address,
            userId,
            botToken
          );
        }
    } else {
        console.log(`ℹ️ Could not extract user ID from withdrawal ${withdrawId}. Skipping Telegram notifications.`);
    }

  } catch (error) {

    console.log("❌ Send error:", error.message);
    console.log("Error details:", error);

    // إعادة الحالة إلى pending
    await withdrawalsRef.child(withdrawId).update({
      status: "pending",
      updatedAt: Date.now(),
    });

  }

});

console.log("🚀 TON Auto Withdraw Running (Wallet W5 Secure)...");
