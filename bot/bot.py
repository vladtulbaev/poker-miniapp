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

def reply(chat_id):
    call("sendMessage", chat_id=chat_id,
         text="Покер — техасский холдем против четырёх ботов.\nБлайнды 5/10, стек 250. Жми «Играть».",
         reply_markup={"inline_keyboard": [[{"text": "Играть 🃏", "web_app": {"url": APP_URL}}]]})

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
                    reply(msg["chat"]["id"])
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            print("net error:", e, flush=True)
            time.sleep(3)
        except Exception as e:
            print("error:", e, flush=True)
            time.sleep(3)

if __name__ == "__main__":
    main()
