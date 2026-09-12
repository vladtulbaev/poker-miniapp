#!/usr/bin/env python3
"""Покер — WebSocket-сервер для Telegram Mini App.

Комнаты (столы) до 5 мест, люди + боты, Texas Hold'em, блайнды 5/10, стек 250.
Сервер — единственный источник правды: раздаёт карты, ведёт торги, считает банк.
Клиенту уходит персональное состояние (чужие карты только на шоудауне).
"""
import asyncio
import hashlib
import hmac
import itertools
import json
import logging
import os
import random
import re
import secrets
import time
import urllib.parse

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
ALLOW_DEV = os.environ.get("ALLOW_DEV", "0") == "1"
PORT = int(os.environ.get("PORT", "8765"))
USERS_FILE = os.environ.get("USERS_FILE", "users.json")
APP_URL = os.environ.get("APP_URL", "https://vladtulbaev.github.io/poker-miniapp/")
APP_SHORT_NAME = os.environ.get("APP_SHORT_NAME", "")  # короткое имя Mini App из BotFather (/newapp) — тогда ссылка из группы открывает игру в один тап
BOT_POLL = os.environ.get("BOT_POLL", "1") == "1"

SB, BB, START = 5, 10, 250
MAX_SEATS = 5
ACT_TIMEOUT = 30          # секунд на ход человеку
OFFLINE_TIMEOUT = 6       # секунд на ход, если человек офлайн
KICK_OFFLINE_AFTER = 120  # секунд офлайна, после которых убираем со стола между раздачами
ROOM_TTL = 600            # пустая комната живёт 10 минут
GROUP_ROOM_TTL = 6 * 3600 # стол, привязанный к группе, живёт дольше

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("poker")

HAND_NAMES = ["Старшая карта", "Пара", "Две пары", "Сет", "Стрит", "Флеш", "Фулл-хаус", "Каре", "Стрит-флеш"]
BOT_NAMES = {
    "m": ["Егор", "Артём", "Кирилл", "Даня", "Макс", "Тимур", "Лёша", "Никита"],
    "f": ["Марина", "Настя", "Лера", "Полина", "Катя", "Соня", "Алиса", "Вика"],
}
MALE_EXCEPTIONS = {"никита", "илья", "данила", "кузьма", "фома", "лука", "савва", "саша", "серёжа", "сережа", "миша",
                   "паша", "дима", "лёша", "леша", "ваня", "коля", "петя", "гоша", "тёма", "тема", "лёва", "лева",
                   "стёпа", "степа", "гриша", "костя", "витя", "вова", "толя", "юра", "боря", "слава", "joshua",
                   "luca", "nikita", "ilya", "danila", "misha", "sasha", "pasha", "dima"}


# ---------------------------------------------------------------- карты и комбинации
SUITS = "hsdc"


def new_deck():
    return [(r, s) for s in SUITS for r in range(2, 15)]


def groups(cards):
    cnt = {}
    for r, _ in cards:
        cnt[r] = cnt.get(r, 0) + 1
    return sorted(((c, r) for r, c in cnt.items()), key=lambda x: (-x[0], -x[1]))


def eval5(c):
    rs = sorted((r for r, _ in c), reverse=True)
    flush = len({s for _, s in c}) == 1
    straight = 0
    if len(set(rs)) == 5:
        if rs[0] - rs[4] == 4:
            straight = rs[0]
        elif rs[0] == 14 and rs[1] == 5 and rs[4] == 2:
            straight = 5
    if straight and flush:
        return (8, straight)
    g = groups(c)
    flat = tuple(r for _, r in g)
    if g[0][0] == 4:
        return (7,) + flat
    if g[0][0] == 3 and g[1][0] == 2:
        return (6,) + flat
    if flush:
        return (5,) + tuple(rs)
    if straight:
        return (4, straight)
    if g[0][0] == 3:
        return (3,) + flat
    if g[0][0] == 2 and g[1][0] == 2:
        return (2,) + flat
    if g[0][0] == 2:
        return (1,) + flat
    return (0,) + tuple(rs)


def eval_best(cards):
    if len(cards) < 5:
        g = groups(cards)
        if not g:
            return (0,)
        flat = tuple(r for _, r in g)
        if g[0][0] == 4:
            return (7,) + flat
        if g[0][0] == 3:
            return (3,) + flat
        if g[0][0] == 2 and len(g) > 1 and g[1][0] == 2:
            return (2,) + flat
        if g[0][0] == 2:
            return (1,) + flat
        return (0,) + flat
    return max(eval5(list(c)) for c in itertools.combinations(cards, 5))


def hand_name(score):
    if score[0] == 8 and score[1] == 14:
        return "Флеш-рояль"
    return HAND_NAMES[score[0]]


# ---------------------------------------------------------------- пользователи / аватары
def guess_gender(name):
    n = (name or "").strip().lower()
    first = re.split(r"[\s_\-.]+", n)[0] if n else ""
    if first in MALE_EXCEPTIONS:
        return "m"
    if first.endswith(("а", "я", "a", "ia", "ie", "ine", "elle", "ette")):
        return "f"
    return "m"


def default_avatar(uid, name):
    g = guess_gender(name)
    h = int(hashlib.md5(str(uid).encode()).hexdigest(), 16)
    return f"{g}{h % 8 + 1}"


class UserStore:
    def __init__(self, path):
        self.path = path
        try:
            with open(path) as f:
                self.data = json.load(f)
        except Exception:
            self.data = {}

    def get_avatar(self, uid, name):
        return self.data.get(str(uid), {}).get("avatar") or default_avatar(uid, name)

    def set_avatar(self, uid, avatar):
        self.data.setdefault(str(uid), {})["avatar"] = avatar
        try:
            tmp = self.path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.data, f, ensure_ascii=False)
            os.replace(tmp, self.path)
        except Exception as e:
            log.warning("users.json save failed: %s", e)


USERS = UserStore(USERS_FILE)


def check_init_data(init_data):
    """Проверка подписи Telegram initData. Возвращает dict user или None."""
    if not init_data or not BOT_TOKEN:
        return None
    try:
        pairs = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
        their_hash = pairs.pop("hash", None)
        if not their_hash:
            return None
        check = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
        secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        calc = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calc, their_hash):
            return None
        user = json.loads(pairs.get("user", "{}"))
        if not user.get("id"):
            return None
        return user
    except Exception:
        return None


# ---------------------------------------------------------------- игроки
class Player:
    def __init__(self, uid, name, avatar, bot=False):
        self.id = uid
        self.name = name[:14]
        self.avatar = avatar
        self.bot = bot
        self.stack = START
        self.bet = 0
        self.total = 0
        self.folded = True
        self.all_in = False
        self.acted = False
        self.cards = []
        self.show = False
        self.won = 0
        self.in_hand = False
        self.online = True
        self.offline_since = None
        self.left = False
        self.rebuy = False
        self.score = None
        self.sockets = set()
        self.aggr = random.uniform(0.3, 0.75)
        self.loose = random.uniform(0.3, 0.7)

    def can_act(self):
        return self.in_hand and not self.folded and not self.all_in

    def commit(self, amt):
        amt = min(amt, self.stack)
        self.stack -= amt
        self.bet += amt
        self.total += amt
        if self.stack == 0:
            self.all_in = True
        return amt


# ---------------------------------------------------------------- комната
class Room:
    def __init__(self, code, host_id):
        self.code = code
        self.host = host_id
        self.players = []
        self.phase = "lobby"
        self.community = []
        self.pot = 0
        self.current_bet = 0
        self.min_raise = BB
        self.dealer_id = None
        self.street = ""
        self.to_act = None
        self.deadline = 0
        self.status = ""
        self.hl = False
        self.task = None
        self.hand = []          # игроки текущей раздачи (в порядке мест)
        self.deck = []
        self.action_future = None
        self.empty_since = time.time()
        self.hand_no = 0
        self.chat_id = None       # группа, к которой привязан стол
        self.chat_title = ""
        self.msg_id = None        # сообщение бота со столом в группе
        self.last_group_text = ""
        self.group_task = None

    # ---------- состав ----------
    def humans(self):
        return [p for p in self.players if not p.bot and not p.left]

    def find(self, uid):
        for p in self.players:
            if p.id == uid:
                return p
        return None

    def add_bot(self):
        if len(self.players) >= MAX_SEATS:
            return False
        used = {p.name for p in self.players}
        g = random.choice("mf")
        names = [n for n in BOT_NAMES[g] if n not in used] or BOT_NAMES[g]
        name = random.choice(names)
        p = Player(f"bot:{secrets.token_hex(3)}", name, f"{g}{random.randint(1, 8)}", bot=True)
        self.players.append(p)
        return True

    def remove_bot(self):
        for p in reversed(self.players):
            if p.bot and not p.in_hand:
                self.players.remove(p)
                return True
        for p in reversed(self.players):
            if p.bot:
                p.left = True
                if p.in_hand and not p.folded:
                    p.folded = True
                return True
        return False

    def cleanup(self):
        """Между раздачами: убрать ушедших и давно офлайновых."""
        now = time.time()
        keep = []
        for p in self.players:
            if p.left:
                continue
            if not p.bot and not p.online and p.offline_since and now - p.offline_since > KICK_OFFLINE_AFTER:
                continue
            keep.append(p)
        self.players = keep
        if self.host not in [p.id for p in self.humans()]:
            hs = self.humans()
            self.host = hs[0].id if hs else None

    # ---------- состояние для клиента ----------
    def state_for(self, viewer):
        showdown = self.street == "showdown"
        players = []
        for p in self.players:
            reveal = p is viewer or (p.show and showdown)
            players.append({
                "id": p.id, "name": p.name, "avatar": p.avatar, "bot": p.bot,
                "stack": p.stack, "bet": p.bet, "folded": p.folded, "allIn": p.all_in,
                "inHand": p.in_hand, "online": p.online, "won": p.won, "show": p.show,
                "cards": [[r, s] for r, s in p.cards] if reveal and p.cards else None,
                "rank": hand_name(p.score) if (p.show and showdown and p.score) else None,
            })
        you = next((i for i, p in enumerate(self.players) if p is viewer), -1)
        return {
            "t": "state",
            "code": self.code, "host": self.host, "phase": self.phase,
            "players": players, "you": you,
            "dealer": next((i for i, p in enumerate(self.players) if p.id == self.dealer_id), -1),
            "community": [[r, s] for r, s in self.community],
            "pot": self.pot, "currentBet": self.current_bet, "minRaise": self.min_raise,
            "toAct": next((i for i, p in enumerate(self.players) if p is self.to_act), -1),
            "deadline": int(self.deadline * 1000) if self.deadline else 0,
            "street": self.street, "status": self.status, "hl": self.hl,
        }

    def broadcast(self):
        if self.chat_id:
            schedule_group_update(self)
        for p in self.players:
            if p.bot or not p.sockets:
                continue
            msg = json.dumps(self.state_for(p), ensure_ascii=False)
            for ws in list(p.sockets):
                _spawn(_safe_send(ws, msg))

    def set_status(self, text, hl=False):
        self.status = text
        self.hl = hl

    # ---------- игровой цикл ----------
    def start(self):
        if self.task and not self.task.done():
            return
        self.phase = "playing"
        self.task = asyncio.create_task(self.run())

    async def run(self):
        try:
            while True:
                self.cleanup()
                if not self.humans():
                    self.phase = "closed"
                    break
                if len(self.players) < 2:
                    self.phase = "lobby"
                    self.reset_table()
                    self.set_status("Ждём игроков")
                    self.broadcast()
                    break
                await self.play_hand()
                await asyncio.sleep(4.5)
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("room %s crashed", self.code)
            self.phase = "lobby"
            self.reset_table()
            self.broadcast()

    def reset_table(self):
        self.community = []
        self.pot = 0
        self.street = ""
        self.to_act = None
        self.deadline = 0
        for p in self.players:
            p.cards = []
            p.bet = 0
            p.total = 0
            p.folded = True
            p.in_hand = False
            p.all_in = False
            p.show = False
            p.won = 0

    def next_in_hand(self, start_idx, pred):
        n = len(self.hand)
        for k in range(1, n + 1):
            p = self.hand[(start_idx + k) % n]
            if pred(p):
                return p
        return None

    async def play_hand(self):
        self.hand_no += 1
        for p in self.players:
            p.cards = []
            p.bet = 0
            p.total = 0
            p.all_in = False
            p.acted = False
            p.show = False
            p.won = 0
            p.score = None
            if p.stack <= 0:
                p.stack = START
                p.rebuy = True
            p.in_hand = not p.left
            p.folded = not p.in_hand
        self.hand = [p for p in self.players if p.in_hand]
        rebuys = [p.name for p in self.hand if p.rebuy]
        for p in self.hand:
            p.rebuy = False
        self.community = []
        self.pot = 0
        self.deck = new_deck()
        random.shuffle(self.deck)
        self.street = "preflop"
        self.set_status(("Ребай: " + ", ".join(rebuys)) if rebuys else "")
        self.to_act = None
        self.deadline = 0

        n = len(self.hand)
        ids = [p.id for p in self.hand]
        d_idx = (ids.index(self.dealer_id) + 1) % n if self.dealer_id in ids else random.randrange(n)
        dealer = self.hand[d_idx]
        self.dealer_id = dealer.id
        sb = dealer if n == 2 else self.next_in_hand(d_idx, lambda p: True)
        bb = self.next_in_hand(self.hand.index(sb), lambda p: True)
        sb.commit(SB)
        bb.commit(BB)
        self.current_bet = BB
        self.min_raise = BB
        # раздача
        i = self.hand.index(sb)
        for _ in range(2):
            for _ in range(n):
                self.hand[i].cards.append(self.deck.pop())
                i = (i + 1) % n
        self.broadcast()
        await asyncio.sleep(0.9)

        first = self.next_in_hand(self.hand.index(bb), Player.can_act)
        done = await self.betting_round(first)
        for name, cnt in (("flop", 3), ("turn", 1), ("river", 1)):
            if done:
                break
            self.street = name
            self.current_bet = 0
            self.min_raise = BB
            for _ in range(cnt):
                self.community.append(self.deck.pop())
            self.to_act = None
            self.broadcast()
            await asyncio.sleep(1.0)
            first = self.next_in_hand(d_idx, Player.can_act)
            done = await self.betting_round(first)
        await self.showdown()

    def live(self):
        return [p for p in self.hand if not p.folded]

    async def betting_round(self, start):
        for p in self.hand:
            p.acted = False
        cur = start
        while cur is not None:
            if len(self.live()) == 1:
                break
            actors = [p for p in self.hand if p.can_act()]
            pending = [p for p in actors if not p.acted or p.bet < self.current_bet]
            if not pending:
                break
            if len(actors) == 1 and actors[0].bet >= self.current_bet:
                break
            if cur.can_act() and (not cur.acted or cur.bet < self.current_bet):
                await self.act(cur)
            cur = self.next_in_hand(self.hand.index(cur), Player.can_act)
        await asyncio.sleep(0.5)
        self.pot += sum(p.bet for p in self.hand)
        for p in self.hand:
            p.bet = 0
        self.to_act = None
        self.deadline = 0
        self.broadcast()
        if len(self.live()) == 1:
            return True
        actors = [p for p in self.hand if p.can_act()]
        if len(actors) <= 1:
            if len(self.community) < 5:
                for p in self.live():
                    p.show = True
                self.broadcast()
                while len(self.community) < 5:
                    await asyncio.sleep(1.1)
                    self.community.append(self.deck.pop())
                    self.broadcast()
                await asyncio.sleep(0.8)
            return True
        return False

    async def act(self, p):
        self.to_act = p
        if p.bot:
            self.deadline = 0
            self.broadcast()
            await asyncio.sleep(random.uniform(0.8, 1.7))
            d = self.bot_decide(p)
        elif p.left:
            d = {"type": "fold"}
        else:
            timeout = ACT_TIMEOUT if p.online else OFFLINE_TIMEOUT
            self.deadline = time.time() + timeout
            self.action_future = asyncio.get_running_loop().create_future()
            self.broadcast()
            try:
                d = await asyncio.wait_for(self.action_future, timeout=timeout)
            except asyncio.TimeoutError:
                d = {"type": "check"} if self.current_bet - p.bet <= 0 else {"type": "fold"}
                d["auto"] = True
            self.action_future = None
            self.deadline = 0
        self.apply(p, d)
        self.broadcast()
        await asyncio.sleep(0.25)

    def apply(self, p, d):
        to_call = self.current_bet - p.bet
        t = d.get("type")
        auto = " (время вышло)" if d.get("auto") else ""
        if t == "fold":
            p.folded = True
            self.set_status(f"{p.name} пасует{auto}")
            return
        if t == "check" or (t == "call" and to_call <= 0):
            if to_call > 0:
                p.folded = True
                self.set_status(f"{p.name} пасует")
                return
            p.acted = True
            self.set_status(f"{p.name} чекает{auto}")
            return
        if t == "call":
            amt = p.commit(to_call)
            p.acted = True
            if p.all_in and amt < to_call:
                self.set_status(f"{p.name} идёт олл-ин {amt}")
            elif p.all_in:
                self.set_status(f"{p.name} уравнивает олл-ин")
            else:
                self.set_status(f"{p.name} уравнивает {amt}")
            return
        if t == "raise":
            try:
                to = int(d.get("to", 0))
            except (TypeError, ValueError):
                to = 0
            to = min(to, p.stack + p.bet)
            min_to = self.current_bet + self.min_raise
            if to < min_to and to < p.stack + p.bet:
                to = min(min_to, p.stack + p.bet)
            if to <= self.current_bet:
                p.commit(to_call)
                p.acted = True
                self.set_status(f"{p.name} уравнивает олл-ин")
                return
            p.commit(to - p.bet)
            size = to - self.current_bet
            was_bet = self.current_bet == 0
            if size >= self.min_raise:
                self.min_raise = size
                for x in self.hand:
                    if x is not p:
                        x.acted = False
            self.current_bet = to
            p.acted = True
            if p.all_in:
                self.set_status(f"{p.name} идёт олл-ин {to}")
            elif was_bet:
                self.set_status(f"{p.name} ставит {to}")
            else:
                self.set_status(f"{p.name} повышает до {to}")
            return
        # неизвестное действие — как чек/фолд
        self.apply(p, {"type": "check"})

    async def showdown(self):
        self.street = "showdown"
        self.to_act = None
        self.deadline = 0
        contenders = self.live()
        if len(contenders) == 1:
            w = contenders[0]
            w.won = self.pot
            w.stack += self.pot
            self.set_status(f"{w.name} забирает {self.pot}", True)
        else:
            for p in contenders:
                p.show = True
                p.score = eval_best(p.cards + self.community)
            levels = sorted({p.total for p in contenders})
            total_in = sum(p.total for p in self.hand)
            prev = 0
            distributed = 0
            for li, L in enumerate(levels):
                portion = sum(min(p.total, L) for p in self.hand) - sum(min(p.total, prev) for p in self.hand)
                if li == len(levels) - 1:
                    portion = total_in - distributed
                distributed += portion
                prev = L
                if portion <= 0:
                    continue
                elig = [p for p in contenders if p.total >= L]
                best = max(p.score for p in elig)
                winners = [p for p in elig if p.score == best]
                share = portion // len(winners)
                for i, w in enumerate(winners):
                    amt = share + (portion - share * len(winners) if i == 0 else 0)
                    w.won += amt
                    w.stack += amt
            ws = [p for p in contenders if p.won > 0]
            self.set_status(", ".join(f"{w.name} выигрывает {w.won} · {hand_name(w.score)}" for w in ws), True)
        self.pot = 0
        self.broadcast()
        await asyncio.sleep(1.5 if len(contenders) == 1 else 3.5)

    # ---------- боты ----------
    def preflop_strength(self, cards):
        (a, sa), (b, sb_) = sorted(cards, reverse=True)
        if a == b:
            return 0.55 + (a - 2) / 12 * 0.45
        s = ((a + b) / 28) * 0.62
        gap = a - b
        if sa == sb_:
            s += 0.07
        if gap == 1:
            s += 0.07
        elif gap == 2:
            s += 0.04
        elif gap > 4:
            s -= 0.06
        if a == 14:
            s += 0.06
        return max(0.05, min(0.85, s))

    def postflop_strength(self, p):
        allc = p.cards + self.community
        score = eval_best(allc)
        board_top = max(r for r, _ in self.community)
        board_score = eval_best(self.community)
        cat = score[0]
        if cat == 0:
            s = 0.12 + (0.08 if score[1] == 14 else 0)
        elif cat == 1:
            s = 0.28 if board_score[0] >= 1 else (0.55 if score[1] >= board_top else 0.4)
        elif cat == 2:
            s = 0.45 if board_score[0] >= 2 else 0.7
        elif cat == 3:
            s = 0.8
        elif cat == 4:
            s = 0.87
        elif cat == 5:
            s = 0.9
        else:
            s = 0.97
        if len(self.community) < 5:
            suits = {}
            for _, su in allc:
                suits[su] = suits.get(su, 0) + 1
            if 4 in suits.values():
                s += 0.18
            rs = sorted({r for r, _ in allc})
            run = best = 1
            for i in range(1, len(rs)):
                run = run + 1 if rs[i] - rs[i - 1] == 1 else 1
                best = max(best, run)
            if best == 4:
                s += 0.15
        return min(1.0, s)

    def bot_decide(self, p):
        to_call = self.current_bet - p.bet
        pot_now = self.pot + sum(x.bet for x in self.hand)
        s = self.preflop_strength(p.cards) if self.street == "preflop" else self.postflop_strength(p)
        s += (random.random() - 0.5) * 0.16 + (p.loose - 0.5) * 0.15
        aggr = p.aggr
        min_to = self.current_bet + self.min_raise

        def raise_to(mult):
            to = max(min_to, round(pot_now * mult / 5) * 5)
            return min(to, p.stack + p.bet)

        if to_call <= 0:
            if s > 0.62 and random.random() < aggr + 0.2:
                return {"type": "raise", "to": raise_to(0.5 + random.random() * 0.5)}
            if s < 0.3 and random.random() < aggr * 0.25:
                return {"type": "raise", "to": raise_to(0.5)}
            return {"type": "check"}
        pot_odds = to_call / (pot_now + to_call)
        if to_call >= p.stack:
            return {"type": "call"} if s > 0.72 or (s > 0.5 and pot_odds < 0.3) else {"type": "fold"}
        if s > 0.78 and random.random() < aggr + 0.15:
            return {"type": "raise", "to": raise_to(0.7 + random.random() * 0.6)}
        if s > pot_odds + 0.12:
            return {"type": "call"}
        if to_call <= BB and s > 0.22 and random.random() < p.loose:
            return {"type": "call"}
        if random.random() < aggr * 0.12 and self.street != "preflop":
            return {"type": "raise", "to": raise_to(0.8)}
        return {"type": "fold"}


# ---------------------------------------------------------------- сервер
ROOMS = {}
USER_ROOM = {}
_TASKS = set()


async def _safe_send(ws, msg):
    try:
        await ws.send(msg)
    except Exception:
        pass


def _spawn(coro):
    t = asyncio.create_task(coro)
    _TASKS.add(t)
    t.add_done_callback(_TASKS.discard)
    return t


def new_code():
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(4))
        if code not in ROOMS:
            return code


def get_room(code):
    code = (code or "").upper().strip()
    if code.startswith("G") and code[1:].lstrip("-").isdigit() and len(code) > 5:
        return ensure_group_room(int(code[1:]), "")  # g<chat_id> — стол, привязанный к группе
    r = ROOMS.get(code)
    if r and r.phase == "closed":
        return None
    return r


CHAT_ROOM = {}


def ensure_group_room(chat_id, title):
    code = CHAT_ROOM.get(chat_id)
    room = ROOMS.get(code) if code else None
    if room is None or room.phase == "closed":
        room = Room(new_code(), None)
        room.chat_id = chat_id
        room.chat_title = title or ""
        ROOMS[room.code] = room
        CHAT_ROOM[chat_id] = room.code
    elif title:
        room.chat_title = title
    return room


class Conn:
    def __init__(self, ws):
        self.ws = ws
        self.uid = None
        self.name = None
        self.avatar = None
        self.player = None
        self.room = None


async def send(ws, obj):
    await _safe_send(ws, json.dumps(obj, ensure_ascii=False))


def detach(conn):
    """Отвязать сокет от игрока (при отключении или смене комнаты)."""
    p = conn.player
    if p is None:
        return
    p.sockets.discard(conn.ws)
    if not p.sockets:
        p.online = False
        p.offline_since = time.time()
    conn.player = None
    conn.room = None


def leave_room(conn):
    room, p = conn.room, conn.player
    if room is None or p is None:
        return
    p.sockets.discard(conn.ws)
    p.left = True
    if p.in_hand and not p.folded:
        p.folded = True
        if room.to_act is p and room.action_future and not room.action_future.done():
            room.action_future.set_result({"type": "fold"})
    if room.phase == "lobby":
        room.players = [x for x in room.players if x is not p]
        room.cleanup()
    USER_ROOM.pop(conn.uid, None)
    conn.player = None
    conn.room = None
    if not room.humans():
        room.empty_since = time.time()
    room.broadcast()


def join_room(conn, room):
    if conn.room is room:
        return True
    if conn.room is not None:
        leave_room(conn)
    p = room.find(conn.uid)
    if p is not None and p.left:
        if p.in_hand:
            p.left = False  # вернулся в ту же раздачу — досидит как сбросивший
        else:
            room.players.remove(p)
            p = None
    if p is None:
        if len([x for x in room.players if not x.left]) >= MAX_SEATS:
            return False
        p = Player(conn.uid, conn.name, conn.avatar)
        room.players.append(p)
        if room.host is None:
            room.host = p.id
    p.name = conn.name
    p.avatar = conn.avatar
    p.sockets.add(conn.ws)
    p.online = True
    p.offline_since = None
    conn.player = p
    conn.room = room
    USER_ROOM[conn.uid] = room.code
    room.empty_since = None
    room.broadcast()
    return True


async def handle(ws):
    conn = Conn(ws)
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            t = msg.get("t")
            if t == "ping":
                await send(ws, {"t": "pong"})
                continue
            if t == "auth":
                user = check_init_data(msg.get("initData", ""))
                if user:
                    conn.uid = f"tg:{user['id']}"
                    conn.name = (user.get("first_name") or user.get("username") or "Игрок").strip()[:14]
                elif ALLOW_DEV and msg.get("dev"):
                    dev = msg["dev"]
                    conn.uid = "dev:" + re.sub(r"[^\w-]", "", str(dev.get("id", "")))[:32]
                    conn.name = (str(dev.get("name") or "Гость").strip() or "Гость")[:14]
                else:
                    await send(ws, {"t": "error", "msg": "Откройте игру через Telegram", "fatal": True})
                    continue
                conn.avatar = USERS.get_avatar(conn.uid, conn.name)
                await send(ws, {"t": "me", "id": conn.uid, "name": conn.name, "avatar": conn.avatar})
                want = (msg.get("room") or "").upper().strip()
                room = get_room(want) if want else None
                if room is None and conn.uid in USER_ROOM:
                    room = get_room(USER_ROOM[conn.uid])
                if room is not None:
                    if not join_room(conn, room):
                        await send(ws, {"t": "error", "msg": "Стол полон"})
                        await send(ws, {"t": "home"})
                else:
                    if want:
                        await send(ws, {"t": "error", "msg": f"Стол {want} не найден"})
                    await send(ws, {"t": "home"})
                continue
            if conn.uid is None:
                await send(ws, {"t": "error", "msg": "Сначала auth"})
                continue
            if t == "avatar":
                av = str(msg.get("avatar", ""))
                if re.fullmatch(r"[mf][1-8]", av):
                    conn.avatar = av
                    USERS.set_avatar(conn.uid, av)
                    if conn.player:
                        conn.player.avatar = av
                        conn.room.broadcast()
                    await send(ws, {"t": "me", "id": conn.uid, "name": conn.name, "avatar": conn.avatar})
                continue
            if t == "create":
                if conn.room is not None:
                    leave_room(conn)
                room = Room(new_code(), conn.uid)
                ROOMS[room.code] = room
                join_room(conn, room)
                bots = max(0, min(MAX_SEATS - 1, int(msg.get("bots", 0) or 0)))
                for _ in range(bots):
                    room.add_bot()
                if msg.get("autostart") and len(room.players) >= 2:
                    room.start()
                room.broadcast()
                continue
            if t == "join":
                room = get_room(msg.get("room"))
                if room is None:
                    await send(ws, {"t": "error", "msg": "Стол не найден"})
                    continue
                if not join_room(conn, room):
                    await send(ws, {"t": "error", "msg": "Стол полон"})
                continue
            if t == "leave":
                leave_room(conn)
                await send(ws, {"t": "home"})
                continue
            room = conn.room
            if room is None:
                continue
            is_host = room.host == conn.uid
            if t == "add_bot" and is_host:
                if not room.add_bot():
                    await send(ws, {"t": "error", "msg": "Мест нет"})
                room.broadcast()
            elif t == "remove_bot" and is_host:
                room.remove_bot()
                room.broadcast()
            elif t == "start" and is_host:
                if len([p for p in room.players if not p.left]) < 2:
                    await send(ws, {"t": "error", "msg": "Нужно минимум 2 игрока"})
                else:
                    room.start()
                    room.broadcast()
            elif t == "act":
                if room.to_act is conn.player and room.action_future and not room.action_future.done():
                    room.action_future.set_result({"type": msg.get("type"), "to": msg.get("to")})
            elif t == "sync":
                await send(ws, room.state_for(conn.player))
    except ConnectionClosed:
        pass
    finally:
        if conn.room is not None:
            room = conn.room
            detach(conn)
            room.broadcast()


async def janitor():
    while True:
        await asyncio.sleep(30)
        now = time.time()
        for code, room in list(ROOMS.items()):
            ttl = GROUP_ROOM_TTL if room.chat_id else ROOM_TTL
            if room.phase == "closed" or (not room.humans() and room.empty_since and now - room.empty_since > ttl):
                if room.task and not room.task.done():
                    room.task.cancel()
                for p in room.players:
                    USER_ROOM.pop(p.id, None)
                ROOMS.pop(code, None)
                if room.chat_id and CHAT_ROOM.get(room.chat_id) == code:
                    CHAT_ROOM.pop(room.chat_id, None)
                log.info("room %s removed", code)


# ---------------------------------------------------------------- Telegram-бот (внутри сервера)
import urllib.request
import urllib.error

BOT_USERNAME = ""


def _tg_sync(method, **params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{BOT_TOKEN}/{method}", data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


async def tg(method, **params):
    try:
        return await asyncio.to_thread(_tg_sync, method, **params)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:200]
        log.warning("tg %s failed: %s %s", method, e.code, body)
    except Exception as e:
        log.warning("tg %s failed: %s", method, e)
    return None


def room_link(room):
    """Ссылка на стол для кнопки в группе."""
    param = f"g{room.chat_id}" if room.chat_id else room.code
    if APP_SHORT_NAME:
        return f"https://t.me/{BOT_USERNAME}/{APP_SHORT_NAME}?startapp={param}"
    return f"https://t.me/{BOT_USERNAME}?start={param}"


def group_text(room):
    humans = [p for p in room.players if not p.left]
    names = ", ".join(p.name + (" 🤖" if p.bot else "") for p in humans) or "пока никого"
    if room.phase == "playing":
        state = f"Идёт игра, раздача №{room.hand_no}. Можно подсесть — попадёшь в следующую раздачу."
    else:
        state = "Ждём игроков. Нужно минимум 2 человека, стол до 5 мест."
    return (f"🃏 Кашпокер — стол {room.code}\n\n"
            f"За столом ({len(humans)}/5): {names}\n{state}\n\n"
            f"Жми кнопку, чтобы сесть. Код для входа вручную: {room.code}")


def group_markup(room):
    return {"inline_keyboard": [[{"text": "Сесть за стол 🃏", "url": room_link(room)}]]}


async def post_group_message(room):
    res = await tg("sendMessage", chat_id=room.chat_id, text=group_text(room), reply_markup=group_markup(room))
    if res and res.get("ok"):
        room.msg_id = res["result"]["message_id"]
        room.last_group_text = group_text(room)


def schedule_group_update(room):
    if room.group_task and not room.group_task.done():
        return
    room.group_task = _spawn(_group_update(room))


async def _group_update(room):
    await asyncio.sleep(2.0)
    if not room.chat_id or not room.msg_id:
        return
    text = group_text(room)
    if text == room.last_group_text:
        return
    room.last_group_text = text
    await tg("editMessageText", chat_id=room.chat_id, message_id=room.msg_id, text=text, reply_markup=group_markup(room))


def web_app_markup(room):
    url = f"{APP_URL}?room={room.code}" if room else APP_URL
    return {"inline_keyboard": [[{"text": "Сесть за стол 🃏" if room else "Играть 🃏", "web_app": {"url": url}}]]}


async def handle_update(upd):
    msg = upd.get("message")
    if msg:
        chat = msg.get("chat", {})
        ctype = chat.get("type")
        text = (msg.get("text") or "").strip()
        cmd = text.split()[0].lower().split("@")[0] if text.startswith("/") else ""
        if ctype == "private":
            if cmd == "/start":
                parts = text.split(maxsplit=1)
                param = parts[1].strip() if len(parts) > 1 else ""
                room = get_room(param) if param else None
                if room:
                    who = f" в чате «{room.chat_title}»" if room.chat_title else ""
                    await tg("sendMessage", chat_id=chat["id"],
                             text=f"Тебя зовут за стол {room.code}{who}.\nЖми «Сесть за стол» — карты уже тасуются.",
                             reply_markup=web_app_markup(room))
                else:
                    await tg("sendMessage", chat_id=chat["id"],
                             text=("Кашпокер — техасский холдем с друзьями или против ботов.\n"
                                   "Создай стол и кинь ссылку друзьям, или добавь меня в группу — "
                                   "я соберу стол прямо там.\nБлайнды 5/10, стек 250."),
                             reply_markup=web_app_markup(None))
            return
        if ctype in ("group", "supergroup"):
            new_members = msg.get("new_chat_members") or []
            if any(m.get("username") == BOT_USERNAME for m in new_members):
                await group_table(chat, greet=True)
                return
            if cmd in ("/poker", "/start", "/table", "/stol", "/game"):
                await group_table(chat)
            return
    cm = upd.get("my_chat_member")
    if cm:
        chat = cm.get("chat", {})
        new = cm.get("new_chat_member", {})
        if chat.get("type") in ("group", "supergroup") and new.get("user", {}).get("username") == BOT_USERNAME \
                and new.get("status") in ("member", "administrator"):
            await group_table(chat, greet=True)


async def group_table(chat, greet=False):
    room = ensure_group_room(chat["id"], chat.get("title", ""))
    if greet:
        await tg("sendMessage", chat_id=chat["id"],
                 text="Привет! Я Кашпокер — покер прямо в этом чате. Ниже стол для вас: жмите кнопку и садитесь. "
                      "Новый стол — команда /poker.")
    await post_group_message(room)


async def bot_loop():
    global BOT_USERNAME
    me = await tg("getMe")
    if not me or not me.get("ok"):
        log.warning("bot: getMe failed, polling disabled")
        return
    BOT_USERNAME = me["result"]["username"]
    log.info("bot @%s polling", BOT_USERNAME)
    await tg("setMyCommands", commands=[{"command": "poker", "description": "Собрать стол в этом чате"}],
             scope={"type": "all_group_chats"})
    await tg("setMyCommands", commands=[{"command": "start", "description": "Открыть Кашпокер"}],
             scope={"type": "all_private_chats"})
    offset = 0
    while True:
        res = await tg("getUpdates", offset=offset, timeout=50, allowed_updates=["message", "my_chat_member"])
        if not res or not res.get("ok"):
            await asyncio.sleep(3)
            continue
        for upd in res.get("result", []):
            offset = upd["update_id"] + 1
            try:
                await handle_update(upd)
            except Exception:
                log.exception("bot update failed")


async def main():
    if not BOT_TOKEN:
        log.warning("BOT_TOKEN не задан — проверка initData отключена, только dev-режим")
    async with serve(handle, "127.0.0.1", PORT, ping_interval=20, ping_timeout=20, max_size=64 * 1024):
        log.info("poker ws on 127.0.0.1:%s (dev=%s)", PORT, ALLOW_DEV)
        if BOT_TOKEN and BOT_POLL:
            _spawn(bot_loop())
        await janitor()


if __name__ == "__main__":
    asyncio.run(main())
