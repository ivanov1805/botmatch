require("dotenv").config();

const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");

// ============ ENV CHECK ============
const isLocal = process.env.NODE_ENV !== "production";

if (!process.env.BOT_TOKEN) {
  console.error("Missing BOT_TOKEN. Set BOT_TOKEN in your environment (.env) before starting the bot.");
  process.exit(1);
}

if (!process.env.DATABASE_URL && !isLocal) {
  console.error("Missing DATABASE_URL in production.");
  process.exit(1);
}

if (!process.env.CHANNEL_ID) {
  console.error("Missing CHANNEL_ID. Set CHANNEL_ID in your environment (.env).");
  process.exit(1);
}

if (!isLocal && !process.env.PUBLIC_BASE_URL) {
  console.error("Missing PUBLIC_BASE_URL in production.");
  process.exit(1);
}

const app = express();
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool();

const CHANNEL_ID = process.env.CHANNEL_ID; // e.g. -1001234567890
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""); // https://xxxx.up.railway.app

// ============ STATE MACHINE ============
const State = Object.freeze({
  IDLE: "IDLE",

  CREATE_WAIT_LOCATION: "CREATE_WAIT_LOCATION",
  CREATE_WAIT_DATE: "CREATE_WAIT_DATE",
  CREATE_WAIT_TIME: "CREATE_WAIT_TIME",
  CREATE_WAIT_ORG2_NAME: "CREATE_WAIT_ORG2_NAME",

  JOIN_WAIT_SECOND_PLAYER: "JOIN_WAIT_SECOND_PLAYER",
});

const sessions = new Map(); // key: telegram userId -> { state, data }

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { state: State.IDLE, data: {} });
  }
  return sessions.get(userId);
}

function resetSession(userId) {
  sessions.set(userId, { state: State.IDLE, data: {} });
}

// ============ DB INIT ============
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      location TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,

      organizer1_name TEXT NOT NULL,
      organizer1_user_id BIGINT NOT NULL,
      organizer1_username TEXT,

      organizer2_name TEXT NOT NULL,

      pairs TEXT[] NOT NULL DEFAULT '{}',
      is_closed BOOLEAN NOT NULL DEFAULT false,
      waiting_list TEXT[] NOT NULL DEFAULT '{}',

      channel_message_id BIGINT
    );
  `);
  // ensure waiting_list exists on older schemas
  await pool.query("ALTER TABLE games ADD COLUMN IF NOT EXISTS waiting_list TEXT[] NOT NULL DEFAULT '{}' ");

  await pool.query(`
    CREATE OR REPLACE FUNCTION promote_waiting_pair_on_cancel()
    RETURNS TRIGGER AS $$
    DECLARE
      new_pairs_len INT := COALESCE(array_length(NEW.pairs, 1), 0);
      old_pairs_len INT := COALESCE(array_length(OLD.pairs, 1), 0);
      waiting_len INT := COALESCE(array_length(NEW.waiting_list, 1), 0);
    BEGIN
      IF new_pairs_len < old_pairs_len AND new_pairs_len < 3 AND waiting_len > 0 THEN
        NEW.pairs := array_append(COALESCE(NEW.pairs, '{}'::TEXT[]), NEW.waiting_list[1]);
        NEW.waiting_list := CASE
          WHEN waiting_len > 1 THEN NEW.waiting_list[2:waiting_len]
          ELSE '{}'::TEXT[]
        END;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS trg_promote_waiting_pair_on_cancel ON games;
    CREATE TRIGGER trg_promote_waiting_pair_on_cancel
    BEFORE UPDATE ON games
    FOR EACH ROW
    EXECUTE FUNCTION promote_waiting_pair_on_cancel();
  `);
}

// ============ HELPERS ============
function safeFullName(ctx) {
  const fn = (ctx.from.first_name || "").trim();
  const ln = (ctx.from.last_name || "").trim();
  return `${fn}${ln ? " " + ln : ""}`.trim();
}

function escapeText(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function organizerContactUrl(userId, username) {
  const u = (username || "").replace(/^@/, "").trim();
  if (u) return `https://t.me/${u}`;
  // Telegram deep link for opening chat with user by id (works in clients)
  return `tg://user?id=${userId}`;
}

function formatGameText(game) {
  const pairs = Array.isArray(game.pairs) ? [...game.pairs] : [];
  while (pairs.length < 3) pairs.push("—");
  const waiting = Array.isArray(game.waiting_list) ? [...game.waiting_list] : [];
  const waitingText = waiting.length ? waiting.map((w, i) => `${i + 1}. ${w}`).join("\n") : "-";

  return `🏸 ${game.location}
📅 ${game.date}
🕒 ${game.time}

👤 Организаторы:
${game.organizer1_name} / ${game.organizer2_name}

🎯 Формат допуска:
• Мастер + Любитель
• Два продвинутых любителя

Подтвержденные пары:
1️⃣ ${pairs[0]}
2️⃣ ${pairs[1]}
3️⃣ ${pairs[2]}

Лист ожидания:
${waitingText}

ℹ️ Выписаться можно только написав организатору.`;
}

function gameKeyboard(game) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Записаться парой", `join:${game.id}`)],
    [
      Markup.button.url(
        "✉️ Написать организатору",
        organizerContactUrl(game.organizer1_user_id, game.organizer1_username)
      ),
    ],
  ]);
}

async function loadGame(gameId) {
  const { rows } = await pool.query("SELECT * FROM games WHERE id=$1", [gameId]);
  return rows[0] || null;
}

async function publishGame(gameId) {
  const game = await loadGame(gameId);
  if (!game) return;

  const text = formatGameText(game);
  const keyboard = gameKeyboard(game);

  // If already posted to channel - edit, else send and save message_id
  if (game.channel_message_id) {
    try {
      await bot.telegram.editMessageText(
        CHANNEL_ID,
        Number(game.channel_message_id),
        undefined,
        text,
        keyboard
      );
      return;
    } catch (e) {
      // Message could be deleted or edit not allowed - fallback to send new
      console.error("editMessageText failed, fallback to send:", e?.message || e);
    }
  }

  const sent = await bot.telegram.sendMessage(CHANNEL_ID, text, keyboard);
  await pool.query("UPDATE games SET channel_message_id=$1 WHERE id=$2", [
    sent.message_id,
    gameId,
  ]);
}

// ============ BOT UI ============
async function sendMainMenu(ctx) {
  return ctx.reply(
    "🏸 Badm Match Maker\n\nВыбери действие:",
    Markup.inlineKeyboard([
      [Markup.button.callback("➕ Создать игру", "create")],
      [Markup.button.callback("📋 Список игр", "list")],
    ])
  );
}

bot.start(async (ctx) => {
  resetSession(ctx.from.id);
  await sendMainMenu(ctx);
});

bot.action("create", async (ctx) => {
  await ctx.answerCbQuery();
  const s = getSession(ctx.from.id);
  s.state = State.CREATE_WAIT_LOCATION;
  s.data = {};
  await ctx.reply("Введите локацию (например: Лужники):");
});

bot.action("list", async (ctx) => {
  await ctx.answerCbQuery();

  const { rows } = await pool.query("SELECT * FROM games WHERE is_closed=false ORDER BY id DESC LIMIT 20");
  if (!rows.length) return ctx.reply("Активных игр нет.");

  for (const g of rows) {
    await ctx.reply(formatGameText(g), gameKeyboard(g));
  }
});

bot.action(/^join:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const gameId = Number(ctx.match[1]);

  const game = await loadGame(gameId);
  if (!game) return ctx.reply("Игра не найдена.");

  if (game.is_closed) return ctx.reply("⛔ Запись закрыта.");
  // allow joining even if main slots are full; extras will go to waiting list

  const s = getSession(ctx.from.id);
  s.state = State.JOIN_WAIT_SECOND_PLAYER;
  s.data = { joinGameId: gameId };

  await ctx.reply("Введите имя и фамилию второго игрока вашей пары:");
});

// ============ SINGLE TEXT HANDLER (NO DUPLICATES) ============
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = escapeText(ctx.message.text);
  const s = getSession(userId);

  // allow reset command
  if (text === "/cancel" || text === "отмена") {
    resetSession(userId);
    return ctx.reply("Ок, отменил. /start чтобы начать заново.");
  }

  switch (s.state) {
    case State.CREATE_WAIT_LOCATION: {
      if (!text) return ctx.reply("Локация не должна быть пустой. Введите ещё раз:");
      s.data.location = text;
      s.state = State.CREATE_WAIT_DATE;
      return ctx.reply("Введите дату (например 25.02.2026):");
    }

    case State.CREATE_WAIT_DATE: {
      if (!text) return ctx.reply("Дата не должна быть пустой. Введите ещё раз:");
      s.data.date = text;
      s.state = State.CREATE_WAIT_TIME;
      return ctx.reply("Введите время (например 19:00):");
    }

    case State.CREATE_WAIT_TIME: {
      if (!text) return ctx.reply("Время не должно быть пустым. Введите ещё раз:");
      s.data.time = text;
      s.state = State.CREATE_WAIT_ORG2_NAME;
      return ctx.reply("Введите имя и фамилию второго организатора (ваш партнёр):");
    }

    case State.CREATE_WAIT_ORG2_NAME: {
      if (!text) return ctx.reply("Имя/фамилия не должны быть пустыми. Введите ещё раз:");
      s.data.organizer2 = text;

      const organizer1Name = safeFullName(ctx) || "Организатор";
      const organizer2Name = s.data.organizer2;

      // organizer pair is always pre-filled (по умолчанию)
      const pair = `${organizer1Name} / ${organizer2Name}`;

      const { rows } = await pool.query(
        `INSERT INTO games
          (location, date, time, organizer1_name, organizer1_user_id, organizer1_username, organizer2_name, pairs, is_closed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          s.data.location,
          s.data.date,
          s.data.time,
          organizer1Name,
          Number(ctx.from.id),
          ctx.from.username || null,
          organizer2Name,
          [pair],
          false,
        ]
      );

      const gameId = rows[0].id;

      resetSession(userId);

      await publishGame(gameId);
      await ctx.reply("Игра создана ✅\nПост опубликован в канале.");

      return sendMainMenu(ctx);
    }

    case State.JOIN_WAIT_SECOND_PLAYER: {
      const gameId = s.data.joinGameId;
      if (!gameId) {
        resetSession(userId);
        return ctx.reply("Сессия сломалась. /start");
      }
      if (!text) return ctx.reply("Имя/фамилия не должны быть пустыми. Введите ещё раз:");
      const secondPlayerUsername = String(text).replace(/^@/, "").trim();
      const { rows: existingUserRows } = await pool.query(
        "SELECT 1 FROM games WHERE organizer1_username = $1 LIMIT 1",
        [secondPlayerUsername]
      );
      if (!existingUserRows.length) {
        resetSession(userId);
        return ctx.reply("Ошибка: указанный username не найден в базе.");
      }

      const game = await loadGame(gameId);
      if (!game) {
        resetSession(userId);
        return ctx.reply("Игра не найдена. /start");
      }
      if (game.is_closed) {
        resetSession(userId);
        return ctx.reply("⛔ Запись закрыта.");
      }
      const pairs = Array.isArray(game.pairs) ? [...game.pairs] : [];
      const waiting = Array.isArray(game.waiting_list) ? [...game.waiting_list] : [];

      const firstPlayer = safeFullName(ctx) || "Игрок";
      const secondPlayer = text;
      const pair = `${firstPlayer} / ${secondPlayer}`;
      const norm = (v) => String(v || "").trim().toLowerCase();

      const takenPlayers = new Set(
        [...pairs, ...waiting]
          .flatMap((p) => String(p || "").split(" / "))
          .map((p) => norm(p))
          .filter(Boolean)
      );

      if (takenPlayers.has(norm(firstPlayer)) || takenPlayers.has(norm(secondPlayer))) {
        resetSession(userId);
        return ctx.reply("Ошибка: один из игроков уже записан на эту игру.");
      }

      // prevent duplicate in main list or waiting list
      if (pairs.includes(pair) || waiting.includes(pair)) {
        resetSession(userId);
        return ctx.reply("Эта пара уже записана.");
      }

      const status = pairs.length < 3 ? "confirmed" : "waiting";
      let addedToMain = false;
      if (status === "confirmed") {
        await pool.query(
          `UPDATE games SET pairs = array_append(pairs, $1) WHERE id = $2`,
          [pair, gameId]
        );
        addedToMain = true;
      } else {
        await pool.query(
          `UPDATE games SET waiting_list = array_append(waiting_list, $1) WHERE id = $2`,
          [pair, gameId]
        );
      }

      resetSession(userId);

      await publishGame(gameId);
      if (addedToMain) {
        await ctx.reply("Записал ✅\nЕсли нужно выписаться — напиши организатору.");
      } else {
        await ctx.reply("Поставил в очередь ✅\nВы в списке ожидания. Организатор свяжется при появлении слота.");
      }

      return sendMainMenu(ctx);
    }

    case State.IDLE:
    default:
      return ctx.reply("Я тебя понял, но сейчас нет активного действия.\nНажми /start");
  }
});

// ============ WEBHOOK + EXPRESS ============
app.get("/", (_req, res) => res.status(200).send("OK"));

app.use(bot.webhookCallback("/telegraf"));

async function main() {
  await ensureSchema();

  const port = process.env.PORT || 8080;
  app.listen(port, async () => {
    console.log(`SERVER STARTED ON PORT ${port}`);

    if (process.env.PUBLIC_BASE_URL) {
      const webhookUrl = `${PUBLIC_BASE_URL}/telegraf`;
      await bot.telegram.setWebhook(webhookUrl);
      console.log("WEBHOOK SET", webhookUrl);
    } else {
      await bot.launch();
      console.log("BOT LAUNCHED (polling mode)");
    }
  });
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
