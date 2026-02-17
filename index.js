require("dotenv").config();

const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const sessions = {};

// ================= START =================

bot.start((ctx) => {
  ctx.reply(
    "🏸 Badm Match Maker\n\nУ тебя есть пара, но нет соперников?\nСобираем компактные парные игры от 2 до 3 пар.\n\nВыберите действие:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Создать игру", "create_game")],
      [Markup.button.callback("Список игр", "list_games")]
    ])
  );
});

// ================= CREATE GAME =================

bot.action("create_game", async (ctx) => {
  await ctx.answerCbQuery();
  sessions[ctx.from.id] = { step: "location" };
  ctx.reply("Введите локацию:");
});

// ================= LIST GAMES =================

bot.action("list_games", async (ctx) => {
  await ctx.answerCbQuery();

  const { rows } = await pool.query(
    "SELECT * FROM games WHERE is_closed=false ORDER BY id DESC"
  );

  if (!rows.length) return ctx.reply("Активных игр нет.");

  for (const game of rows) {
    await ctx.reply(
      formatGame(game),
      Markup.inlineKeyboard([
        [Markup.button.callback("Записаться парой", `join_${game.id}`)],
        [Markup.button.url("Связаться с организатором", `https://t.me/${game.organizer_username || ""}`)]
      ])
    );
  }
});

// ================= JOIN GAME =================

bot.action(/join_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const gameId = ctx.match[1];

  const { rows } = await pool.query("SELECT * FROM games WHERE id=$1", [gameId]);
  if (!rows.length) return;

  const game = rows[0];

  if (game.is_closed) return ctx.reply("⛔ Запись закрыта.");
  if (game.pairs.length >= 3) return ctx.reply("Игра заполнена.");

  sessions[ctx.from.id] = {
    step: "join_second",
    gameId
  };

  ctx.reply("Введите имя и фамилию второго игрока:");
});

// ================= TEXT HANDLER =================

bot.on("text", async (ctx) => {
  const session = sessions[ctx.from.id];
  if (!session) return;

  const text = ctx.message.text;

  // ===== CREATE FLOW =====

  if (session.step === "location") {
    session.location = text;
    session.step = "date";
    return ctx.reply("Введите дату (например 25.02.2026):");
  }

  if (session.step === "date") {
    session.date = text;
    session.step = "time";
    return ctx.reply("Введите время (например 19:00):");
  }

  if (session.step === "time") {
    session.time = text;
    session.step = "organizer2";
    return ctx.reply("Введите имя и фамилию второго организатора:");
  }

  if (session.step === "organizer2") {
    session.organizer2 = text;

    const organizer1 = `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();

    const result = await pool.query(
      `INSERT INTO games
      (location, date, time, organizer1, organizer2, organizer_username, pairs, is_closed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id`,
      [
        session.location,
        session.date,
        session.time,
        organizer1,
        session.organizer2,
        ctx.from.username,
        [`${organizer1} / ${session.organizer2}`],
        false
      ]
    );

    delete sessions[ctx.from.id];

    await publishGame(result.rows[0].id);

    return ctx.reply("Игра создана ✅");
  }

  // ===== JOIN FLOW =====

  if (session.step === "join_second") {
    const secondPlayer = text;
    const firstPlayer = `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();
    const pair = `${firstPlayer} / ${secondPlayer}`;

    await pool.query(
      "UPDATE games SET pairs = array_append(pairs,$1) WHERE id=$2",
      [pair, session.gameId]
    );

    const { rows } = await pool.query(
      "SELECT pairs FROM games WHERE id=$1",
      [session.gameId]
    );

    if (rows[0].pairs.length >= 3) {
      await pool.query("UPDATE games SET is_closed=true WHERE id=$1", [
        session.gameId
      ]);
    }

    delete sessions[ctx.from.id];

    await publishGame(session.gameId);

    return ctx.reply("Вы записаны ✅");
  }
});

// ================= FORMAT =================

function formatGame(game) {
  const list = [...game.pairs];
  while (list.length < 3) list.push("—");

  return `🎾 ${game.location}
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
3️⃣ ${list[2]}

Минимум 2 пары, максимум 3.`;
}

// ================= PUBLISH =================

async function publishGame(id) {
  const { rows } = await pool.query("SELECT * FROM games WHERE id=$1", [id]);
  const game = rows[0];

  await bot.telegram.sendMessage(
    process.env.CHANNEL_ID,
    formatGame(game),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Записаться парой", callback_data: `join_${game.id}` }]
        ]
      }
    }
  );
}

// ================= WEBHOOK =================

app.use(bot.webhookCallback(`/telegraf/${process.env.BOT_TOKEN}`));

app.get("/", (req, res) => {
  res.send("Bot is running");
});

app.listen(process.env.PORT || 8080, async () => {
  await bot.telegram.setWebhook(
    `${process.env.WEBHOOK_URL}/telegraf/${process.env.BOT_TOKEN}`
  );
  console.log("SERVER STARTED");
});
