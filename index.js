require("dotenv").config();

const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// ================= DATABASE =================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ================= SESSION =================

const sessions = {};

// ================= START =================

bot.start((ctx) => {
  ctx.reply(
`🏸 Badm Match Maker

У тебя есть пара, но нет соперников?
Собираем компактные парные игры от 2 до 3 пар.

Выберите действие:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("Создать игру", "create_game")],
      [Markup.button.callback("Список игр", "list_games")]
    ])
  );
});

// ================= CREATE GAME =================

bot.action("create_game", async (ctx) => {
  await ctx.answerCbQuery();
  sessions[ctx.from.id] = {};
  ctx.reply("Введите локацию:");
});

// ================= TEXT HANDLER =================

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const session = sessions[userId];

  if (!session) return;

  // ===== CREATE FLOW =====

  if (!session.location) {
    session.location = ctx.message.text;
    return ctx.reply("Введите дату (например 25.02.2026):");
  }

  if (!session.date) {
    session.date = ctx.message.text;
    return ctx.reply("Введите время (например 19:00):");
  }

  if (!session.time) {
    session.time = ctx.message.text;
    return ctx.reply("Введите имя и фамилию второго организатора:");
  }

  if (!session.organizer2 && !session.joinGameId) {
    session.organizer2 = ctx.message.text;

    const organizer1 = `${ctx.from.first_name} ${ctx.from.last_name || ""}`;

    const result = await pool.query(
      `INSERT INTO games 
      (location, date, time, organizer1, organizer2, pairs, is_closed) 
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id`,
      [
        session.location,
        session.date,
        session.time,
        organizer1,
        session.organizer2,
        [`${organizer1} / ${session.organizer2}`],
        false
      ]
    );

    const gameId = result.rows[0].id;

    delete sessions[userId];

    await publishGame(gameId);

    return ctx.reply("Игра создана ✅");
  }

  // ===== JOIN FLOW =====

  if (session.joinGameId) {
    const secondPlayer = ctx.message.text;
    const firstPlayer = `${ctx.from.first_name} ${ctx.from.last_name || ""}`;
    const pair = `${firstPlayer} / ${secondPlayer}`;
    const gameId = session.joinGameId;

    await pool.query(
      "UPDATE games SET pairs = array_append(pairs,$1) WHERE id=$2",
      [pair, gameId]
    );

    const { rows } = await pool.query(
      "SELECT pairs FROM games WHERE id=$1",
      [gameId]
    );

    if (rows[0].pairs.length >= 3) {
      await pool.query(
        "UPDATE games SET is_closed=true WHERE id=$1",
        [gameId]
      );
    }

    delete sessions[userId];

    await publishGame(gameId);

    return ctx.reply("Вы записаны ✅");
  }
});

// ================= JOIN BUTTON =================

bot.action(/join_(.+)/, async (ctx) => {
  const gameId = ctx.match[1];
  await ctx.answerCbQuery();

  const { rows } = await pool.query(
    "SELECT * FROM games WHERE id=$1",
    [gameId]
  );

  if (!rows.length) return;

  const game = rows[0];

  if (game.is_closed) {
    return ctx.reply("⛔ Запись закрыта.");
  }

  if (game.pairs.length >= 3) {
    return ctx.reply("Игра уже заполнена.");
  }

  sessions[ctx.from.id] = { joinGameId: gameId };
  ctx.reply("Введите имя и фамилию второго игрока:");
});

// ================= LIST GAMES =================

bot.action("list_games", async (ctx) => {
  await ctx.answerCbQuery();

  const { rows } = await pool.query(
    "SELECT * FROM games WHERE is_closed=false"
  );

  if (!rows.length) {
    return ctx.reply("Активных игр нет.");
  }

  rows.forEach((game) => {
    ctx.reply(
      formatGameText(game),
      Markup.inlineKeyboard([
        [Markup.button.callback("Записаться парой", `join_${game.id}`)]
      ])
    );
  });
});

// ================= FORMAT =================

function formatGameText(game) {
  const list = [...game.pairs];
  while (list.length < 3) list.push("—");

  return `🏸 ${game.location}
📅 ${game.date}
🕒 ${game.time}

👤 Организаторы:
${game.organizer1} / ${game.organizer2}

🎯 Формат допуска:
• Мастер + Любитель
• Два продвинутых любителя

👥 Пары:
1️⃣ ${list[0]}
2️⃣ ${list[1]}
3️⃣ ${list[2]}`;
}

// ================= PUBLISH =================

async function publishGame(gameId) {
  const { rows } = await pool.query(
    "SELECT * FROM games WHERE id=$1",
    [gameId]
  );

  const game = rows[0];

  await bot.telegram.sendMessage(
    process.env.CHANNEL_ID,
    formatGameText(game),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Записаться парой", callback_data: `join_${game.id}` }]
        ]
      }
    }
  );
}

// ================= WEB SERVER =================

const secret = "8e20866bcb3017a91fde937cbd6a55c1755d5d35604184cd16a154b903e77012";
const hookPath = `/telegraf/${secret}`;

app.use(bot.webhookCallback(hookPath));

app.get("/", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;

app.listen(port, async () => {
  console.log("SERVER STARTED ON PORT", port);
  await bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}${hookPath}`);
  console.log("WEBHOOK SET");
});
