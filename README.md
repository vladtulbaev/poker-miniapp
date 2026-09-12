# Покер — Telegram Mini App

Техасский холдем против четырёх ботов. Статика без сборки: `index.html`, `style.css`, `app.js`, аватары в `assets/` (Microsoft Fluent Emoji 3D, MIT).

Локально: `python3 -m http.server 7781` в этой папке.

## Бот @cashpoker_bot
`bot/bot.py` — минимальный поллер без зависимостей: на `/start` шлёт кнопку с Mini App. Кнопка меню «Играть» задана через `setChatMenuButton`.
Крутится на VPS `vps-new` в `/opt/poker-tg` как `poker-bot.service` (токен в `/opt/poker-tg/.env`, в репо не хранится).
Обновить: `scp bot/bot.py vps-new:/tmp/ && ssh vps-new 'sudo mv /tmp/bot.py /opt/poker-tg/ && sudo systemctl restart poker-bot'`.
