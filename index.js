const https = require('https');
const http = require('http');

const TOKEN = '7983353841:AAFTdw4_79mqghgn29W5CgAnc01yUz2fIOE'; // Replace with your bot token
const SLOT_SECONDS = 30;
const FIREBASE_URL = "admin-panel-17295-default-rtdb.firebaseio.com";

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
    issueUrl: "api.bigwinqaz.com",
    issuePath: "/api/webapi/GetGameIssue",
    resultsUrl: "api.bigwinqaz.com",
    resultsPath: "/api/webapi/GetNoaverageEmerdList",
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
    issueUrl: "ckygjf6r.com",
    issuePath: "/api/webapi/GetGameIssue",
    resultsUrl: "ckygjf6r.com",
    resultsPath: "/api/webapi/GetNoaverageEmerdList",
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

// ===== HTTP REQUEST FUNCTION =====
function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const protocol = options.port === 443 ? https : http;
    const req = protocol.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.setTimeout(options.timeout || 15000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (postData) {
      req.write(JSON.stringify(postData));
    }
    
    req.end();
  });
}

// ===== TELEGRAM FUNCTIONS =====
async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: 10000
  };
  
  const data = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown'
  };
  
  if (replyMarkup) {
    data.reply_markup = replyMarkup;
  }
  
  try {
    await makeRequest(options, data);
    return true;
  } catch (error) {
    console.error('Error sending message:', error.message);
    return false;
  }
}

// ===== FIREBASE REST KEY CHECK =====
async function checkKeyValidity(key, chatId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`🔑 Checking key validity for chat: ${chatId} (Attempt ${i+1}/${retries})`);
      
      const options = {
        hostname: FIREBASE_URL,
        port: 443,
        path: `/users/${key}.json`,
        method: 'GET',
        timeout: 10000
      };
      
      const data = await makeRequest(options);
      
      if (!data) {
        console.log(`❌ Invalid key format for chat: ${chatId}`);
        return { valid: false, reason: "Invalid Key" };
      }
      
      if (Date.now() > data.expiresAt) {
        console.log(`❌ Expired key for chat: ${chatId}`);
        return { valid: false, reason: "Expired Key" };
      }
      
      keyExpiryTimers.set(chatId, data.expiresAt);

      const devices = data.devices ? Object.keys(data.devices).length : 0;
      if (devices >= (data.deviceLimit || 1)) {
        console.log(`❌ Device limit reached for chat: ${chatId}`);
        return { valid: false, reason: "Device Limit Reached" };
      }
      
      console.log(`✅ Valid key for chat: ${chatId}, expires: ${new Date(data.expiresAt).toLocaleString()}`);
      return { valid: true, reason: "Valid" };
      
    } catch (err) {
      console.error(`❌ Firebase REST Error (Attempt ${i+1}/${retries}) for chat ${chatId}:`, err.message);
      
      if (i === retries - 1) {
        // Last attempt failed
        if (err.code === 'ECONNRESET') {
          return { valid: false, reason: "Connection Error: Please try again" };
        } else if (err.code === 'ETIMEDOUT') {
          return { valid: false, reason: "Connection Timeout: Please try again" };
        } else if (err.message.includes('404')) {
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
    const postData = {
      ...config.issueParams,
      timestamp: Math.floor(Date.now() / 1000)
    };
    
    const options = {
      hostname: config.issueUrl,
      port: 443,
      path: config.issuePath,
      method: 'POST',
      headers: { 
        "Content-Type": "application/json; charset=utf-8",
        "Host": config.issueUrl
      },
      timeout: 10000
    };
    
    return await makeRequest(options, postData);
  } catch (err) { 
    console.error(`❌ Error fetching ${site} issue:`, err.message); 
    return null; 
  }
}

async function fetchLastResults(site) {
  const config = SITE_CONFIGS[site];
  try {
    const postData = {
      ...config.resultsParams,
      timestamp: Math.floor(Date.now() / 1000)
    };
    
    const options = {
      hostname: config.resultsUrl,
      port: 443,
      path: config.resultsPath,
      method: 'POST',
      headers: { 
        "Content-Type": "application/json;charset=UTF-8",
        "Host": config.resultsUrl
      },
      timeout: 10000
    };
    
    const res = await makeRequest(options, postData);
    
    if (!res?.data?.list) return [];
    
    return res.data.list.map(r => {
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

// ===== TELEGRAM BOT =====
function getMainKeyboard(selectedSite) {
  if (selectedSite === "BIGWIN") {
    return {
      keyboard: [
        [{ text: "▶️ START" }, { text: "⏹️ STOP" }],
        [{ text: "🎲 CK LOTTERY" }],
        [{ text: "⏰ KEY DURATION" }, { text: "🔑 KEYရယူရန်" }]
      ], 
      resize_keyboard: true
    };
  } else {
    return {
      keyboard: [
        [{ text: "▶️ START" }, { text: "⏹️ STOP" }],
        [{ text: "🎰 BIGWIN" }],
        [{ text: "⏰ KEY DURATION" }, { text: "🔑 KEYရယူရန်" }]
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
          sendTelegramMessage(chatId, "⛔ KEY IS EXPIRED. Please enter a new key to continue.", {
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
    console.log("🛑 All keys expired. Shutting down bot...");
    
    // Send shutdown message to all users
    users.forEach((user, chatId) => {
      if (user.subscribed) {
        try {
          sendTelegramMessage(chatId, "🔴 BOT SHUTDOWN: All keys have expired. The bot will stop functioning.", {
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
      console.log("✅ Bot shutdown completed");
      process.exit(0);
    }, 5000);
  }
  
  return allKeysExpired;
}

// ===== MESSAGE HANDLING =====
async function handleStartCommand(chatId) {
  if (isShuttingDown) {
    sendTelegramMessage(chatId, "🔴 Bot is shutting down due to expired keys. Please contact the administrator.");
    return;
  }
  
  console.log(`🚀 /start command from chat: ${chatId}`);
  
  if (verifiedUsers.has(chatId)) {
    const expiry = keyExpiryTimers.get(chatId);
    if (expiry) {
      const remainingSec = Math.floor((expiry - Date.now()) / 1000);
      if (remainingSec > 0) {
        const user = users.get(chatId) || { selectedSite: "BIGWIN" };
        sendTelegramMessage(chatId, `🎁 Your key is valid for another ${remainingSec} seconds.\nPredictions will start soon.`, { 
          reply_markup: getMainKeyboard(user.selectedSite) 
        });
      } else {
        verifiedUsers.delete(chatId);
        awaitingKeyRenewal.add(chatId);
        sendTelegramMessage(chatId, "⛔ Your key has expired! Please enter your *new access key* to continue:", { 
          parse_mode: "Markdown" 
        });
      }
    }
  } else {
    sendTelegramMessage(chatId, "🔑 Please enter your *access key* to activate:", { 
      parse_mode: "Markdown" 
    });
  }
}

async function handleStopCommand(chatId) {
  console.log(`⏹️ /stop command from chat: ${chatId}`);
  
  if (users.has(chatId)) {
    const user = users.get(chatId);
    user.subscribed = false;
    users.set(chatId, user);
  } else {
    users.set(chatId, { subscribed: false, selectedSite: "BIGWIN" });
  }
  
  sendTelegramMessage(chatId, "🛑 Stopped predictions. Use /start or the START button to begin again.", {
    reply_markup: { remove_keyboard: true }
  });
}

async function handleMessage(chatId, text) {
  if (isShuttingDown) return;
  
  console.log(`📩 Message from ${chatId}: ${text}`);

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
    
    sendTelegramMessage(chatId, `✅ Selected: ${selectedSite}`, {
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
      sendTelegramMessage(chatId, `✅ Key Activated!\n⏳ Valid for another ${remainingSec} seconds.\n\nPlease select your prediction site:`, { 
        reply_markup: getSiteSelectionKeyboard() 
      });
    } else {
      sendTelegramMessage(chatId, `❌ Access Denied: ${result.reason}\nEnter a valid key:`);
    }
    return;
  }

  // Get user's selected site
  const user = users.get(chatId) || { selectedSite: "BIGWIN" };
  const selectedSite = user.selectedSite;

  if (text === "▶️ START") {
    user.subscribed = true;
    users.set(chatId, user);
    sendTelegramMessage(chatId, `✅ Subscribed to ${selectedSite} live predictions.`, { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }
  
  if (text === "⏹️ STOP") {
    user.subscribed = false;
    users.set(chatId, user);
    sendTelegramMessage(chatId, "🛑 Stopped predictions. Use START button to begin again.", { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }
  
  if (text === "⏰ KEY DURATION") { 
    const duration = getKeyDuration(chatId);
    sendTelegramMessage(chatId, `⏰ Key Duration: ${duration}`, { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }
  
  if (text === "🔑 KEYရယူရန်") {
    sendTelegramMessage(chatId, "👤 Developer: @leostrike223", { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }

  // Handle site switching
  if (text === "🎰 BIGWIN" || text === "🎲 CK LOTTERY") {
    const newSite = text === "🎰 BIGWIN" ? "BIGWIN" : "CKLOTTERY";
    user.selectedSite = newSite;
    users.set(chatId, user);
    
    sendTelegramMessage(chatId, `✅ Switched to ${newSite} predictions`, { 
      reply_markup: getMainKeyboard(newSite) 
    });
    return;
  }

  const expiry = keyExpiryTimers.get(chatId);
  if (!expiry || Date.now() > expiry) {
    verifiedUsers.delete(chatId);
    awaitingKeyRenewal.add(chatId);
    sendTelegramMessage(chatId, "⛔ KEY IS EXPIRED. Please enter your *new access key* to continue:", { 
      parse_mode: "Markdown",
      reply_markup: { remove_keyboard: true }
    });
    return;
  }

  const message = await getPredictionMessage(chatId, selectedSite);
  sendTelegramMessage(chatId, message, { 
    parse_mode: 'Markdown', 
    reply_markup: getMainKeyboard(selectedSite) 
  });
}

// ===== BROADCAST LOOP =====
async function broadcastPrediction() {
  if (isShuttingDown) return;
  
  console.log("🔔 Starting prediction broadcast cycle");
  
  try {
    for (const [chatId, user] of users.entries()) {
      if (user.subscribed && verifiedUsers.has(chatId)) {
        const expiry = keyExpiryTimers.get(chatId);
        if (!expiry || Date.now() > expiry) {
          verifiedUsers.delete(chatId);
          awaitingKeyRenewal.add(chatId);
          sendTelegramMessage(chatId, "⛔ KEY IS EXPIRED. Please enter your *new access key* to continue:", { 
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
          console.log(`📊 ${site} Latest result: ${latestResult.result} (${latestResult.actualNumber}) for issue ${latestResult.issueNumber}`);

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
                await sendTelegramMessage(
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
          await sendTelegramMessage(chatId, msg, { parse_mode: 'Markdown' });
          
        } catch (err) {
          console.error(`❌ Error sending to ${chatId}:`, err.message);
        }
      }
    }
  } catch (error) {
    console.error("❌ Error in broadcast prediction cycle:", error.message);
  }
  
  // Check if all keys have expired
  checkKeyExpiry();
  
  console.log("✅ Prediction broadcast cycle completed");
}

// ===== POLLING FOR UPDATES =====
let lastUpdateId = 0;

async function getUpdates() {
  if (isShuttingDown) return;
  
  try {
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`,
      method: 'GET',
      timeout: 35000
    };
    
    const response = await makeRequest(options);
    
    if (response && response.ok && response.result.length > 0) {
      for (const update of response.result) {
        if (update.update_id > lastUpdateId) {
          lastUpdateId = update.update_id;
        }
        
        if (update.message) {
          const msg = update.message;
          const chatId = msg.chat.id;
          const text = msg.text || '';
          
          // Handle commands
          if (text.startsWith('/start')) {
            handleStartCommand(chatId);
          } else if (text.startsWith('/stop')) {
            handleStopCommand(chatId);
          } else {
            handleMessage(chatId, text);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error getting updates:', error.message);
  }
  
  // Continue polling
  setTimeout(getUpdates, 1000);
}

// Start the prediction loop
const predictionInterval = setInterval(broadcastPrediction, SLOT_SECONDS * 1000);

// Check key expiry every minute
setInterval(checkKeyExpiry, 60000);

// Start polling for updates
getUpdates();

// ===== SHUTDOWN =====
function shutdownHandler() {
  if (isShuttingDown) return;
  
  isShuttingDown = true;
  console.log("🛑 Shutting down bot...");
  
  users.forEach((u, chatId) => { 
    if (u.subscribed) {
      try {
        sendTelegramMessage(chatId, "🚫 Bot stopped by administrator.", {
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
    console.log("✅ Bot shutdown completed");
    process.exit(0);
  }, 3000);
}

process.on('SIGINT', shutdownHandler);
process.on('SIGTERM', shutdownHandler);

console.log("✅ Combined Predictor Pro bot running for BIGWIN and CK Lottery...");