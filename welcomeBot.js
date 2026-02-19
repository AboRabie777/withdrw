require("dotenv").config();
const TelegramBot = require('node-telegram-bot-api');

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
    console.error("⚠️ TELEGRAM_BOT_TOKEN not set. Welcome bot cannot start.");
    return null;
  }
  
  const welcomeBot = new TelegramBot(botToken, { polling: true });
  
  // أمر /start
  welcomeBot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name || '';
    const username = msg.from.username || '';
    
    console.log(`👋 Welcome bot: User ${firstName} (@${username}) [${chatId}] started`);
    
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
        disable_web_page_preview: true,
        parse_mode: 'HTML'
      });
      
      console.log(`✅ Welcome message sent to ${firstName} (${chatId})`);
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
    
    try {
      await welcomeBot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error("❌ Error sending help message:", error.message);
    }
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
    
    try {
      await welcomeBot.sendMessage(chatId, aboutText, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error("❌ Error sending about message:", error.message);
    }
  });
  
  // معالجة الأخطاء في polling
  welcomeBot.on('polling_error', (error) => {
    console.error('⚠️ Polling error:', error.message);
  });
  
  console.log("🚀 Welcome bot is running independently...");
  return welcomeBot;
}

// ==========================
// 🔹 تشغيل البوت إذا تم استدعاء الملف مباشرة
// ==========================

if (require.main === module) {
  console.log("🔵 Starting Welcome Bot standalone mode...");
  startWelcomeBot();
}

// ==========================
// 🔹 تصدير الدالة لاستخدامها في ملفات أخرى
// ==========================

module.exports = { startWelcomeBot, WELCOME_TEXT };
