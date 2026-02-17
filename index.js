require("dotenv").config();

const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ================= STATE =================

const state = {};

// ================= START =================

bot.start(async (ctx) => {
  await ctx.reply(
    "🏸 Badm Match Maker\n\nВыберите действие:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Создать игру", "CREATE")],
      [Markup.button.callback("Активные игры", "LIST")]
    ])
  );
});

// ================= CREATE FLOW =================

bot.action("CREATE", async (ctx) => {
  await ctx.answerCbQuery();
  state[ctx.from.id] = { step: "location" };
  await ctx.reply("Введите локацию:");
});

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const session = state[userId];
  if (!session) return;

  if (session.step === "location") {
    session.location = ctx.message.text;
    session.step = "date";
    return ctx.reply("Введите дату (25.02.2026):");
  }

  if (session.step === "date") {
    session.date = ctx.message.text;
    session.step = "time";
    return ctx.reply("Введите время (19:00):");
  }

  if (session.step === "time") {
    session.time = ctx.message.text;
    session.step = "organizer2";
    return ctx.reply("Введите имя и фамилию второго организатора:");
  }

  if (session.step === "organizer2") {
    session.organizer2 = ctx.message.text;

    const organizer1 = `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();

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
    delete state[userId];

    await publishGame(gameId);
    return ctx.reply("Игра создана ✅");
  }

  if (session.step === "join_second") {
    const second = ctx.message.text;
    const first = `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();
    const pair = `${first} / ${second}`;

    await pool.query(
      "UPDATE games SET pairs = array_append(pairs,$1) WHERE id=$2",
      [pair, session.gameId]
    );

    const { rows } = await pool.query(
      "SELECT pairs FROM games WHERE id=$1",
      [session.gameId]
    );

    if (rows[0].pairs.length >= 3) {
      await pool.query(
        "UPDATE games SET is_closed=true WHERE id=$1",
        [session.gameId]
      );
    }

    delete state[userId];
    await publishGame(session.gameId);
    return ctx.reply("Вы записаны ✅");
  }
});

// ================= LIST =================

bot.action("LIST", async (ctx) => {
  await ctx.answerCbQuery();

  const { rows } = await pool.query(
    "SELECT * FROM games WHERE is_closed=false"
  );

  if (!rows.length) return ctx.reply("Активных игр нет.");

  for (const game of rows) {
    await ctx.reply(
      formatGame(game),
      Markup.inlineKeyboard([
        [Markup.button.callback("Записаться парой", `JOIN_${game.id}`)]
      ])
    );
  }
});

// ================= JOIN =================

bot.action(/JOIN_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const gameId = ctx.match[1];

  const { rows } = await pool.query(
    "SELECT * FROM games WHERE id=$1",
    [gameId]
  );

  if (!rows.length) return;
  const game = rows[0];

  if (game.is_closed) {
    return ctx.reply("Запись закрыта.");
  }

  if (game.pairs.length >= 3) {
    return ctx.reply("Игра уже заполнена.");
  }

  state[ctx.from.id] = {
    step: "join_second",
    gameId
  };

  return ctx.reply("Введите имя и фамилию второго игрока:");
});

// ================= FORMAT =================

function formatGame(game) {
  const list = [...game.pairs];
  while (list.length < 3) list.push("—");

  return `📍 ${game.location}
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

async function publishGame(id) {
  const { rows } = await pool.query(
    "SELECT * FROM games WHERE id=$1",
    [id]
  );

  const game = rows[0];

  await bot.telegram.sendMessage(
    process.env.CHANNEL_ID,
    formatGame(game),
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("Записаться парой", `JOIN_${id}`)]
      ]).reply_markup
    }
  );
}

// ================= WEBHOOK =================

const secret = "8e20866bcb3017a91fde937cbd6a55c1755d5d35604184cd16a154b903e77012";
const hookPath = `/telegraf/${secret}`;

app.use(bot.webhookCallback(hookPath));

app.get("/", (req, res) => res.send("OK"));

const port = process.env.PORT || 8080;

app.listen(port, async () => {
  console.log("SERVER STARTED ON PORT", port);
  await bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}${hookPath}`);
  console.log("WEBHOOK SET");
});
