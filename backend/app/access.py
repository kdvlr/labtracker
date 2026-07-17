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
SESSION_DAYS = 400          # a phone should stay unlocked essentially forever
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
    """Seconds remaining in lockout, or None when the client may try."""
    rec = _fails.get(client)
    if not rec:
        return None
    count, until = rec
    if count >= _MAX_FAILS and time.time() < until:
        return int(until - time.time()) + 1
    return None


def throttle_fail(client: str) -> None:
    count, _ = _fails.get(client, (0, 0))
    count += 1
    _fails[client] = (count, time.time() + _LOCKOUT_SECONDS if count >= _MAX_FAILS else 0)


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
