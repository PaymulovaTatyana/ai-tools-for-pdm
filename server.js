"use strict";

const { createServer } = require("node:http");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const slots = ["09:00", "11:00", "13:00", "15:00", "17:00"];
const moscowDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" });
const page = readFileSync(join(__dirname, "index.html"));
const db = new DatabaseSync(join(__dirname, "boris.sqlite"), { timeout: 5000 });

db.exec(`
  CREATE TABLE IF NOT EXISTS walk_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walk_date TEXT NOT NULL,
    slot_time TEXT NOT NULL,
    booked_by TEXT,
    booked_at TEXT,
    UNIQUE (walk_date, slot_time),
    CHECK (
      (booked_by IS NULL AND booked_at IS NULL)
      OR
      (booked_by IS NOT NULL AND booked_at IS NOT NULL)
    )
  );
  CREATE TABLE IF NOT EXISTS feedings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_name TEXT NOT NULL,
    fed_at TEXT NOT NULL
  );
`);

const seed = db.prepare(`
  INSERT INTO walk_slots (walk_date, slot_time)
  VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)
  ON CONFLICT (walk_date, slot_time) DO NOTHING
`);
const list = db.prepare(`
  SELECT slot_time AS time, booked_by AS name
  FROM walk_slots WHERE walk_date = ? ORDER BY slot_time
`);
const book = db.prepare(`
  UPDATE walk_slots SET booked_by = ?, booked_at = ?
  WHERE walk_date = ? AND slot_time = ? AND booked_by IS NULL
`);
const addFeeding = db.prepare("INSERT INTO feedings (employee_name, fed_at) VALUES (?, ?)");
const latestFeeding = db.prepare(`
  SELECT employee_name AS name, fed_at AS time FROM feedings ORDER BY id DESC LIMIT 1
`);

function initializeSlots(date) {
  seed.run(...slots.flatMap((time) => [date, time]));
}

function state(date) {
  initializeSlots(date);
  return { date, slots: list.all(date), feeding: latestFeeding.get() ?? null };
}

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function readBody(request, response, handle) {
  let length = 0;
  const chunks = [];
  request.on("error", () => response.destroy());
  request.on("data", (chunk) => {
    if (response.writableEnded) return;
    length += chunk.length;
    if (length > 4096) {
      json(response, 413, { message: "Слишком большой запрос." });
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (response.writableEnded) return;
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      json(response, 400, { message: "Запрос должен содержать корректный JSON." });
      return;
    }
    const name = typeof data?.name === "string" ? data.name.trim().replace(/\s+/gu, " ") : "";
    if (!name) {
      json(response, 400, { message: "Введите ФИО." });
      return;
    }
    try {
      handle(data, name);
    } catch (error) {
      console.error("Ошибка при записи в SQLite:", error.code ?? error.name);
      json(response, 500, { message: "Не удалось сохранить изменение. Попробуйте ещё раз." });
    }
  });
}

const server = createServer((request, response) => {
  const route = `${request.method} ${request.url.split("?")[0]}`;
  if (route === "GET /") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
  } else if (route === "GET /api/state") {
    try {
      json(response, 200, state(moscowDate.format()));
    } catch (error) {
      console.error("Ошибка чтения SQLite:", error.code ?? error.name);
      json(response, 500, { message: "Не удалось загрузить состояние." });
    }
  } else if (route === "POST /api/walk") {
    readBody(request, response, (data, name) => {
      const now = new Date();
      const date = moscowDate.format(now);
      if (data.date !== date) {
        json(response, 409, { message: "Дата изменилась. Выберите слот на сегодня.", state: state(date) });
        return;
      }
      if (!slots.includes(data.time)) {
        json(response, 400, { message: "Выберите один из пяти слотов." });
        return;
      }
      initializeSlots(date);
      const result = book.run(name, now.toISOString(), date, data.time);
      if (result.changes === 0) {
        json(response, 409, { message: `Слот ${data.time} уже занят. Выберите другое время.`, state: state(date) });
        return;
      }
      json(response, 200, { message: `Вы записаны на ${data.time}.`, state: state(date) });
    });
  } else if (route === "POST /api/feeding") {
    readBody(request, response, (_data, name) => {
      const now = new Date();
      addFeeding.run(name, now.toISOString());
      json(response, 200, { message: "Кормление отмечено.", state: state(moscowDate.format(now)) });
    });
  } else {
    json(response, 404, { message: "Страница не найдена." });
  }
});

const host = process.env.HOST || "127.0.0.1";
server.listen(Number(process.env.PORT ?? 3011), host, () => {
  console.log(`Кто выгуливает Бориса: http://${host}:${server.address().port}`);
});
