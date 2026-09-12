#!/usr/bin/env python3
"""Минимальный бот для @cashpoker_bot: на /start шлёт кнопку с Mini App. Без зависимостей."""
import json, os, time, urllib.request, urllib.error

TOKEN = os.environ["BOT_TOKEN"]
APP_URL = os.environ.get("APP_URL", "https://vladtulbaev.github.io/poker-miniapp/")
API = f"https://api.telegram.org/bot{TOKEN}/"

def call(method, **params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(API + method, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def reply(chat_id, room=None):
    if room:
        url = f"{APP_URL}?room={room}"
        text = f"Тебя зовут за покерный стол {room}.\nЖми «Сесть за стол» — карты уже тасуются."
        btn = "Сесть за стол 🃏"
    else:
        url = APP_URL
        text = ("Покер — техасский холдем с друзьями или против ботов.\n"
                "Создай стол, кинь ссылку друзьям (от 2 человек) или играй с ботами.\nБлайнды 5/10, стек 250.")
        btn = "Играть 🃏"
    call("sendMessage", chat_id=chat_id, text=text,
         reply_markup={"inline_keyboard": [[{"text": btn, "web_app": {"url": url}}]]})

def main():
    offset = 0
    while True:
        try:
            res = call("getUpdates", offset=offset, timeout=50, allowed_updates=["message"])
            for upd in res.get("result", []):
                offset = upd["update_id"] + 1
                msg = upd.get("message") or {}
                text = msg.get("text", "")
                if msg.get("chat", {}).get("type") == "private" and text.startswith("/start"):
                    parts = text.split(maxsplit=1)
                    room = parts[1].strip().upper()[:8] if len(parts) > 1 and parts[1].strip().isalnum() else None
                    reply(msg["chat"]["id"], room)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            print("net error:", e, flush=True)
            time.sleep(3)
        except Exception as e:
            print("error:", e, flush=True)
            time.sleep(3)

if __name__ == "__main__":
    main()
