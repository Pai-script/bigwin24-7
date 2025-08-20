const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = '7744705463:AAEf1w3i8k6yPqfCEmuCMOsjbzspVRNIjXM';
const bot = new TelegramBot(TOKEN, { polling: true });

const SLOT_SECONDS = 30;
const FIREBASE_URL = "https://admin-panel-17295-default-rtdb.firebaseio.com/users";

// ===== USER SYSTEM =====
const verifiedUsers = new Set();
const users = new Map();
const userStats = new Map();
const predictionHistory = new Map();
const lastKnownResults = new Map();
const lastOutcomes = new Map();
const keyExpiryTimers = new Map(); // store key expiry timestamps per user
const awaitingKeyRenewal = new Set(); // track users who need to renew their key

// ===== FIREBASE REST KEY CHECK =====
async function checkKeyValidity(key, chatId) {
  try {
    const res = await axios.get(`${FIREBASE_URL}/${key}.json`);
    const data = res.data;
    if (!data) return { valid: false, reason: "Invalid Key" };
    if (Date.now() > data.expiresAt) return { valid: false, reason: "Expired Key" };
    
    keyExpiryTimers.set(chatId, data.expiresAt); // store expiry time

    const devices = data.devices ? Object.keys(data.devices).length : 0;
    if (devices >= (data.deviceLimit || 1)) return { valid: false, reason: "Device Limit Reached" };
    return { valid: true, reason: "Valid" };
  } catch (err) {
    console.error("❌ Firebase REST Error:", err.message);
    return { valid: false, reason: "Firebase Error" };
  }
}

// ===== API FUNCTIONS =====
async function fetchCurrentIssue() {
  try {
    const res = await axios.post("https://api.bigwinqaz.com/api/webapi/GetGameIssue", {
      typeId: 30, language: 7,
      random: "261a65ff89cf41b0aa6d41d9d90325b0",
      signature: "8F29D6BBF728613DD4BB349D5175AD15",
      timestamp: Math.floor(Date.now() / 1000)
    }, { headers: { "Content-Type": "application/json; charset=utf-8" } });
    return res.data;
  } catch (err) { console.error("❌ Error fetching issue:", err.message); return null; }
}

async function fetchLastResults() {
  try {
    const res = await axios.post("https://api.bigwinqaz.com/api/webapi/GetNoaverageEmerdList", {
      pageSize: 10, pageNo: 1, typeId: 30, language: 7,
      random: "248642421cd847fbbf3d33630ee82d5e",
      signature: "FE3C4A5BD61772C9B727C1553CA60ACC",
      timestamp: Math.floor(Date.now() / 1000)
    }, { headers: { "Content-Type": "application/json;charset=UTF-8" } });

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
  } catch (err) { console.error("❌ Error fetching results:", err.message); return []; }
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
function updateUserStats(chatId,prediction,actualResult){
  if(!userStats.has(chatId)) userStats.set(chatId,{wins:0,losses:0,streak:0,maxStreak:0});
  const stats=userStats.get(chatId);
  if(prediction===actualResult){ stats.wins++; stats.streak++; if(stats.streak>stats.maxStreak) stats.maxStreak=stats.streak; return "WIN"; }
  else { stats.losses++; stats.streak=0; return "LOSE"; }
}

function getUserStats(chatId){
  if(!userStats.has(chatId)) return {wins:0,losses:0,streak:0,maxStreak:0};
  const stats=userStats.get(chatId);
  return {...stats};
}

// ===== PREDICTION SYSTEM =====
async function getPredictionForUser(chatId){
  const results=(await fetchLastResults()).map(r=>r.result);
  if(!results.length) return {prediction:"UNKNOWN"};
  
  const strategy = countStrategy(results);
  if (strategy) {
    return strategy;
  }
  
  return {prediction:"BIG", formulaName:"KoZaw's Strategy", confidence:"Low", calculation: "No clear pattern detected"};
}

async function getPredictionMessage(chatId){
  const issue=await fetchCurrentIssue();
  const period=issue?.data?.issueNumber || "Unknown";
  const now=new Date(); const clock=now.toLocaleTimeString('en-US',{hour12:true});
  const result=await getPredictionForUser(chatId);
  
  let message=`🎰 *BIGWIN Predictor Pro*\n📅 Period: \`${period}\`\n🕒 ${clock}\n\n`;
  if(result.prediction!=="UNKNOWN"){
    message+=`🔮 *Prediction: ${result.prediction}*\n📊 Confidence: ${result.confidence}\n🧠 Strategy: ${result.formulaName}\n\n`;
    
    // Add all warning texts
    message += `⚠️ လိုက်ဆပြင်ဆင်ပြီးဆော့ပါ ဆတက်နိုင်ပါတယ်\n\n`;
    message += `⚠️ အရင်းရဲ့ 20% နိုင်ရင်နားပါ`;
  } else message+="⚠️ Unable to generate prediction right now.";
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
const mainKeyboard={keyboard:[[ {text:"▶️ START"},{text:"⏹️ STOP"}],[{text:"⏰ KEY DURATION"},{text:"🔑 KEYရယူရန်"}]], resize_keyboard:true};

bot.onText(/\/start/,msg=>{
  const chatId=msg.chat.id;
  if(verifiedUsers.has(chatId)){
    const expiry=keyExpiryTimers.get(chatId);
    if(expiry){
      const remainingSec=Math.floor((expiry-Date.now())/1000);
      if(remainingSec>0) bot.sendMessage(chatId,`🎁 Your key is valid for another ${remainingSec} seconds.\nPredictions will start soon.`,{reply_markup:mainKeyboard});
      else {
        verifiedUsers.delete(chatId);
        awaitingKeyRenewal.add(chatId);
        bot.sendMessage(chatId,"⛔ Your key has expired! Please enter your *new access key* to continue:",{parse_mode:"Markdown"});
      }
    }
  } else bot.sendMessage(chatId,"🔑 Please enter your *access key* to activate:",{parse_mode:"Markdown"});
});

bot.on('message', async msg=>{
  const chatId=msg.chat.id; const text=msg.text?.trim()||'';
  if(text.startsWith('/')) return;

  // Handle key renewal for expired users
  if(awaitingKeyRenewal.has(chatId) || !verifiedUsers.has(chatId)){
    const result=await checkKeyValidity(text,chatId);
    if(result.valid){
      verifiedUsers.add(chatId);
      awaitingKeyRenewal.delete(chatId);
      users.set(chatId,{subscribed:true});
      const expiry=keyExpiryTimers.get(chatId);
      const remainingSec=Math.floor((expiry-Date.now())/1000);
      bot.sendMessage(chatId,`✅ Key Activated!\n⏳ Valid for another ${remainingSec} seconds.\nPredictions will start once key is active.`,{reply_markup:mainKeyboard});
    } else {
      bot.sendMessage(chatId,`❌ Access Denied: ${result.reason}\nEnter a valid key:`);
    }
    return;
  }

  if(text.toUpperCase().includes('START')){users.set(chatId,{subscribed:true}); bot.sendMessage(chatId,"✅ Subscribed to live predictions.",{reply_markup:mainKeyboard}); return;}
  if(text.toUpperCase().includes('STOP')){users.set(chatId,{subscribed:false}); bot.sendMessage(chatId,"🛑 Unsubscribed.",{reply_markup:mainKeyboard}); return;}
  if(text.toUpperCase().includes('KEY DURATION') || text.toUpperCase().includes('DURATION')){ 
    const duration = getKeyDuration(chatId);
    bot.sendMessage(chatId,`⏰ Key Duration: ${duration}`,{reply_markup:mainKeyboard}); 
    return;
  }
  if(text.toUpperCase().includes('KEYရယူရန်') || text.toUpperCase().includes('KEY')){bot.sendMessage(chatId,"👤 Developer: @leostrike223",{reply_markup:mainKeyboard}); return;}

  const expiry=keyExpiryTimers.get(chatId);
  if(!expiry || Date.now()>expiry){
    verifiedUsers.delete(chatId);
    awaitingKeyRenewal.add(chatId);
    bot.sendMessage(chatId,"⛔ Your key has expired! Please enter your *new access key* to continue:",{parse_mode:"Markdown"});
    return;
  }

  const message=await getPredictionMessage(chatId);
  bot.sendMessage(chatId,message,{parse_mode:'Markdown',reply_markup:mainKeyboard});
});

// ===== BROADCAST LOOP =====
async function broadcastPrediction(){
  const currentResults=await fetchLastResults();
  if(!currentResults.length) return;
  const latestResult=currentResults[0];

  for(const [chatId,user] of users.entries()){
    if(user.subscribed && verifiedUsers.has(chatId)){
      const expiry=keyExpiryTimers.get(chatId);
      if(!expiry || Date.now()>expiry) {
        verifiedUsers.delete(chatId);
        awaitingKeyRenewal.add(chatId);
        bot.sendMessage(chatId,"⛔ Your key has expired! Please enter your *new access key* to continue:",{parse_mode:"Markdown"});
        continue;
      }

      try{
        if(predictionHistory.has(chatId) && lastKnownResults.has(chatId)){
          const lastPrediction=predictionHistory.get(chatId);
          const lastKnownResult=lastKnownResults.get(chatId);
          if(latestResult.issueNumber!==lastKnownResult.issueNumber){
            const outcome=updateUserStats(chatId,lastPrediction,latestResult.result);
            lastOutcomes.set(chatId,{prediction:lastPrediction,actual:latestResult.result,outcome});
            await bot.sendMessage(chatId,`🎯 Last Prediction: ${lastPrediction}\n🎲 Actual Result: ${latestResult.result} (${latestResult.actualNumber})\n📊 Outcome: ${outcome==="WIN"?"✅ WIN!":"❌ LOSE"}`);
          }
        }
        const predictionResult=await getPredictionForUser(chatId);
        if(predictionResult.prediction!=="UNKNOWN"){predictionHistory.set(chatId,predictionResult.prediction); lastKnownResults.set(chatId,latestResult);}
        const msg=await getPredictionMessage(chatId);
        await bot.sendMessage(chatId,msg,{parse_mode:'Markdown'});
      } catch(err){console.error(`❌ Error sending to ${chatId}:`,err.message);}
    }
  }
}
setInterval(broadcastPrediction,SLOT_SECONDS*1000);

// ===== SHUTDOWN =====
function shutdownHandler(){users.forEach((u,chatId)=>{ if(u.subscribed) bot.sendMessage(chatId,"🚫 Bot stopped."); }); process.exit(0);}
process.on('SIGINT',shutdownHandler);
process.on('SIGTERM',shutdownHandler);

console.log("✅ BIGWIN Predictor Pro bot running with key life check...");
