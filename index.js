require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");

const bot = new Telegraf(process.env.BOT_TOKEN);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ======= DB INIT =======
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      location TEXT,
      date TEXT,
      time TEXT,
      format TEXT,
      total_cost INTEGER,
      pairs JSONB DEFAULT '[]',
      organizer_id BIGINT,
      organizer_username TEXT,
      message_id BIGINT
    )
  `);
}
initDB();

// ======= UI =======

function formatKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Продвинутые любители", "FMT_ADV")],
    [Markup.button.callback("Мастер+Любитель", "FMT_ML")]
  ]);
}

function levelKeyboard(gameId) {
  return Markup.inlineKeyboard([
    [{ text: "Продвинутые любители", callback_data: `LVL_A_${gameId}` }],
    [{ text: "Мастер+Любитель", callback_data: `LVL_ML_${gameId}` }]
  ]);
}

function renderGame(game) {
  const pairs = game.pairs || [];
  const pairCount = pairs.length;
  const price = Math.ceil(game.total_cost / 3);

  let text = `
🏸 ОТКРЫТАЯ ИГРА

📍 ${game.location}
🗓 ${game.date}
⏰ ${game.time}

🎯 Формат: ${game.format}
👥 Пары: ${pairCount}/3

`;

  pairs.forEach((p, i) => {
    text += `${i + 1}. ${p.player1} + ${p.player2} (${p.level})\n`;
  });

  text += `
💰 Корт: ${game.total_cost} ₽
💳 С пары: ${price} ₽
`;

  if (pairCount >= 2) text += `\n✅ ИГРА СОБРАНА`;
  if (pairCount === 3) text += `\n🔒 ПОЛНАЯ`;

  return text;
}

// ======= STATE =======

let createState = {};
let joinState = {};

// ======= CREATE GAME =======

bot.command("newgame", (ctx) => {
  createState[ctx.from.id] = {
    step: "location",
    organizerId: ctx.from.id,
    organizerUsername: ctx.from.username || null
  };
  ctx.reply("Введите локацию");
});

bot.on("text", async (ctx) => {
  const state = createState[ctx.from.id];
  const join = joinState[ctx.from.id];

  if (state) {
    if (state.step === "location") {
      state.location = ctx.message.text.trim();
      state.step = "date";
      return ctx.reply("Введите дату");
    }

    if (state.step === "date") {
      state.date = ctx.message.text.trim();
      state.step = "time";
      return ctx.reply("Введите время");
    }

    if (state.step === "time") {
      state.time = ctx.message.text.trim();
      state.step = "format";
      return ctx.reply("Выберите формат", formatKeyboard());
    }

    if (state.step === "cost") {
      const cost = parseInt(ctx.message.text.trim(), 10);
      if (!cost) return ctx.reply("Введите стоимость числом");

      const result = await pool.query(
        `INSERT INTO games 
        (location,date,time,format,total_cost,organizer_id,organizer_username)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *`,
        [
          state.location,
          state.date,
          state.time,
          state.format,
          cost,
          state.organizerId,
          state.organizerUsername
        ]
      );

      const game = result.rows[0];

      const msg = await bot.telegram.sendMessage(
        process.env.CHANNEL_ID,
        renderGame(game),
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Записать пару", callback_data: `JOIN_${game.id}` }]
            ]
          }
        }
      );

      await pool.query(
        `UPDATE games SET message_id=$1 WHERE id=$2`,
        [msg.message_id, game.id]
      );

      delete createState[ctx.from.id];
      return ctx.reply("Игра создана");
    }

    if (state.step === "format") {
      return ctx.reply("Выберите формат кнопкой", formatKeyboard());
    }
  }

  if (join) {
    if (!join.player1) {
      const t = ctx.message.text.trim();
      if (!t.includes(" "))
        return ctx.reply("Нужно Фамилия и Имя через пробел");
      join.player1 = t;
      return ctx.reply("Введите Фамилию и Имя второго игрока");
    }

    if (!join.player2) {
      const t = ctx.message.text.trim();
      if (!t.includes(" "))
        return ctx.reply("Нужно Фамилия и Имя через пробел");
      join.player2 = t;
      return ctx.reply("Выберите уровень пары", levelKeyboard(join.gameId));
    }
  }
});

// ======= FORMAT =======

bot.action(/^FMT_(ADV|ML)$/, async (ctx) => {
  const state = createState[ctx.from.id];
  if (!state) return ctx.answerCbQuery();

  state.format =
    ctx.match[1] === "ADV"
      ? "Продвинутые любители"
      : "Мастер+Любитель";

  state.step = "cost";
  await ctx.answerCbQuery();
  ctx.reply("Введите стоимость корта");
});

// ======= JOIN =======

bot.action(/^JOIN_(\d+)$/, async (ctx) => {
  const gameId = ctx.match[1];

  const result = await pool.query(
    `SELECT * FROM games WHERE id=$1`,
    [gameId]
  );

  if (!result.rows.length)
    return ctx.answerCbQuery("Игра не найдена");

  const game = result.rows[0];
  if ((game.pairs || []).length >= 3)
    return ctx.answerCbQuery("Игра уже полная");

  joinState[ctx.from.id] = { gameId };
  ctx.reply("Введите Фамилию и Имя первого игрока");
});

// ======= LEVEL =======

bot.action(/^LVL_(A|ML)_(\d+)$/, async (ctx) => {
  const levelCode = ctx.match[1];
  const gameId = ctx.match[2];
  const join = joinState[ctx.from.id];
  if (!join) return;

  const level =
    levelCode === "A"
      ? "Продвинутые любители"
      : "Мастер+Любитель";

  const result = await pool.query(
    `SELECT * FROM games WHERE id=$1`,
    [gameId]
  );

  const game = result.rows[0];
  const pairs = game.pairs || [];

  pairs.push({
    player1: join.player1,
    player2: join.player2,
    level,
    telegram: ctx.from.username || null
  });

  await pool.query(
    `UPDATE games SET pairs=$1 WHERE id=$2`,
    [JSON.stringify(pairs), gameId]
  );

  const updated = { ...game, pairs };

  await bot.telegram.editMessageText(
    process.env.CHANNEL_ID,
    game.message_id,
    null,
    renderGame(updated),
    {
      reply_markup: {
        inline_keyboard:
          pairs.length < 3
            ? [[{ text: "Записать пару", callback_data: `JOIN_${gameId}` }]]
            : []
      }
    }
  );

  // ===== CONTACTS =====

  const organizerContact = game.organizer_username
    ? `@${game.organizer_username}`
    : "Организатор без username";

  await ctx.reply(`Контакт организатора: ${organizerContact}`);

  await bot.telegram.sendMessage(
    game.organizer_id,
    `Новая пара записалась:
${join.player1} + ${join.player2}
Telegram: @${ctx.from.username || "без username"}`
  );

  delete joinState[ctx.from.id];
});

// ======= WEBHOOK =======

if (process.env.WEBHOOK_URL) {
  bot.launch({
    webhook: {
      domain: process.env.WEBHOOK_URL,
      port: process.env.PORT
    }
  });
} else {
  bot.launch();
}

console.log("BOT STARTED");
