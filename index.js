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
// 🔹 إرسال TON
// ==========================

async function sendTON(toAddress, amount) {
  const { contract, key } = await getWallet();
  const seqno = await contract.getSeqno();
  
  const senderAddress = contract.address.toString();
  
  console.log(`💰 Sending ${amount} TON to ${toAddress}...`);
  
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
      console.log(`✅ Tx hash: ${transactionHash.substring(0,16)}...`);
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
    console.log(`✅ Notif sent to ${chatId}`);
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
// 🔹 مراقبة السحوبات
// ==========================

const withdrawalsRef = db.ref("withdrawals");
let isProcessing = false;

withdrawalsRef.on("child_added", async (snapshot) => {
  if (isProcessing) return;
  isProcessing = true;
  
  try {
    const withdrawId = snapshot.key;
    const data = snapshot.val();

    if (!data || data.status !== "pending") {
      isProcessing = false;
      return;
    }

    console.log(`\n🔄 Processing: ${withdrawId}`);

    if (Number(data.netAmount) > 1) {
      console.log(`⏭️ Amount >1 TON`);
      isProcessing = false;
      return;
    }

    if (!data.address || (!data.address.startsWith("EQ") && !data.address.startsWith("UQ"))) {
      console.log(`⏭️ Invalid address`);
      isProcessing = false;
      return;
    }

    let userId = null;
    if (withdrawId.startsWith("wd_")) {
      const parts = withdrawId.split("_");
      if (parts.length >= 3) userId = parts[2];
    }

    await withdrawalsRef.child(withdrawId).update({
      status: "processing",
      updatedAt: Date.now(),
    });

    const result = await sendTON(data.address, data.netAmount);

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
    console.log(`✅ Completed: ${withdrawId}`);

    if (userId) {
      const userNotified = await sendUserNotification(userId, data.netAmount, data.address);
      if (userNotified) {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        await sendChannelNotification(data.netAmount, data.address, userId, botToken);
      }
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
    }, 2000);
  }
});

console.log("🚀 TON Auto Withdraw Running");
