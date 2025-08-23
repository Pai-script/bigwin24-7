const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TOKEN = '7983353841:AAFTdw4_79mqghgn29W5CgAnc01yUz2fIOE'; // Replace with your bot token
const bot = new TelegramBot(TOKEN, { polling: true });

const SLOT_SECONDS = 30;
const FIREBASE_URL = "https://admin-panel-17295-default-rtdb.firebaseio.com/users";

// Create axios instance with better timeout settings
const axiosInstance = axios.create({
  timeout: 15000, // Increased to 15 seconds
  maxRedirects: 5,
});

// ===== USER SYSTEM =====
const verifiedUsers = new Set();
const users = new Map(); // Stores {chatId: {subscribed: boolean, selectedSite: 'BIGWIN'|'CKLOTTERY'}}
const userStats = new Map();
const predictionHistory = new Map(); // Store {issueNumber, prediction, site}
const keyExpiryTimers = new Map();
const awaitingKeyRenewal = new Set();
const userNames = new Map(); // Stores {chatId: userName}
const awaitingFeedback = new Set(); // Stores chatIds waiting for feedback

// Feedback file path
const FEEDBACK_FILE = path.join(__dirname, 'feedback.json');

// Load existing feedback
let feedbackData = [];
try {
  if (fs.existsSync(FEEDBACK_FILE)) {
    const data = fs.readFileSync(FEEDBACK_FILE, 'utf8');
    feedbackData = JSON.parse(data);
  }
} catch (err) {
  console.error('Error loading feedback data:', err.message);
}

// ===== API CONFIGURATIONS =====
const SITE_CONFIGS = {
  BIGWIN: {
    name: "BIGWIN",
    issueUrl: "https://api.bigwinqaz.com/api/webapi/GetGameIssue",
    resultsUrl: "https://api.bigwinqaz.com/api/webapi/GetNoaverageEmerdList",
    issueParams: {
      typeId: 30, 
      language: 7,
      random: "261a65ff89cf41b0aa6d41d9d90325b0",
      signature: "8F29D6BBF728613DD4BB349D5175AD15"
    },
    resultsParams: {
      pageSize: 10, 
      pageNo: 1, 
      typeId: 30, 
      language: 7,
      random: "248642421cd847fbbf3d33630ee82d5e",
      signature: "FE3C4A5BD61772C9B727C1553CA60ACC"
    }
  },
  CKLOTTERY: {
    name: "CK Lottery",
    issueUrl: "https://ckygjf6r.com/api/webapi/GetGameIssue",
    resultsUrl: "https://ckygjf6r.com/api/webapi/GetNoaverageEmerdList",
    issueParams: {
      typeId: 30, 
      language: 0,
      random: "774d25089b1343f5ba429338c40ea392",
      signature: "B71A92AF0C016602E261D1B9841E8512"
    },
    resultsParams: {
      pageSize: 10, 
      pageNo: 1, 
      typeId: 30, 
      language: 0,
      random: "02665bc135314581bbed5871dbcafd76",
      signature: "E378DD1066AF70E7F50A081F2937A4D4"
    }
  }
};

// ===== FIREBASE KEY CHECK =====
async function checkKeyValidity(key, chatId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const userName = userNames.get(chatId) || 'Unknown User';
      console.log(`🔑 Checking key validity for user: ${userName} (Attempt ${i+1}/${retries})`);
      
      const res = await axiosInstance.get(`${FIREBASE_URL}/${key}.json`, {
        timeout: 10000
      });
      
      const data = res.data;
      if (!data) {
        console.log(`❌ Invalid key format for user: ${userName}`);
        return { valid: false, reason: "Invalid Key\nContact Developer @leostrike223 for key" };
      }
      
      if (Date.now() > data.expiresAt) {
        console.log(`❌ Expired key for user: ${userName}`);
        return { valid: false, reason: "Expired Key\nContact Developer @leostrike223 for renewal" };
      }
      
      keyExpiryTimers.set(chatId, data.expiresAt);

      const devices = data.devices ? Object.keys(data.devices).length : 0;
      if (devices >= (data.deviceLimit || 1)) {
        console.log(`❌ Device limit reached for user: ${userName}`);
        return { valid: false, reason: "Device Limit Reached\nContact Developer @leostrike223" };
      }
      
      console.log(`✅ Valid key for user: ${userName}, expires: ${new Date(data.expiresAt).toLocaleString()}`);
      return { valid: true, reason: "Valid" };
      
    } catch (err) {
      const userName = userNames.get(chatId) || 'Unknown User';
      console.error(`❌ Firebase REST Error (Attempt ${i+1}/${retries}) for user ${userName}:`, err.message);
      
      if (i === retries - 1) {
        // Last attempt failed
        if (err.code === 'ECONNRESET') {
          return { valid: false, reason: "Connection Error: Please try again" };
        } else if (err.code === 'ETIMEDOUT') {
          return { valid: false, reason: "Connection Timeout: Please try again" };
        } else if (err.response && err.response.status === 404) {
          return { valid: false, reason: "Invalid Key\nContact Developer @leostrike223 for key" };
        } else {
          return { valid: false, reason: "Server Error: Please try again later" };
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
}

// ===== API FUNCTIONS =====
async function fetchCurrentIssue(site) {
  const config = SITE_CONFIGS[site];
  try {
    const res = await axiosInstance.post(
      config.issueUrl,
      {
        ...config.issueParams,
        timestamp: Math.floor(Date.now() / 1000)
      }, 
      { 
        headers: { "Content-Type": "application/json; charset=utf-8" },
        timeout: 10000 
      }
    );
    return res.data;
  } catch (err) { 
    console.error(`❌ Error fetching ${site} issue:`, err.message); 
    return null; 
  }
}

async function fetchLastResults(site) {
  const config = SITE_CONFIGS[site];
  try {
    const res = await axiosInstance.post(
      config.resultsUrl,
      {
        ...config.resultsParams,
        timestamp: Math.floor(Date.now() / 1000)
      }, 
      { 
        headers: { "Content-Type": "application/json;charset=UTF-8" },
        timeout: 10000 
      }
    );

    if (!res.data?.data?.list) return [];
    
    return res.data.data.list.map(r => {
      const num = parseInt(r.result || r.number);
      if (isNaN(num)) return { result: "UNKNOWN", issueNumber: r.issue || r.issueNumber || "UNKNOWN" };
      return { 
        result: num <= 4 ? "SMALL" : "BIG", 
        issueNumber: r.issue || r.issueNumber || "UNKNOWN",
        actualNumber: num
      };
    }).filter(r => r.result !== "UNKNOWN");
  } catch (err) { 
    console.error(`❌ Error fetching ${site} results:`, err.message); 
    return []; 
  }
}

// ===== STRATEGIES =====
function countStrategy(results) {
  let bigCount = 0;
  let smallCount = 0;
  
  results.forEach(r => {
    if (r === "BIG") bigCount++;
    if (r === "SMALL") smallCount++;
  });
  
  const difference = Math.abs(bigCount - smallCount);
  
  if (difference >= 1 && difference <= 5) {
    return { prediction: "SMALL", formulaName: "KoZaw's Strategy", confidence: "Medium", calculation: `${bigCount}B-${smallCount}S=${difference} Small` };
  } else if (difference >= 6 || difference === 0) {
    return { prediction: "BIG", formulaName: "KoZaw's Strategy", confidence: "Medium", calculation: `${bigCount}B-${smallCount}S=${difference} Big` };
  }
  
  return null;
}

// ===== WIN/LOSE TRACKING =====
function updateUserStats(chatId, prediction, actualResult, site) {
  if (!userStats.has(chatId)) {
    userStats.set(chatId, { 
      [SITE_CONFIGS.BIGWIN.name]: { wins: 0, losses: 0, streak: 0, maxStreak: 0 },
      [SITE_CONFIGS.CKLOTTERY.name]: { wins: 0, losses: 0, streak: 0, maxStreak: 0 }
    });
  }
  
  const userStatsObj = userStats.get(chatId);
  

  if (!userStatsObj[site]) {
    userStatsObj[site] = { wins: 0, losses: 0, streak: 0, maxStreak: 0 };
  }
  
  const stats = userStatsObj[site];
  if (prediction === actualResult) { 
    stats.wins++; 
    stats.streak++; 
    if (stats.streak > stats.maxStreak) stats.maxStreak = stats.streak; 
    return "WIN"; 
  } else { 
    stats.losses++; 
    stats.streak = 0; 
    return "LOSE"; 
  }
}

function getUserStats(chatId, site) {
  if (!userStats.has(chatId)) {
    return { wins: 0, losses: 0, streak: 0, maxStreak: 0 };
  }
  
  const userStatsObj = userStats.get(chatId);
  
 
  if (!userStatsObj[site]) {
    userStatsObj[site] = { wins: 0, losses: 0, streak: 0, maxStreak: 0 };
  }
  
  const stats = userStatsObj[site];
  return { ...stats };
}

// ===== PREDICTION SYSTEM =====
async function getPredictionForUser(chatId, site) {
  const results = (await fetchLastResults(site)).map(r => r.result);
  if (!results.length) return { prediction: "UNKNOWN" };
  
  const strategy = countStrategy(results);
  if (strategy) {
    return strategy;
  }
  
  return { prediction: "BIG", formulaName: "KoZaw's Strategy", confidence: "Low", calculation: "No clear pattern detected" };
}

async function getPredictionMessage(chatId, site) {
  const issue = await fetchCurrentIssue(site);
  const period = issue?.data?.issueNumber || "Unknown";
  const now = new Date(); 
  const clock = now.toLocaleTimeString('en-US', { hour12: true });
  const result = await getPredictionForUser(chatId, site);
  
  let message = `🎰 *${site} Predictor Pro*\n📅 Period: \`${period}\`\n🕒 ${clock}\n\n`;
  
  if (result.prediction !== "UNKNOWN") {
    message += `🔮 *Prediction: ${result.prediction}*\n📊 Confidence: ${result.confidence}\n🧠 Strategy: ${result.formulaName}\n\n`;
    message += `⚠️ လိုက်ဆပြင်ဆင်ပြီးဆော့ပါ ဆတက်�နိုင်ပါတယ်\n\n`;
    message += `⚠️ အရင်းရဲ့ 20% နိုင်ရင်နားပါ`;
  } else {
    message += "⚠️ Unable to generate prediction right now.";
  }
  
  return message;
}

// ===== KEY DURATION FUNCTION =====
function getKeyDuration(chatId) {
  const expiry = keyExpiryTimers.get(chatId);
  if (!expiry) return "No active key";
  
  const remainingMs = expiry - Date.now();
  if (remainingMs <= 0) return "Key expired";
  
  const days = Math.floor(remainingMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((remainingMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
  
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ===== USER STATISTICS FUNCTION =====
function showUserStats() {
  console.log('\n===== USER STATISTICS =====');
  console.log(`Total users: ${users.size}`);
  console.log(`Verified users: ${verifiedUsers.size}`);
  console.log(`Active subscribers: ${Array.from(users.values()).filter(u => u.subscribed).length}`);
  
  console.log('\nUser details:');
  users.forEach((user, chatId) => {
    const userName = userNames.get(chatId) || 'Unknown User';
    const status = verifiedUsers.has(chatId) ? '✅ Verified' : '❌ Unverified';
    const subscribed = user.subscribed ? '✅ Subscribed' : '❌ Not subscribed';
    console.log(`${userName}: ${status}, ${subscribed}, Site: ${user.selectedSite}`);
  });
  
  console.log('==========================\n');
}

// ===== FEEDBACK SYSTEM =====
function saveFeedback(feedback) {
  feedbackData.push(feedback);
  
  try {
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedbackData, null, 2));
    console.log('✅ Feedback saved successfully');
  } catch (err) {
    console.error('❌ Error saving feedback:', err.message);
  }
}

// ===== TELEGRAM BOT =====
function getMainKeyboard(selectedSite) {
  if (selectedSite === "BIGWIN") {
    return {
      keyboard: [
        [{ text: "▶️ START" }, { text: "⏹️ STOP" }],
        [{ text: "🎲 CK LOTTERY" }],
        [{ text: "⏰ KEY DURATION" }, { text: "🔑 KEYရယူရန်" }],
        [{ text: "📝 FEEDBACK" }]
      ], 
      resize_keyboard: true
    };
  } else {
    return {
      keyboard: [
        [{ text: "▶️ START" }, { text: "⏹️ STOP" }],
        [{ text: "🎰 BIGWIN" }],
        [{ text: "⏰ KEY DURATION" }, { text: "🔑 KEYရယူရန်" }],
        [{ text: "📝 FEEDBACK" }]
      ], 
      resize_keyboard: true
    };
  }
}

function getSiteSelectionKeyboard() {
  return {
    keyboard: [
      [{ text: "🎰 BIGWIN" }, { text: "🎲 CK LOTTERY" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

// ===== KEY EXPIRY CHECK =====
function checkKeyExpiry() {
  const now = Date.now();
  
  for (const [chatId, expiry] of keyExpiryTimers.entries()) {
    if (now > expiry) {
      // Key expired for this user
      if (verifiedUsers.has(chatId)) {
        verifiedUsers.delete(chatId);
        awaitingKeyRenewal.add(chatId);
        
        // Send expiry message to user
        try {
          bot.sendMessage(chatId, "⛔ KEY IS EXPIRED. Please enter a new key to continue.", {
            reply_markup: { remove_keyboard: true }
          });
        } catch (err) {
          const userName = userNames.get(chatId) || 'Unknown User';
          console.error(`Error sending expiry message to ${userName}:`, err.message);
        }
      }
    }
  }
}

// ===== BOT COMMANDS =====
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || msg.from.username || 'Unknown User';
  userNames.set(chatId, userName);
  
  console.log(`🚀 /start command from user: ${userName}`);
  
  if (verifiedUsers.has(chatId)) {
    const expiry = keyExpiryTimers.get(chatId);
    if (expiry) {
      const remainingSec = Math.floor((expiry - Date.now()) / 1000);
      if (remainingSec > 0) {
        const user = users.get(chatId) || { selectedSite: "BIGWIN" };
        bot.sendMessage(chatId, `🎁 Your key is valid for another ${remainingSec} seconds.\nPredictions will start soon.`, { 
          reply_markup: getMainKeyboard(user.selectedSite) 
        });
      } else {
        verifiedUsers.delete(chatId);
        awaitingKeyRenewal.add(chatId);
        bot.sendMessage(chatId, "⛔ Your key has expired! Please enter your *new access key* to continue:", { 
          parse_mode: "Markdown" 
        });
      }
    }
  } else {
    bot.sendMessage(chatId, "🔑 Please enter your *access key* to activate:", { 
      parse_mode: "Markdown" 
    });
  }
});

bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id;
  const userName = userNames.get(chatId) || 'Unknown User';
  console.log(`⏹️ /stop command from user: ${userName}`);
  
  if (users.has(chatId)) {
    const user = users.get(chatId);
    user.subscribed = false;
    users.set(chatId, user);
  } else {
    users.set(chatId, { subscribed: false, selectedSite: "BIGWIN" });
  }
  
  bot.sendMessage(chatId, "🛑 Stopped predictions. Use /start or the START button to begin again.", {
    reply_markup: { remove_keyboard: true }
  });
});

bot.onText(/\/feedback/, async (msg) => {
  const chatId = msg.chat.id;
  const userName = userNames.get(chatId) || 'Unknown User';
  console.log(`📝 Feedback request from user: ${userName}`);
  
  awaitingFeedback.add(chatId);
  bot.sendMessage(chatId, "📝 Feedbackလေးရေးသွားလို့ရပါတယ်ဗျ");
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id; 
  const text = msg.text?.trim() || '';
  const userName = msg.from.first_name || msg.from.username || 'Unknown User';
  
  // Store user name
  userNames.set(chatId, userName);
  
  // Ignore commands and empty messages
  if (text.startsWith('/') || !text) return;
  
  console.log(`📩 Message from ${userName}: ${text}`);

  // Handle feedback
  if (awaitingFeedback.has(chatId)) {
    awaitingFeedback.delete(chatId);
    
    // Save feedback
    const feedback = {
      userId: chatId,
      userName: userName,
      message: text,
      timestamp: new Date().toISOString()
    };
    
    saveFeedback(feedback);
    console.log(`📝 Feedback from ${userName}: ${text}`);
    
    bot.sendMessage(chatId, "ကျေးဇူးတင်ပါသည် 🙏", {
      reply_markup: getMainKeyboard(users.get(chatId)?.selectedSite || "BIGWIN")
    });
    return;
  }

  // Handle site selection
  if (text === "🎰 BIGWIN" || text === "🎲 CK LOTTERY") {
    const selectedSite = text === "🎰 BIGWIN" ? "BIGWIN" : "CKLOTTERY";
    
    if (!users.has(chatId)) {
      users.set(chatId, { subscribed: false, selectedSite });
    } else {
      const user = users.get(chatId);
      user.selectedSite = selectedSite;
      users.set(chatId, user);
    }
    
    bot.sendMessage(chatId, `✅ Selected: ${selectedSite}`, {
      reply_markup: getMainKeyboard(selectedSite)
    });
    return;
  }

  // Handle key renewal for expired users
  if (awaitingKeyRenewal.has(chatId) || !verifiedUsers.has(chatId)) {
    // Send "Checking key" message
    const checkingMsg = await bot.sendMessage(chatId, "🔑 Key မှန်မမှန်စစ်နေပါသည် ခဏစောင့်ပါ......");
    
    const result = await checkKeyValidity(text, chatId);
    
    // Delete the checking message
    try {
      await bot.deleteMessage(chatId, checkingMsg.message_id);
    } catch (err) {
      console.error("Error deleting checking message:", err.message);
    }
    
    if (result.valid) {
      verifiedUsers.add(chatId);
      awaitingKeyRenewal.delete(chatId);
      
      // Initialize user with default site if not exists
      if (!users.has(chatId)) {
        users.set(chatId, { subscribed: true, selectedSite: "BIGWIN" });
      } else {
        const user = users.get(chatId);
        user.subscribed = true;
        users.set(chatId, user);
      }
      
      const expiry = keyExpiryTimers.get(chatId);
      const remainingSec = Math.floor((expiry - Date.now()) / 1000);
      
      // Ask user to select a site after key activation
      bot.sendMessage(chatId, `✅ Key Activated!\n⏳ Valid for another ${remainingSec} seconds.\n\nPlease select your prediction site:`, { 
        reply_markup: getSiteSelectionKeyboard() 
      });
    } else {
      bot.sendMessage(chatId, `❌ Access Denied: ${result.reason}\n\nEnter a valid key or contact @leostrike223 for assistance:`);
    }
    return;
  }

  // Get user's selected site
  const user = users.get(chatId) || { selectedSite: "BIGWIN" };
  const selectedSite = user.selectedSite;

  if (text.toUpperCase().includes('START')) {
    user.subscribed = true;
    users.set(chatId, user);
    bot.sendMessage(chatId, `✅ Subscribed to ${selectedSite} live predictions.`, { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }
  
  if (text.toUpperCase().includes('STOP')) {
    user.subscribed = false;
    users.set(chatId, user);
    bot.sendMessage(chatId, "🛑 Stopped predictions. Use START button to begin again.", { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }
  
  if (text.toUpperCase().includes('KEY DURATION') || text.toUpperCase().includes('DURATION')) { 
    const duration = getKeyDuration(chatId);
    bot.sendMessage(chatId, `⏰ Key Duration: ${duration}`, { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }
  
  if (text.toUpperCase().includes('KEYရယူရန်') || text.toUpperCase().includes('KEY')) {
    bot.sendMessage(chatId, "👤 Developer: @leostrike223", { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }

  if (text.toUpperCase().includes('FEEDBACK')) {
    awaitingFeedback.add(chatId);
    bot.sendMessage(chatId, "📝 Feedbackလေးရေးသွားလို့ရပါတယ်ဗျ");
    return;
  }

  // Handle site switching
  if (text.includes("BIGWIN") || text.includes("CK LOTTERY")) {
    const newSite = text.includes("BIGWIN") ? "BIGWIN" : "CKLOTTERY";
    user.selectedSite = newSite;
    users.set(chatId, user);
    
    bot.sendMessage(chatId, `✅ Switched to ${newSite} predictions`, { 
      reply_markup: getMainKeyboard(newSite) 
    });
    return;
  }

  const expiry = keyExpiryTimers.get(chatId);
  if (!expiry || Date.now() > expiry) {
    verifiedUsers.delete(chatId);
    awaitingKeyRenewal.add(chatId);
    bot.sendMessage(chatId, "⛔ KEY IS EXPIRED. Please enter your *new access key* to continue:", { 
      parse_mode: "Markdown",
      reply_markup: { remove_keyboard: true }
    });
    return;
  }

  const message = await getPredictionMessage(chatId, selectedSite);
  bot.sendMessage(chatId, message, { 
    parse_mode: 'Markdown', 
    reply_markup: getMainKeyboard(selectedSite) 
  });
});

// ===== BROADCAST LOOP =====
async function broadcastPrediction() {
  console.log("🔔 Starting prediction broadcast cycle");
  
  try {
    for (const [chatId, user] of users.entries()) {
      if (user.subscribed && verifiedUsers.has(chatId)) {
        const expiry = keyExpiryTimers.get(chatId);
        if (!expiry || Date.now() > expiry) {
          verifiedUsers.delete(chatId);
          awaitingKeyRenewal.add(chatId);
          bot.sendMessage(chatId, "⛔ KEY IS EXPIRED. Please enter your *new access key* to continue:", { 
            parse_mode: "Markdown",
            reply_markup: { remove_keyboard: true }
          });
          continue;
        }

        try {
          const site = user.selectedSite;
          const currentResults = await fetchLastResults(site);
          if (!currentResults.length) {
            console.log(`⚠️ No ${site} results available for prediction`);
            continue;
          }
          
          const latestResult = currentResults[0];
          const userName = userNames.get(chatId) || 'Unknown User';
          console.log(`📊 ${site} Latest result for ${userName}: ${latestResult.result} (${latestResult.actualNumber}) for issue ${latestResult.issueNumber}`);

          // 
          if (predictionHistory.has(chatId)) {
            const lastPrediction = predictionHistory.get(chatId);
            
            // 
            if (lastPrediction.site === site) {
              // Find the result that matches the prediction's issue number
              const matchingResult = currentResults.find(r => r.issueNumber === lastPrediction.issueNumber);
              
              if (matchingResult) {
                // We have a result for the predicted period
                const outcome = updateUserStats(chatId, lastPrediction.prediction, matchingResult.result, site);
                
                // Send simplified Win/Lose notification
                await bot.sendMessage(
                  chatId, 
                  `🎯 Last Prediction (${site}): ${lastPrediction.prediction}\n` +
                  `🎲 Actual Result: ${matchingResult.result} (${matchingResult.actualNumber})\n` +
                  `📊 Outcome: ${outcome === "WIN" ? "✅ WIN!" : "❌ LOSE"}`
                );
                
                // Remove the evaluated prediction
                predictionHistory.delete(chatId);
              }
            }
          }
          
          // Generate new prediction
          const predictionResult = await getPredictionForUser(chatId, site);
          if (predictionResult.prediction !== "UNKNOWN") {
            const issue = await fetchCurrentIssue(site);
            const currentIssueNumber = issue?.data?.issueNumber || "Unknown";
            
            // Store prediction with issue number for future 
            predictionHistory.set(chatId, {
              prediction: predictionResult.prediction,
              issueNumber: currentIssueNumber,
              timestamp: Date.now(),
              site: site
            });
          }
          
          const msg = await getPredictionMessage(chatId, site);
          await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
          
        } catch (err) {
          const userName = userNames.get(chatId) || 'Unknown User';
          console.error(`❌ Error sending to ${userName}:`, err.message);
        }
      }
    }
  } catch (error) {
    console.error("❌ Error in broadcast prediction cycle:", error.message);
  }
  
  // Check if any keys have expired
  checkKeyExpiry();
  
  console.log("✅ Prediction broadcast cycle completed");
}

// Start the prediction 
const predictionInterval = setInterval(broadcastPrediction, SLOT_SECONDS * 1000);

// Check key expiry
setInterval(checkKeyExpiry, 60000);

// Show user statistics 
setInterval(showUserStats, 300000);

console.log("✅ Combined Predictor Pro bot running for BIGWIN and CK Lottery...");
