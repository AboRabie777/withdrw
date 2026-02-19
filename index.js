require("dotenv").config();
const admin = require("firebase-admin");
const { TonClient, WalletContractV5R1, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");
const TelegramBot = require('node-telegram-bot-api');

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
// 🔹 إرسال TON (مع Comment محسن)
// ==========================

async function sendTON(toAddress, amount) {
  const { contract, key } = await getWallet();
  const seqno = await contract.getSeqno();
  
  const senderAddress = contract.address.toString();
  
  console.log(`Sending ${amount} TON to ${toAddress}...`);
  console.log(`Sender address: ${senderAddress}`);
  
  if (amount < 0.2) {
    console.log("⚠️ Amount is very small (less than 0.2 TON), may be marked as spam");
  }
  
  const transfer = await contract.sendTransfer({
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
// 🔹 إرسال إشعار للمستخدم
// ==========================

async function sendUserNotification(chatId, amount, toAddress) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("⚠️ TELEGRAM_BOT_TOKEN is not set");
    return false;
  }

  if (!chatId) {
    console.log("⚠️ No chatId found");
    return false;
  }

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

    if (!response.ok) {
      console.error("❌ Failed to send user notification");
      return false;
    } else {
      console.log(`✅ User notification sent to ${chatId}`);
      return true;
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
    return false;
  }
}

// ==========================
// 🔹 إرسال إشعار للقناة
// ==========================

async function sendChannelNotification(amount, toAddress, userId, botToken) {
  const channelId = "@Crystal_Ranch_chat";
  const walletLink = `https://tonviewer.com/${toAddress}`;
  
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const responseData = await response.json();
    
    if (!response.ok) {
      console.error("❌ Failed to send channel notification");
    } else {
      console.log(`✅ Channel notification sent`);
      if (responseData.result && responseData.result.message_id) {
        console.log(`🔗 Post link: https://t.me/Crystal_Ranch_chat/${responseData.result.message_id}`);
      }
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

// ==========================
// 🔹 تشغيل بوت الترحيب
// ==========================

function startWelcomeBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!botToken) {
    console.error("⚠️ TELEGRAM_BOT_TOKEN not set. Welcome bot cannot start.");
    return;
  }
  
  const welcomeBot = new TelegramBot(botToken, { polling: true });
  
  // أمر /start
  welcomeBot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name || '';
    
    console.log(`👋 Welcome bot: User ${firstName} (${chatId}) started`);
    
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
    } catch (error) {
      console.error("❌ Error sending welcome message:", error.message);
    }
  });
  
  // أمر /help
  welcomeBot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const helpText = `
🤖 *Crystal Ranch Bot Commands:*

/start - Start the bot and see welcome message
/help - Show this help message
/about - About Crystal Ranch
    `;
    
    await welcomeBot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
  });
  
  // أمر /about
  welcomeBot.onText(/\/about/, async (msg) => {
    const chatId = msg.chat.id;
    const aboutText = `
💎 *About Crystal Ranch*

Crystal Ranch is a scarcity-based economy game on Telegram.
Early entry is the key to success!

🔗 *Links:*
• App: @Crystal_Ranch_bot
• Chat: @Crystal_Ranch_chat
• Channel: @earnmoney139482

Join now and secure your place! 🚀
    `;
    
    await welcomeBot.sendMessage(chatId, aboutText, { parse_mode: 'Markdown' });
  });
  
  console.log("🚀 Welcome bot is running...");
  return welcomeBot;
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

    if (Number(data.netAmount) > 1) {
      console.log("Amount exceeds auto limit. Leaving pending.");
      return;
    }

    if (!data.address || (!data.address.startsWith("EQ") && !data.address.startsWith("UQ"))) {
      console.log("Invalid address. Leaving pending.");
      return;
    }

    let userId = null;
    
    if (withdrawId.startsWith("wd_")) {
      const parts = withdrawId.split("_");
      if (parts.length >= 3) {
        userId = parts[2];
        console.log(`✅ Extracted user ID: ${userId}`);
      }
    }

    await withdrawalsRef.child(withdrawId).update({
      status: "processing",
      updatedAt: Date.now(),
    });

    const result = await sendTON(data.address, data.netAmount);
    
    console.log("\n📦 SendTON result:", JSON.stringify(result, null, 2));

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

    if (userId) {
        const userNotified = await sendUserNotification(userId, data.netAmount, data.address);
        
        if (userNotified) {
          const botToken = process.env.TELEGRAM_BOT_TOKEN;
          await sendChannelNotification(data.netAmount, data.address, userId, botToken);
        }
    } else {
        console.log(`ℹ️ No user ID found`);
    }

  } catch (error) {
    console.log("❌ Send error:", error.message);
    await withdrawalsRef.child(withdrawId).update({
      status: "pending",
      updatedAt: Date.now(),
    });
  }
});

// ==========================
// 🔹 تشغيل كل شيء
// ==========================

console.log("🚀 Starting Crystal Ranch Bot...");
console.log("✅ Bounce enabled to reduce spam detection");
console.log("✅ Comment improved: 'Withdrawal from @Crystal_Ranch_bot'");
console.log("⚠️ Warning: Amounts less than 0.2 TON may be marked as spam on Tonviewer");

// تشغيل بوت الترحيب
startWelcomeBot();

// مراقبة السحوبات
console.log("💸 TON Auto Withdraw Running...");
