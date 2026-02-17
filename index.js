require("dotenv").config();
const express = require("express");
const { Telegraf, Markup } = require("telegraf");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

const CHANNEL_ID = process.env.CHANNEL_ID;

let currentGame = null;
let step = null;
let tempGame = {};

// ================= START =================

bot.start((ctx) => {
  ctx.reply("Бот работает. Для создания игры введи /newgame");
});

// ================= CREATE GAME =================

bot.command("newgame", async (ctx) => {
  tempGame = {};
  step = "location";
  ctx.reply("Введите локацию (например: Лужники)");
});

bot.on("text", async (ctx) => {
  if (!step) return;

  if (step === "location") {
    tempGame.location = ctx.message.text;
    step = "date";
    return ctx.reply("Введите дату (например: 25.02.2026)");
  }

  if (step === "date") {
    tempGame.date = ctx.message.text;
    step = "time";
    return ctx.reply("Введите время (например: 19:00)");
  }

  if (step === "time") {
    tempGame.time = ctx.message.text;
    step = "org1";
    return ctx.reply("Введите Фамилию и Имя первого организатора");
  }

  if (step === "org1") {
    tempGame.org1 = ctx.message.text;
    step = "org2";
    return ctx.reply("Введите Фамилию и Имя второго организатора");
  }

  if (step === "org2") {
    tempGame.org2 = ctx.message.text;

    currentGame = {
      ...tempGame,
      pairs: [
        `${tempGame.org1} / ${tempGame.org2}`
      ],
      messageId: null
    };

    const messageText = buildMessage(currentGame);

    const sent = await bot.telegram.sendMessage(
      CHANNEL_ID,
      messageText,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback("Записаться парой", "JOIN_GAME")
        ])
      }
    );

    currentGame.messageId = sent.message_id;

    step = null;
    tempGame = {};

    return ctx.reply("Игра опубликована в канале ✅");
  }
});

// ================= JOIN =================

bot.action("JOIN_GAME", async (ctx) => {
  if (!currentGame) {
    return ctx.answerCbQuery("Игра не найдена");
  }

  if (currentGame.pairs.length >= 3) {
    return ctx.answerCbQuery("Мест больше нет");
  }

  step = "join1";
  ctx.answerCbQuery();
  ctx.reply("Введите Фамилию и Имя первого игрока вашей пары");
});

bot.on("text", async (ctx) => {
  if (step === "join1") {
    tempGame.join1 = ctx.message.text;
    step = "join2";
    return ctx.reply("Введите Фамилию и Имя второго игрока");
  }

  if (step === "join2") {
    const pair = `${tempGame.join1} / ${ctx.message.text}`;

    if (currentGame.pairs.length >= 3) {
      step = null;
      return ctx.reply("Мест больше нет");
    }

    currentGame.pairs.push(pair);

    await updateChannelMessage();

    step = null;
    tempGame = {};

    return ctx.reply("Вы записаны ✅");
  }
});

// ================= UPDATE MESSAGE =================

async function updateChannelMessage() {
  const text = buildMessage(currentGame);

  const keyboard =
    currentGame.pairs.length < 3
      ? Markup.inlineKeyboard([
          Markup.button.callback("Записаться парой", "JOIN_GAME")
        ])
      : undefined;

  await bot.telegram.editMessageText(
    CHANNEL_ID,
    currentGame.messageId,
    null,
    text,
    {
      parse_mode: "HTML",
      reply_markup: keyboard
    }
  );
}

// ================= TEMPLATE =================

function buildMessage(game) {
  return `
🏸 <b>${game.location}</b>
📅 ${game.date}
🕒 ${game.time}

👤 <b>Организаторы:</b>
${game.org1} / ${game.org2}

🎯 <b>Формат допуска:</b>
• Мастер + Любитель
• Два продвинутых любителя

👥 <b>Пары:</b>
1️⃣ ${game.pairs[0] || "—"}
2️⃣ ${game.pairs[1] || "—"}
3️⃣ ${game.pairs[2] || "—"}

Минимум 2 пары, максимум 3.
`.trim();
}

// ================= WEBHOOK =================

const secret = "8e20866bcb3017a91fde937cbd6a55c1755d5d35604184cd16a154b903e77012";
const hookPath = `/telegraf/${secret}`;

app.use(bot.webhookCallback(hookPath));

app.get("/", (req, res) => {
  res.send("OK");
});

const port = process.env.PORT || 8080;

app.listen(port, async () => {
  console.log("SERVER STARTED ON PORT", port);

  await bot.telegram.setWebhook(
    `${process.env.WEBHOOK_URL}${hookPath}`
  );

  console.log("WEBHOOK SET");
});
