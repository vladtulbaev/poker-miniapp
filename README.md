# Покер — Telegram Mini App

Техасский холдем с друзьями (стол по ссылке, 2–5 человек) или против ботов. Дизайн — по макету пользователя.

- `index.html`, `style.css`, `app.js` — тонкий клиент (GitHub Pages). Всё состояние приходит с сервера по WebSocket.
- `server/server.py` — игровой сервер (python 3.12 + websockets): комнаты, движок холдема, боты, таймер хода 30 с, проверка Telegram initData.
- Бот @cashpoker_bot живёт внутри `server/server.py` (long polling): в личке `/start` и `/start КОД` шлют кнопку с Mini App; в группе бот при добавлении или по `/poker` постит стол чата с кнопкой «Сесть за стол» и обновляет в сообщении список игроков. Ссылка из группы: `t.me/cashpoker_bot?start=g<chat_id>` или, если в `.env` задан `APP_SHORT_NAME` (короткое имя Mini App из BotFather `/newapp`), прямая `t.me/cashpoker_bot/<name>?startapp=g<chat_id>` в один тап.
- `assets/` — аватары Microsoft Fluent Emoji 3D (MIT): `m1–m8` мужские, `f1–f8` женские. Пол угадывается по имени, аватар можно сменить в приложении.

## Прод
- Клиент: https://vladtulbaev.github.io/poker-miniapp/ (push в main).
- Сервер: `wss://217-144-186-195.sslip.io` → Caddy (docker `poker-caddy`, TLS от Let's Encrypt через TLS-ALPN) → `poker-ws.service` (127.0.0.1:8765), VPS `vps-new`, каталог `/opt/poker-tg`.
- Обновить сервер: `scp server/server.py vps-new:/tmp/ && ssh vps-new 'sudo mv /tmp/server.py /opt/poker-tg/ && sudo systemctl restart poker-ws'`.
- `.env` на сервере: `BOT_TOKEN`, `APP_URL`, `PORT=8765`, `ALLOW_DEV=1` (вход без Telegram под id `dev:*`, нужно для проверки в браузере), опционально `APP_SHORT_NAME`. Старый отдельный `poker-bot.service` выключен — два поллера getUpdates конфликтуют.

## Локально
`python3 -m http.server 7781` в этой папке и `ALLOW_DEV=1 python server/server.py` (нужен `pip install websockets`). Открыть `http://localhost:7781/?dev=a1&name=Влад`, второй игрок — другая вкладка с другим `dev`.
