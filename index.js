const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

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

// Track if bot is shutting down
let isShuttingDown = false;

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

// ===== FIREBASE REST KEY CHECK =====
async function checkKeyValidity(key, chatId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`馃攽 Checking key validity for chat: ${chatId} (Attempt ${i+1}/${retries})`);
      
      const res = await axiosInstance.get(`${FIREBASE_URL}/${key}.json`, {
        timeout: 10000
      });
      
      const data = res.data;
      if (!data) {
        console.log(`鉂� Invalid key format for chat: ${chatId}`);
        return { valid: false, reason: "Invalid Key" };
      }
      
      if (Date.now() > data.expiresAt) {
        console.log(`鉂� Expired key for chat: ${chatId}`);
        return { valid: false, reason: "Expired Key" };
      }
      
      keyExpiryTimers.set(chatId, data.expiresAt);

      const devices = data.devices ? Object.keys(data.devices).length : 0;
      if (devices >= (data.deviceLimit || 1)) {
        console.log(`鉂� Device limit reached for chat: ${chatId}`);
        return { valid: false, reason: "Device Limit Reached" };
      }
      
      console.log(`鉁� Valid key for chat: ${chatId}, expires: ${new Date(data.expiresAt).toLocaleString()}`);
      return { valid: true, reason: "Valid" };
      
    } catch (err) {
      console.error(`鉂� Firebase REST Error (Attempt ${i+1}/${retries}) for chat ${chatId}:`, err.message);
      
      if (i === retries - 1) {
        // Last attempt failed
        if (err.code === 'ECONNRESET') {
          return { valid: false, reason: "Connection Error: Please try again" };
        } else if (err.code === 'ETIMEDOUT') {
          return { valid: false, reason: "Connection Timeout: Please try again" };
        } else if (err.response && err.response.status === 404) {
          return { valid: false, reason: "Invalid Key" };
        } else {
          return { valid: false, reason: "Server Error: Please try again later" };
        }
      }
      
      // Wait before retrying (exponential backoff)
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
    console.error(`鉂� Error fetching ${site} issue:`, err.message); 
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
    console.error(`鉂� Error fetching ${site} results:`, err.message); 
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
  
  // Ensure the site stats exist
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
  
  // Ensure the site stats exist
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
  
  let message = `馃幇 *${site} Predictor Pro*\n馃搮 Period: \`${period}\`\n馃晵 ${clock}\n\n`;
  
  if (result.prediction !== "UNKNOWN") {
    message += `馃敭 *Prediction: ${result.prediction}*\n馃搳 Confidence: ${result.confidence}\n馃 Strategy: ${result.formulaName}\n\n`;
    message += `鈿狅笍 醼溼����醼横�嗎�曖�坚�勧�横�嗎�勧�横�曖�坚��羔�嗎�贬��丰�曖�� 醼嗎�愥��醼猴拷醼斸���勧�横�曖��愥�氠�篭n\n`;
    message += `鈿狅笍 醼♂�涐�勧�横�羔�涐�册�� 20% 醼斸���勧�横�涐�勧�横�斸��羔�曖�玚;
  } else {
    message += "鈿狅笍 Unable to generate prediction right now.";
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

// ===== TELEGRAM BOT =====
function getMainKeyboard(selectedSite) {
  if (selectedSite === "BIGWIN") {
    return {
      keyboard: [
        [{ text: "鈻讹笍 START" }, { text: "鈴癸笍 STOP" }],
        [{ text: "馃幉 CK LOTTERY" }],
        [{ text: "鈴� KEY DURATION" }, { text: "馃攽 KEY醼涐�氠�搬�涐�斸��" }]
      ], 
      resize_keyboard: true
    };
  } else {
    return {
      keyboard: [
        [{ text: "鈻讹笍 START" }, { text: "鈴癸笍 STOP" }],
        [{ text: "馃幇 BIGWIN" }],
        [{ text: "鈴� KEY DURATION" }, { text: "馃攽 KEY醼涐�氠�搬�涐�斸��" }]
      ], 
      resize_keyboard: true
    };
  }
}

function getSiteSelectionKeyboard() {
  return {
    keyboard: [
      [{ text: "馃幇 BIGWIN" }, { text: "馃幉 CK LOTTERY" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

// ===== KEY EXPIRY CHECK =====
function checkKeyExpiry() {
  const now = Date.now();
  let allKeysExpired = true;
  
  for (const [chatId, expiry] of keyExpiryTimers.entries()) {
    if (now < expiry) {
      allKeysExpired = false;
    } else {
      // Key expired for this user
      if (verifiedUsers.has(chatId)) {
        verifiedUsers.delete(chatId);
        awaitingKeyRenewal.add(chatId);
        
        // Send expiry message to user
        try {
          bot.sendMessage(chatId, "鉀� KEY IS EXPIRED. Please enter a new key to continue.", {
            reply_markup: { remove_keyboard: true }
          });
        } catch (err) {
          console.error(`Error sending expiry message to ${chatId}:`, err.message);
        }
      }
    }
  }
  
  // If all keys are expired, shut down the bot
  if (allKeysExpired && !isShuttingDown) {
    isShuttingDown = true;
    console.log("馃洃 All keys expired. Shutting down bot...");
    
    // Send shutdown message to all users
    users.forEach((user, chatId) => {
      if (user.subscribed) {
        try {
          bot.sendMessage(chatId, "馃敶 BOT SHUTDOWN: All keys have expired. The bot will stop functioning.", {
            reply_markup: { remove_keyboard: true }
          });
        } catch (err) {
          console.error(`Error sending shutdown message to ${chatId}:`, err.message);
        }
      }
    });
    
    // Stop the prediction loop
    clearInterval(predictionInterval);
    
    // Exit the process after a delay
    setTimeout(() => {
      console.log("鉁� Bot shutdown completed");
      process.exit(0);
    }, 5000);
  }
  
  return allKeysExpired;
}

// ===== BOT COMMANDS =====
bot.onText(/\/start/, async (msg) => {
  if (isShuttingDown) {
    bot.sendMessage(msg.chat.id, "馃敶 Bot is shutting down due to expired keys. Please contact the administrator.");
    return;
  }
  
  const chatId = msg.chat.id;
  console.log(`馃殌 /start command from chat: ${chatId}`);
  
  if (verifiedUsers.has(chatId)) {
    const expiry = keyExpiryTimers.get(chatId);
    if (expiry) {
      const remainingSec = Math.floor((expiry - Date.now()) / 1000);
      if (remainingSec > 0) {
        const user = users.get(chatId) || { selectedSite: "BIGWIN" };
        bot.sendMessage(chatId, `馃巵 Your key is valid for another ${remainingSec} seconds.\nPredictions will start soon.`, { 
          reply_markup: getMainKeyboard(user.selectedSite) 
        });
      } else {
        verifiedUsers.delete(chatId);
        awaitingKeyRenewal.add(chatId);
        bot.sendMessage(chatId, "鉀� Your key has expired! Please enter your *new access key* to continue:", { 
          parse_mode: "Markdown" 
        });
      }
    }
  } else {
    bot.sendMessage(chatId, "馃攽 Please enter your *access key* to activate:", { 
      parse_mode: "Markdown" 
    });
  }
});

bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id;
  console.log(`鈴癸笍 /stop command from chat: ${chatId}`);
  
  if (users.has(chatId)) {
    const user = users.get(chatId);
    user.subscribed = false;
    users.set(chatId, user);
  } else {
    users.set(chatId, { subscribed: false, selectedSite: "BIGWIN" });
  }
  
  bot.sendMessage(chatId, "馃洃 Stopped predictions. Use /start or the START button to begin again.", {
    reply_markup: { remove_keyboard: true }
  });
});

bot.on('message', async (msg) => {
  if (isShuttingDown) return;
  
  const chatId = msg.chat.id; 
  const text = msg.text?.trim() || '';
  
  // Ignore commands and empty messages
  if (text.startsWith('/') || !text) return;
  
  console.log(`馃摡 Message from ${chatId}: ${text}`);

  // Handle site selection
  if (text === "馃幇 BIGWIN" || text === "馃幉 CK LOTTERY") {
    const selectedSite = text === "馃幇 BIGWIN" ? "BIGWIN" : "CKLOTTERY";
    
    if (!users.has(chatId)) {
      users.set(chatId, { subscribed: false, selectedSite });
    } else {
      const user = users.get(chatId);
      user.selectedSite = selectedSite;
      users.set(chatId, user);
    }
    
    bot.sendMessage(chatId, `鉁� Selected: ${selectedSite}`, {
      reply_markup: getMainKeyboard(selectedSite)
    });
    return;
  }

  // Handle key renewal for expired users
  if (awaitingKeyRenewal.has(chatId) || !verifiedUsers.has(chatId)) {
    const result = await checkKeyValidity(text, chatId);
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
      bot.sendMessage(chatId, `鉁� Key Activated!\n鈴� Valid for another ${remainingSec} seconds.\n\nPlease select your prediction site:`, { 
        reply_markup: getSiteSelectionKeyboard() 
      });
    } else {
      bot.sendMessage(chatId, `鉂� Access Denied: ${result.reason}\nEnter a valid key:`);
    }
    return;
  }

  // Get user's selected site
  const user = users.get(chatId) || { selectedSite: "BIGWIN" };
  const selectedSite = user.selectedSite;

  if (text.toUpperCase().includes('START')) {
    user.subscribed = true;
    users.set(chatId, user);
    bot.sendMessage(chatId, `鉁� Subscribed to ${selectedSite} live predictions.`, { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }
  
  if (text.toUpperCase().includes('STOP')) {
    user.subscribed = false;
    users.set(chatId, user);
    bot.sendMessage(chatId, "馃洃 Stopped predictions. Use START button to begin again.", { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }
  
  if (text.toUpperCase().includes('KEY DURATION') || text.toUpperCase().includes('DURATION')) { 
    const duration = getKeyDuration(chatId);
    bot.sendMessage(chatId, `鈴� Key Duration: ${duration}`, { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }
  
  if (text.toUpperCase().includes('KEY醼涐�氠�搬�涐�斸��') || text.toUpperCase().includes('KEY')) {
    bot.sendMessage(chatId, "馃懁 Developer: @leostrike223", { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }

  // Handle site switching
  if (text.includes("BIGWIN") || text.includes("CK LOTTERY")) {
    const newSite = text.includes("BIGWIN") ? "BIGWIN" : "CKLOTTERY";
    user.selectedSite = newSite;
    users.set(chatId, user);
    
    bot.sendMessage(chatId, `鉁� Switched to ${newSite} predictions`, { 
      reply_markup: getMainKeyboard(newSite) 
    });
    return;
  }

  const expiry = keyExpiryTimers.get(chatId);
  if (!expiry || Date.now() > expiry) {
    verifiedUsers.delete(chatId);
    awaitingKeyRenewal.add(chatId);
    bot.sendMessage(chatId, "鉀� KEY IS EXPIRED. Please enter your *new access key* to continue:", { 
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
  if (isShuttingDown) return;
  
  console.log("馃敂 Starting prediction broadcast cycle");
  
  try {
    for (const [chatId, user] of users.entries()) {
      if (user.subscribed && verifiedUsers.has(chatId)) {
        const expiry = keyExpiryTimers.get(chatId);
        if (!expiry || Date.now() > expiry) {
          verifiedUsers.delete(chatId);
          awaitingKeyRenewal.add(chatId);
          bot.sendMessage(chatId, "鉀� KEY IS EXPIRED. Please enter your *new access key* to continue:", { 
            parse_mode: "Markdown",
            reply_markup: { remove_keyboard: true }
          });
          continue;
        }

        try {
          const site = user.selectedSite;
          const currentResults = await fetchLastResults(site);
          if (!currentResults.length) {
            console.log(`鈿狅笍 No ${site} results available for prediction`);
            continue;
          }
          
          const latestResult = currentResults[0];
          console.log(`馃搳 ${site} Latest result: ${latestResult.result} (${latestResult.actualNumber}) for issue ${latestResult.issueNumber}`);

          // Check if we have a prediction for the previous period that needs to be evaluated
          if (predictionHistory.has(chatId)) {
            const lastPrediction = predictionHistory.get(chatId);
            
            // Only evaluate if it's for the same site
            if (lastPrediction.site === site) {
              // Find the result that matches the prediction's issue number
              const matchingResult = currentResults.find(r => r.issueNumber === lastPrediction.issueNumber);
              
              if (matchingResult) {
                // We have a result for the predicted period
                const outcome = updateUserStats(chatId, lastPrediction.prediction, matchingResult.result, site);
                
                // Send simplified Win/Lose notification
                await bot.sendMessage(
                  chatId, 
                  `馃幆 Last Prediction (${site}): ${lastPrediction.prediction}\n` +
                  `馃幉 Actual Result: ${matchingResult.result} (${matchingResult.actualNumber})\n` +
                  `馃搳 Outcome: ${outcome === "WIN" ? "鉁� WIN!" : "鉂� LOSE"}`
                );
                
                // Remove the evaluated prediction
                predictionHistory.delete(chatId);
              }
            }
          }
          
          // Generate new prediction for current period
          const predictionResult = await getPredictionForUser(chatId, site);
          if (predictionResult.prediction !== "UNKNOWN") {
            const issue = await fetchCurrentIssue(site);
            const currentIssueNumber = issue?.data?.issueNumber || "Unknown";
            
            // Store prediction with issue number for future evaluation
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
          console.error(`鉂� Error sending to ${chatId}:`, err.message);
        }
      }
    }
  } catch (error) {
    console.error("鉂� Error in broadcast prediction cycle:", error.message);
  }
  
  // Check if all keys have expired
  checkKeyExpiry();
  
  console.log("鉁� Prediction broadcast cycle completed");
}

// Start the prediction loop
const predictionInterval = setInterval(broadcastPrediction, SLOT_SECONDS * 1000);

// Check key expiry every minute
setInterval(checkKeyExpiry, 60000);

// ===== SHUTDOWN =====
function shutdownHandler() {
  if (isShuttingDown) return;
  
  isShuttingDown = true;
  console.log("馃洃 Shutting down bot...");
  
  users.forEach((u, chatId) => { 
    if (u.subscribed) {
      try {
        bot.sendMessage(chatId, "馃毇 Bot stopped by administrator.", {
          reply_markup: { remove_keyboard: true }
        });
      } catch (err) {
        console.error(`Error sending shutdown message to ${chatId}:`, err.message);
      }
    }
  }); 
  
  // Stop the prediction loop
  clearInterval(predictionInterval);
  
  setTimeout(() => {
    console.log("鉁� Bot shutdown completed");
    process.exit(0);
  }, 3000);
}

process.on('SIGINT', shutdownHandler);
process.on('SIGTERM', shutdownHandler);

console.log("鉁� Combined Predictor Pro bot running for BIGWIN and CK Lottery...");
