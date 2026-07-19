"""Private-profile gating.

The model, deliberately inverted from a normal login: profiles are public by
default and the *private* ones hide. Everyday users (parents, kids) open the app
and see their own results with no PIN, no account, no interaction ever. Only
profiles explicitly marked private are withheld until someone enters the PIN on
that device, which mints a long-lived session token.

Enforcement is server-side: a private member's results are not reachable through
the API without a live session, so this is a wall rather than a UI curtain.
"""
import hashlib
import hmac
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

PIN_SETTING = "private_pin"
SESSION_DAYS = 90          # valid for 90 days for family members
_ITERATIONS = 200_000

# A short PIN is only safe if guessing is slow. Track failures per client and
# back off — an 8-digit PIN is 10^8, trivial to grind at network speed otherwise.
_MAX_FAILS = 5
_LOCKOUT_SECONDS = 300
_fails: dict = {}


def hash_pin(pin: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), _ITERATIONS)
    return f"pbkdf2${_ITERATIONS}${salt}${dk.hex()}"


def verify_pin(pin: str, stored: str) -> bool:
    try:
        scheme, iters, salt, want = stored.split("$")
        if scheme != "pbkdf2":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(dk.hex(), want)
    except Exception:
        return False


def validate_pin_format(pin: str) -> Optional[str]:
    """Return an error message, or None when the PIN is acceptable."""
    if not pin or not pin.isdigit():
        return "PIN must be digits only"
    if not (4 <= len(pin) <= 8):
        return "PIN must be 4 to 8 digits"
    return None


# ---------------- brute-force backoff ----------------

def throttle_check(client: str) -> Optional[int]:
    """Seconds remaining in lockout, or None when the client may try.

    Records are (fail_count, lockout_until, last_failure_at). Pruning keys off
    last_failure_at, NOT lockout_until: an earlier version pruned on
    `now > lockout_until`, but partial failures store lockout_until=0, so every
    call — and unlock() calls this before each attempt — deleted the running
    count and the lockout could never be reached at all.
    """
    now = time.time()
    for k, v in list(_fails.items()):
        if now - v[2] > _LOCKOUT_SECONDS:
            _fails.pop(k, None)

    rec = _fails.get(client)
    if not rec:
        return None
    count, until, _ = rec
    if count >= _MAX_FAILS and now < until:
        return int(until - now) + 1
    return None


def throttle_fail(client: str) -> None:
    now = time.time()
    count, _, _ = _fails.get(client, (0, 0.0, 0.0))
    count += 1
    until = now + _LOCKOUT_SECONDS if count >= _MAX_FAILS else 0.0
    _fails[client] = (count, until, now)


def throttle_reset(client: str) -> None:
    _fails.pop(client, None)


# ---------------- sessions ----------------

def create_session(conn) -> dict:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    conn.execute(
        "INSERT INTO unlock_sessions (token, expires_at) VALUES (?, ?)",
        (token, expires.isoformat()),
    )
    conn.commit()
    return {"token": token, "expires_at": expires.isoformat()}


def session_valid(conn, token: Optional[str]) -> bool:
    if not token:
        return False
    row = conn.execute("SELECT expires_at FROM unlock_sessions WHERE token = ?", (token,)).fetchone()
    if not row:
        return False
    try:
        if datetime.fromisoformat(row["expires_at"]) < datetime.now(timezone.utc):
            conn.execute("DELETE FROM unlock_sessions WHERE token = ?", (token,))
            conn.commit()
            return False
    except ValueError:
        return False
    return True


def drop_session(conn, token: Optional[str]) -> None:
    if token:
        conn.execute("DELETE FROM unlock_sessions WHERE token = ?", (token,))
        conn.commit()


def drop_all_sessions(conn) -> None:
    conn.execute("DELETE FROM unlock_sessions")
    conn.commit()


# ---------------- visibility ----------------

def get_pin_hash(conn) -> Optional[str]:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (PIN_SETTING,)).fetchone()
    return row["value"] if row and row["value"] else None


# ---------------- forgotten-PIN recovery ----------------
#
# A self-hosted app has a better root of trust than a second secret you can
# also lose: physical access to the server. Dropping a file into the data
# volume proves ownership, so recovery needs no recovery code and no email.
#
#     docker compose exec labtracker touch /data/RESET_PIN && docker compose restart
#     # or, since ./data is bind-mounted:  touch ./data/RESET_PIN
#
# On the next start the PIN is cleared and every unlock session is dropped.
# NOTHING else is touched: results, documents and each profile's `private`
# flag all survive, so setting a new PIN immediately restores the exact same
# privacy arrangement. Between the reset and setting a new PIN, profiles marked
# private are visible — that window is the deliberate cost of recovery, and it
# only opens for someone who already has server access.
RESET_SENTINEL = "RESET_PIN"


def maybe_reset_pin(conn, data_dir) -> bool:
    """Clear the PIN if the reset sentinel file is present. Returns True if a
    reset happened. Idempotent — the sentinel is removed once honoured."""
    from pathlib import Path

    sentinel = Path(data_dir) / RESET_SENTINEL
    try:
        if not sentinel.exists():
            return False
    except OSError:
        return False

    had_pin = get_pin_hash(conn) is not None
    conn.execute("DELETE FROM settings WHERE key = ?", (PIN_SETTING,))
    conn.execute("DELETE FROM unlock_sessions")
    conn.commit()
    try:
        sentinel.unlink()
    except OSError:
        pass  # honoured anyway; worst case it resets again next boot

    n_private = conn.execute("SELECT COUNT(*) c FROM members WHERE private = 1").fetchone()["c"]
    print(
        f"[access] PIN reset via {RESET_SENTINEL} sentinel "
        f"({'a PIN was set' if had_pin else 'no PIN was set'}). "
        f"{n_private} profile(s) keep their private flag and will be hidden again "
        f"as soon as a new PIN is set. No results or documents were touched.",
        flush=True,
    )
    return True


def visible_member_ids(conn, unlocked: bool) -> set:
    """Ids the caller may see: public profiles always, private ones only when
    this device has been unlocked. If no PIN is configured at all, nothing is
    private and everything is visible."""
    if unlocked or not get_pin_hash(conn):
        return {r["id"] for r in conn.execute("SELECT id FROM members")}
    return {r["id"] for r in conn.execute("SELECT id FROM members WHERE private = 0")}


def can_see(conn, unlocked: bool, member_id: Optional[int]) -> bool:
    # An upload not yet attributed to anyone belongs to whoever is mid-import.
    if member_id is None:
        return True
    return member_id in visible_member_ids(conn, unlocked)
