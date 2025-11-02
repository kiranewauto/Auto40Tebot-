// index.js
import express from "express";
import { Telegraf, Markup } from "telegraf";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import fs from "fs-extra";
import path from "path";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const BASE_URL = process.env.BASE_URL || ""; // set in Render: https://your-app.onrender.com
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // set in Render
const WAVESPEED_KEY = process.env.WAVESPEED_KEY; // set in Render
const APIFY_TOKEN = process.env.APIFY_TOKEN; // optional (Apify)
const APIFY_ACTOR = process.env.APIFY_ACTOR || "apify/instagram-scraper";
const INSTASCRAPE_PROVIDER = process.env.INSTASCRAPE_PROVIDER || "apify";
const ADMIN_ID = process.env.ADMIN_ID; // your Telegram numeric ID (set in Render)
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 27);

if (!TELEGRAM_TOKEN) {
  console.error("ERROR: TELEGRAM_TOKEN not provided in env");
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error("ERROR: ADMIN_ID not provided in env");
  process.exit(1);
}

// Data files (persist across restarts)
const DATA_DIR = path.join(process.cwd(), "data");
const USERS_FILE = path.join(DATA_DIR, "users.json"); // { chatId: { status: 'pending'|'approved'|'denied', username, requestedAt } }
const USAGE_FILE = path.join(DATA_DIR, "usage.json"); // { YYYY-MM-DD: { chatId: count, ... }, ... }
fs.ensureDirSync(DATA_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeJsonSync(USERS_FILE, {});
if (!fs.existsSync(USAGE_FILE)) fs.writeJsonSync(USAGE_FILE, {});

function readUsers() { return fs.readJsonSync(USERS_FILE); }
function writeUsers(obj) { fs.writeJsonSync(USERS_FILE, obj, { spaces: 2 }); }
function readUsage() { return fs.readJsonSync(USAGE_FILE); }
function writeUsage(obj) { fs.writeJsonSync(USAGE_FILE, obj, { spaces: 2 }); }

function todayStr() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

// create bot and express app (webhook)
const bot = new Telegraf(TELEGRAM_TOKEN);
const app = express();
app.use(bodyParser.json({ limit: "15mb" }));

// Sessions in memory while user composes images
const sessions = new Map(); // chatId -> { modelName, baseImages:[], refImages:[], instagramHandles:[] }

// ---------- Utility helpers ----------
async function safeSendMessage(chatId, text, extra) {
  try {
    await bot.telegram.sendMessage(chatId, text, extra);
  } catch (e) {
    console.error("sendMessage failed", e);
  }
}
async function safeSendPhoto(chatId, url, caption) {
  try {
    await bot.telegram.sendPhoto(chatId, url, { caption });
  } catch (e) {
    console.error("sendPhoto failed", e);
  }
}

// ---------- User management ----------
function getUserStatus(chatId) {
  const users = readUsers();
  return users[String(chatId)] ? users[String(chatId)].status : null;
}
function ensureUserPending(chatId, username) {
  const users = readUsers();
  if (!users[String(chatId)]) {
    users[String(chatId)] = { status: "pending", username: username || null, requestedAt: new Date().toISOString() };
    writeUsers(users);
    return true;
  }
  return false;
}
function setUserStatus(chatId, status) {
  const users = readUsers();
  users[String(chatId)] = users[String(chatId)] || {};
  users[String(chatId)].status = status;
  if (!users[String(chatId)].requestedAt) users[String(chatId)].requestedAt = new Date().toISOString();
  writeUsers(users);
}
function listPending() {
  const users = readUsers();
  return Object.entries(users).filter(([id,v])=>v.status==="pending").map(([id,v])=>({ chatId: id, username: v.username }));
}
function listApproved() {
  const users = readUsers();
  return Object.entries(users).filter(([id,v])=>v.status==="approved").map(([id,v])=>({ chatId: id, username: v.username }));
}

// ---------- Usage tracking ----------
function getUsageCount(chatId) {
  const usage = readUsage();
  const today = todayStr();
  if (!usage[today]) return 0;
  return usage[today][String(chatId)] || 0;
}
function addUsage(chatId, add) {
  const usage = readUsage();
  const today = todayStr();
  usage[today] = usage[today] || {};
  usage[today][String(chatId)] = (usage[today][String(chatId)] || 0) + add;
  writeUsage(usage);
}

// ---------- Apify Instagram fetcher (uses Apify actor run) ----------
async function fetchInstagramImagesApify(username, limit=6) {
  if (!APIFY_TOKEN) throw new Error("Apify token not configured");
  // Actor run endpoint
  const runUrl = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs?token=${APIFY_TOKEN}`;
  // actor input accepted may vary; typical input body:
  const input = { username, resultsLimit: limit };
  const runRes = await fetch(runUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: input })
  });
  const runJson = await runRes.json();
  // get dataset id / items URL: this varies by actor; many actors return defaultDatasetId
  const datasetId = runJson.defaultDatasetId || runJson.data?.defaultDataset?.id;
  if (!datasetId) throw new Error("Apify run did not return dataset id; check actor");
  // fetch items
  const itemsUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`;
  const itemsRes = await fetch(itemsUrl);
  const items = await itemsRes.json();
  // items structure depends on actor; common fields: 'image', 'display_url', 'imageUrl', etc.
  const urls = [];
  for (const it of items) {
    const u = it.image || it.display_url || it.imageUrl || it.images?.[0];
    if (u) urls.push(u);
    if (urls.length >= limit) break;
  }
  return urls;
}

async function fetchInstagramDirect(username, limit=6) {
  // fragile but sometimes works (no API)
  const url = `https://www.instagram.com/${username}/?__a=1&__d=dis`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("Instagram public endpoint blocked");
  const j = await res.json();
  const edges = j.graphql?.user?.edge_owner_to_timeline_media?.edges || j.entry_data?.ProfilePage?.[0]?.graphql?.user?.edge_owner_to_timeline_media?.edges;
  if (!edges) throw new Error("No media found");
  const imgs = edges.slice(0, limit).map(e => e.node.display_url || e.node.thumbnail_src).filter(Boolean);
  return imgs;
}
async function fetchInstagram(username, limit=6) {
  if (INSTASCRAPE_PROVIDER === "apify") return await fetchInstagramImagesApify(username, limit);
  return await fetchInstagramDirect(username, limit);
}

// ---------- Wavespeed generation (Seedream v4/edit) ----------
async function callWavespeedEdit({ baseImage, refImage, prompt, seed=null }) {
  if (!WAVESPEED_KEY) throw new Error("Wavespeed key not configured");
  const payload = {
    enable_base64_output: false,
    enable_sync_mode: true,
    images: [refImage],
    mask_image_url: baseImage,
    prompt
  };
  if (seed !== null) payload.seed = seed;
  const res = await fetch("https://api.wavespeed.ai/api/v3/bytedance/seedream-v4/edit", {
    method: "POST",
    headers: { "Content-Type":"application/json", Authorization: `Bearer ${WAVESPEED_KEY}` },
    body: JSON.stringify(payload)
  });
  return await res.json();
}

// ---------- Bot command handlers ----------
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  await ctx.reply(
    "🔒 This bot is private. Tap Request Access to ask the admin for permission.",
    Markup.inlineKeyboard([ Markup.button.callback("Request Access", `request_${chatId}`) ])
  );
});

// When user clicks the Request Access button we get a callback_query; we send admin a message
bot.on('callback_query', async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;
    const from = ctx.callbackQuery.from;
    if (data && data.startsWith("request_")) {
      const chatIdStr = data.split("_")[1];
      const requesterChatId = ctx.from.id;
      const requesterUsername = ctx.from.username || `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`;

      // create pending user if not exists
      ensureUserPending(requesterChatId, requesterUsername);

      // notify requester
      await ctx.answerCbQuery("Access request sent to admin.");
      await ctx.reply("✅ Request sent. You'll be notified when approved.");

      // notify admin with Approve/Deny inline buttons
      const adminMsg = `🆕 Access Request\nUser: @${requesterUsername}\nChat ID: ${requesterChatId}`;
      await bot.telegram.sendMessage(ADMIN_ID, adminMsg, Markup.inlineKeyboard([
        Markup.button.callback("✅ Approve", `approve_${requesterChatId}`),
        Markup.button.callback("🚫 Deny", `deny_${requesterChatId}`)
      ]));
    } else if (data && data.startsWith("approve_") && String(ctx.from.id) === String(ADMIN_ID)) {
      const cid = data.split("_")[1];
      setUserStatus(cid, "approved");
      await ctx.answerCbQuery("User approved.");
      await bot.telegram.sendMessage(cid, "✅ You have been approved! You can now use /model and /generate.");
      await ctx.editMessageText(`Approved user ${cid}`);
    } else if (data && data.startsWith("deny_") && String(ctx.from.id) === String(ADMIN_ID)) {
      const cid = data.split("_")[1];
      setUserStatus(cid, "denied");
      await ctx.answerCbQuery("User denied.");
      await bot.telegram.sendMessage(cid, "🚫 Your access request was denied by the admin.");
      await ctx.editMessageText(`Denied user ${cid}`);
    } else {
      await ctx.answerCbQuery();
    }
  } catch (e) {
    console.error("callback_query handler err", e);
  }
});

// text commands for model / generate / status / admin listing
bot.command("model", async (ctx) => {
  const chatId = ctx.chat.id;
  const args = ctx.message.text.split(" ").slice(1);
  const modelName = args.join(" ").trim();
  if (!modelName) return ctx.reply("Usage: /model <Model Name>");
  if (getUserStatus(chatId) !== "approved") {
    return ctx.reply("🔒 You are not approved yet. Tap Request Access first.");
  }
  const s = sessions.get(chatId) || { baseImages: [], refImages: [], instagramHandles: [] };
  s.modelName = modelName;
  sessions.set(chatId, s);
  ctx.reply(`Model name set to: ${modelName}. Now send base images (1-5), then reference images (1-3) or use /fetch_instagram <username>.`);
});

bot.command("status", async (ctx) => {
  const chatId = ctx.chat.id;
  const users = readUsers();
  const status = users[String(chatId)] ? users[String(chatId)].status : "none";
  const usageCount = getUsageCount(chatId);
  await ctx.reply(`Status: ${status}\nToday usage: ${usageCount}/${DAILY_LIMIT}`);
});

bot.command("fetch_instagram", async (ctx) => {
  const chatId = ctx.chat.id;
  if (getUserStatus(chatId) !== "approved") return ctx.reply("🔒 Not approved.");
  const parts = ctx.message.text.split(" ").slice(1);
  if (!parts || !parts[0]) return ctx.reply("Usage: /fetch_instagram <username>");
  const username = parts[0].replace("@", "");
  await ctx.reply(`Fetching recent images for @${username}...`);
  try {
    const imgs = await fetchInstagram(username, 6);
    if (!imgs || imgs.length === 0) return ctx.reply("No images found.");
    const s = sessions.get(chatId) || { baseImages: [], refImages: [], instagramHandles: [] };
    s.refImages = s.refImages.concat(imgs);
    sessions.set(chatId, s);
    await ctx.reply(`Added ${imgs.length} reference images from @${username}. Send /generate when ready.`);
  } catch (e) {
    console.error("fetch_instagram error", e);
    ctx.reply(`Failed to fetch Instagram images: ${e.message}`);
  }
});

bot.command("generate", async (ctx) => {
  const chatId = ctx.chat.id;
  if (getUserStatus(chatId) !== "approved") return ctx.reply("🔒 Not approved.");
  const s = sessions.get(chatId);
  if (!s || !s.modelName) return ctx.reply("Set model name first with /model <Name> and upload base images.");
  if (!s.baseImages || s.baseImages.length < 1) return ctx.reply("Upload at least one base image (model).");
  if (!s.refImages || s.refImages.length < 1) return ctx.reply("Upload at least one reference image (style/pose) or use /fetch_instagram.");

  // pick up to 3 refs and 2 variations per ref (configurable)
  const refs = s.refImages.slice(0, 3);
  const variationsPerRef = 2;
  const totalImages = refs.length * variationsPerRef;

  const usedToday = getUsageCount(chatId);
  if (usedToday + totalImages > DAILY_LIMIT) {
    return ctx.reply(`⚠️ Daily limit exceeded. You have used ${usedToday}/${DAILY_LIMIT} images today. This request would generate ${totalImages}.`);
  }

  await ctx.reply(`Generating ${totalImages} images (may take ~20-60s)...`);

  const generatedUrls = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    for (let v = 0; v < variationsPerRef; v++) {
      const seed = Math.floor(Math.random() * 100000);
      const prompt = `A realistic portrait of ${s.modelName}, matching the pose/outfit of the reference, ultra realistic, cinematic lighting, consistent face, photo quality.`;
      try {
        const wres = await callWavespeedEdit({ baseImage: s.baseImages[0], refImage: ref, prompt, seed });
        // find image URL in response (varies)
        const url = wres?.data?.image_url || wres?.data?.[0]?.url || wres?.output?.[0]?.url || null;
        if (url) {
          generatedUrls.push(url);
          await safeSendPhoto(chatId, url, `Result ${generatedUrls.length}/${totalImages}`);
        } else {
          console.warn("No url in wavespeed response", wres);
          await ctx.reply("⚠️ Generation returned no image for one variation.");
        }
      } catch (e) {
        console.error("Generation error", e);
        await ctx.reply("⚠️ Error during generation. Try again later.");
      }
    }
  }

  // update usage
  addUsage(chatId, totalImages);
  // clear session
  sessions.delete(chatId);
  await ctx.reply(`✅ Done — ${generatedUrls.length} images generated. Today's usage updated.`);
});

// receive photos (base or ref)
bot.on("message", async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    // ignore non-photo messages here (commands handled above)
    if (!ctx.message.photo || ctx.message.photo.length === 0) return;
    // check approval
    const status = getUserStatus(chatId);
    if (status !== "approved") {
      // create pending user if not exists
      ensureUserPending(chatId, ctx.from.username || `${ctx.from.first_name||""}`);
      return ctx.reply("🔒 You're not approved yet. Tap Request Access or wait for admin approval.");
    }

    // choose largest size
    const largest = ctx.message.photo[ctx.message.photo.length - 1];
    const fileId = largest.file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;

    // put into session: heuristics:
    const s = sessions.get(chatId) || { baseImages: [], refImages: [], instagramHandles: [] };
    // If modelName not set or baseImages <2 => treat as base
    if (!s.modelName || s.baseImages.length < 2) {
      s.baseImages.push(fileUrl);
      sessions.set(chatId, s);
      return ctx.reply(`✅ Base image added (total base images: ${s.baseImages.length}).`);
    }
    // otherwise treat as reference image
    s.refImages.push(fileUrl);
    sessions.set(chatId, s);
    return ctx.reply(`✅ Reference image added (total refs: ${s.refImages.length}). Send /generate when ready.`);
  } catch (e) {
    console.error("photo handler err", e);
  }
});

// ---------- Express webhook integration for Render ----------
app.use(bot.webhookCallback("/telegram-webhook"));
app.get("/", (req, res) => res.send("Private Wavespeed bot is alive"));
app.listen(PORT, async () => {
  const webhookUrl = `${BASE_URL}/telegram-webhook`;
  // set webhook on bot
  try {
    await bot.telegram.setWebhook(webhookUrl);
    console.log("Webhook set to", webhookUrl);
  } catch (e) {
    console.warn("Failed to set webhook automatically:", e.message);
  }
  console.log(`Server listening on port ${PORT}`);
});
