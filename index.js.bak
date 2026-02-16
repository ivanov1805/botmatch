require("dotenv").config();
const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// ===== DATABASE =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== TEST COMMAND =====
bot.start((ctx) => ctx.reply("Бот работает 🚀"));

// ===== WEBHOOK CONFIG =====
const secret = "8e20866bcb3017a91fde937cbd6a55c1755d5d35604184cd16a154b903e77012";
const hookPath = `/telegraf/${secret}`;

app.use(bot.webhookCallback(hookPath));

app.get("/", (req, res) => {
  res.send("OK");
});

const port = process.env.PORT || 3000;

app.listen(port, async () => {
  console.log("SERVER STARTED ON PORT", port);

  await bot.telegram.setWebhook(
    `${process.env.WEBHOOK_URL}${hookPath}`
  );

  console.log("WEBHOOK SET");
});
