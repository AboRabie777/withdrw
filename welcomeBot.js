require("dotenv").config();
const TelegramBot = require('node-telegram-bot-api');

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
// 🔹 تشغيل بوت الترحيب
// ==========================

function startWelcomeBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!botToken) {
    console.error("❌ TELEGRAM_BOT_TOKEN missing");
    return null;
  }
  
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
    } catch (error) {
      smartLog(`❌ Error: ${error.message}`);
    }
  });
  
  // أمر /help
  welcomeBot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const helpText = `/start - Welcome message
/help - This help
/about - About`;
    
    await welcomeBot.sendMessage(chatId, helpText);
  });
  
  // أمر /about
  welcomeBot.onText(/\/about/, async (msg) => {
    const chatId = msg.chat.id;
    const aboutText = `💎 Crystal Ranch
App: @Crystal_Ranch_bot
Chat: @Crystal_Ranch_chat`;
    
    await welcomeBot.sendMessage(chatId, aboutText);
  });
  
  // معالجة الأخطاء بصمت
  welcomeBot.on('polling_error', () => {});
  
  smartLog("✅ Welcome bot active");
  return welcomeBot;
}

if (require.main === module) {
  startWelcomeBot();
}

module.exports = { startWelcomeBot, WELCOME_TEXT };
