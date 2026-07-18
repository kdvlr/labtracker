import csv
import io
import json
import mimetypes
import re
import uuid
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import access, ai
from .config import FILES_DIR
from .db import get_db, init_db, row_to_dict
from .matching import match_test_type
from .reference import CATEGORIES, age_at, categorize, resolve_range
from .units import compute_flag, known_units, parse_value, to_canonical, to_number

app = FastAPI(title="Rakta Charitra")


@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, private"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response



@app.on_event("startup")
def _startup():
    init_db()


# ---------------- private-profile access ----------------

def _token(request: Request) -> Optional[str]:
    return request.headers.get("X-Unlock") or None


def _unlocked(conn, request: Request) -> bool:
    return access.session_valid(conn, _token(request))


def _visible(conn, request: Request) -> set:
    return access.visible_member_ids(conn, _unlocked(conn, request))


def _require_member(conn, request: Request, member_id: Optional[int]):
    """404 on a member this device isn't allowed to see.

    Deliberately 404 and not 403: a private profile shouldn't even confirm it
    exists to someone who hasn't unlocked.
    """
    if not access.can_see(conn, _unlocked(conn, request), member_id):
        raise HTTPException(404, "Not found")


def _require_unlocked(conn, request: Request):
    """Guard for actions that manage privacy itself. Without this, anyone could
    simply clear the PIN and the whole scheme would be decorative. Bootstrap
    case: when no PIN exists yet, the first person may set one."""
    if access.get_pin_hash(conn) and not access.settings_session_valid(conn, _token(request)):
        raise HTTPException(403, "Enter the PIN to change privacy settings")


def _require_doc(conn, request: Request, doc_id: int):
    """A document belongs to whoever it was uploaded for — the stored PDF is the
    rawest copy of a result, so it inherits that member's visibility."""
    row = conn.execute("SELECT member_id FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Not found")
    _require_member(conn, request, row["member_id"])


def recompute_doc_status(conn, doc_id: int) -> str:
    """Derive a document's status from the outcome of its extracted rows.

    Single source of truth so the commit path and the per-row import path can't
    drift. Statuses, by how many rows landed where:
      - some still need review + some imported  -> partially_imported
      - some still need review, none imported    -> needs_review
      - none need review, some imported          -> fully_imported
      - none need review, none imported, but rows exist -> the user skipped
        them all: that's 'reviewed', not 'failed'. 'failed' is reserved for a
        document with no usable rows at all (extraction genuinely produced
        nothing), so a red error state never appears for a deliberate choice.
    """
    counts = conn.execute(
        """SELECT
             COUNT(*) AS total,
             SUM(status = 'needs_review') AS needs_review,
             SUM(status = 'imported')     AS imported,
             SUM(status = 'skipped')      AS skipped
           FROM document_items WHERE document_id = ?""",
        (doc_id,),
    ).fetchone()
    total = counts["total"] or 0
    needs_review = counts["needs_review"] or 0
    imported = counts["imported"] or 0
    skipped = counts["skipped"] or 0

    if needs_review > 0:
        status = "partially_imported" if imported > 0 else "needs_review"
    elif imported > 0:
        status = "fully_imported"
    elif skipped > 0:
        status = "reviewed"          # nothing wrong — the user chose to skip
    else:
        status = "failed"            # no usable rows at all
    conn.execute("UPDATE documents SET status = ? WHERE id = ?", (status, doc_id))
    return status


# ---------------- helpers ----------------

def _get_setting(conn, key: str, default=None):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def _ai_config(conn, override_provider=None, override_model=None):
    provider = override_provider or _get_setting(conn, "ai_provider", "anthropic")
    model = override_model or _get_setting(conn, f"ai_model_{provider}") or None
    key = _get_setting(conn, f"ai_key_{provider}")
    
    # If key is not in DB, check environment variables
    if not key:
        import os
        env_vars = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY"}
        key = os.environ.get(env_vars.get(provider, ""))
        
    # Auto-fallback if the chosen provider has no key but another one does
    if not key and not override_provider:
        import os
        for p in ("gemini", "openai", "anthropic"):
            if p == provider:
                continue
            k = _get_setting(conn, f"ai_key_{p}") or os.environ.get(f"{p.upper()}_API_KEY")
            if k:
                provider = p
                model = _get_setting(conn, f"ai_model_{p}") or None
                key = k
                break
    return provider, model, key



def _test_types(conn) -> list:
    rows = conn.execute("SELECT * FROM test_types ORDER BY category, name").fetchall()
    return [row_to_dict(r) for r in rows]


# ---------------- unlock / PIN ----------------

class PinReq(BaseModel):
    pin: str
    scope: Optional[str] = "member"


class SetPinReq(BaseModel):
    new_pin: Optional[str] = None   # None/"" clears the PIN (unlocks everything)
    current_pin: Optional[str] = None


@app.get("/api/access")
def access_state(request: Request):
    """What this device can see. Safe to call unauthenticated — it reveals only
    whether a PIN exists, never the PIN or who is hidden."""
    conn = get_db()
    try:
        unlocked = _unlocked(conn, request)
        n_private = conn.execute("SELECT COUNT(*) c FROM members WHERE private = 1").fetchone()["c"]
        return {
            "has_pin": bool(access.get_pin_hash(conn)),
            "unlocked": unlocked,
            "private_count": n_private if unlocked else None,
        }
    finally:
        conn.close()


@app.post("/api/unlock")
def unlock(req: PinReq, request: Request):
    conn = get_db()
    try:
        stored = access.get_pin_hash(conn)
        if not stored:
            raise HTTPException(400, "No PIN is set")
        client = request.client.host if request.client else "unknown"
        wait = access.throttle_check(client)
        if wait:
            raise HTTPException(429, f"Too many attempts. Try again in {wait}s.")
        if not access.verify_pin(req.pin or "", stored):
            access.throttle_fail(client)
            raise HTTPException(401, "Incorrect PIN")
        access.throttle_reset(client)
        return access.create_session(conn, scope=req.scope or "member")
    finally:
        conn.close()


@app.post("/api/lock")
def lock(request: Request):
    conn = get_db()
    try:
        access.drop_session(conn, _token(request))
        return {"ok": True}
    finally:
        conn.close()


@app.put("/api/access/pin")
def set_pin(req: SetPinReq, request: Request):
    """Set, change, or clear the PIN. Requires an unlocked device once a PIN
    exists — otherwise anyone could clear it and walk in."""
    conn = get_db()
    try:
        stored = access.get_pin_hash(conn)
        if stored and not _unlocked(conn, request):
            # Allow a change by presenting the current PIN instead of a session.
            if not (req.current_pin and access.verify_pin(req.current_pin, stored)):
                raise HTTPException(403, "Enter the current PIN first")
        new = (req.new_pin or "").strip()
        if not new:
            conn.execute("DELETE FROM settings WHERE key = ?", (access.PIN_SETTING,))
            conn.execute("UPDATE members SET private = 0")
            access.drop_all_sessions(conn)
            conn.commit()
            return {"has_pin": False, "note": "PIN cleared; all profiles are public again"}
        err = access.validate_pin_format(new)
        if err:
            raise HTTPException(400, err)
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (access.PIN_SETTING, access.hash_pin(new)),
        )
        # Changing the PIN must not leave old devices unlocked.
        access.drop_all_sessions(conn)
        conn.commit()
        return {"has_pin": True}
    finally:
        conn.close()


# ---------------- members ----------------

class Member(BaseModel):
    name: str
    dob: Optional[str] = None
    sex: Optional[str] = None
    color: Optional[str] = None
    private: Optional[bool] = None


@app.get("/api/members")
def list_members(request: Request):
    conn = get_db()
    try:
        vis = _visible(conn, request)
        rows = conn.execute("SELECT * FROM members ORDER BY id").fetchall()
        return [dict(r) for r in rows if r["id"] in vis]
    finally:
        conn.close()


@app.post("/api/members")
def create_member(m: Member, request: Request):
    conn = get_db()
    try:
        if m.private:
            _require_unlocked(conn, request)
        cur = conn.execute(
            "INSERT INTO members (name, dob, sex, color, private) VALUES (?, ?, ?, ?, ?)",
            (m.name, m.dob, m.sex, m.color, 1 if m.private else 0),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM members WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@app.put("/api/members/{member_id}")
def update_member(member_id: int, m: Member, request: Request):
    conn = get_db()
    try:
        _require_member(conn, request, member_id)
        row = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        # Flipping privacy either way is a privacy change — gate it.
        private = row["private"] if m.private is None else (1 if m.private else 0)
        if private != row["private"]:
            _require_unlocked(conn, request)
        conn.execute(
            "UPDATE members SET name = ?, dob = ?, sex = ?, color = ?, private = ? WHERE id = ?",
            (m.name, m.dob, m.sex, m.color, private, member_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@app.delete("/api/members/{member_id}")
def delete_member(member_id: int, request: Request):
    conn = get_db()
    try:
        _require_member(conn, request, member_id)
        conn.execute("DELETE FROM members WHERE id = ?", (member_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------------- test types ----------------

@app.get("/api/test-types")
def get_test_types():
    conn = get_db()
    try:
        return _test_types(conn)
    finally:
        conn.close()


def _slugify(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return s or "test"


class NewTestType(BaseModel):
    name: str
    canonical_unit: str = ""
    category: Optional[str] = None
    ref_low: Optional[float] = None
    ref_high: Optional[float] = None


@app.post("/api/test-types")
def create_test_type(t: NewTestType):
    """Create a test type on the fly so any extracted test can be tracked.

    The first-seen unit becomes the canonical unit; the report's reference range
    (if any) becomes the canonical default. The name is stored as an alias so
    future uploads of the same test match this type instead of duplicating it.
    """
    name = t.name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    conn = get_db()
    try:
        # Reuse an existing type if the name already matches one (avoid dupes).
        existing = match_test_type(name, _test_types(conn))
        if existing:
            return existing
        base = _slugify(name)
        slug = base
        n = 2
        while conn.execute("SELECT 1 FROM test_types WHERE slug = ?", (slug,)).fetchone():
            slug = f"{base}-{n}"
            n += 1
        cur = conn.execute(
            """INSERT INTO test_types (name, slug, category, canonical_unit, conversions,
                                       ref_low, ref_high, aliases)
               VALUES (?, ?, ?, ?, '{}', ?, ?, ?)""",
            (name, slug, t.category or categorize(name), (t.canonical_unit or "").strip(),
             t.ref_low, t.ref_high, json.dumps([name])),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM test_types WHERE id = ?", (cur.lastrowid,)).fetchone()
        return row_to_dict(row)
    finally:
        conn.close()


DESCRIBE_SYSTEM = (
    "You are a clinical reference assistant. In 2-3 plain-language sentences, explain "
    "what this lab biomarker measures, why it matters, and what higher or lower values "
    "can indicate. Write for a curious layperson. No preamble, no markdown, no lists, "
    "and do not add a medical-advice disclaimer."
)


def _calculate_age(dob_str: Optional[str]) -> Optional[int]:
    if not dob_str:
        return None
    try:
        from datetime import date
        born = date.fromisoformat(dob_str[:10])
        today = date.today()
        return today.year - born.year - ((today.month, today.day) < (born.month, born.day))
    except Exception:
        return None


@app.post("/api/test-types/{tt_id}/describe")
def describe_test_type(tt_id: int, request: Request, member_id: Optional[int] = None, force_refresh: bool = False):
    """Return a clinical reference description. If member_id is provided,
    generates a dynamic, age-specific and history-aware guide for that member.
    Otherwise, returns the cached generic test description."""
    conn = get_db()
    _require_member(conn, request, member_id)
    try:
        row = conn.execute("SELECT * FROM test_types WHERE id = ?", (tt_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")

        provider, model, key = _ai_config(conn)

        member_context = ""
        age_str = ""
        latest_str = ""
        related_str = ""
        
        if member_id is not None:
            # Check cache first
            if not force_refresh:
                cached_row = conn.execute(
                    "SELECT description, generated_at FROM member_descriptions WHERE member_id = ? AND test_type_id = ?",
                    (member_id, tt_id)
                ).fetchone()
                if cached_row:
                    import json
                    return {
                        "description": json.loads(cached_row["description"]),
                        "cached": True,
                        "generated_at": cached_row["generated_at"]
                    }

            member = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
            if member:
                age = _calculate_age(member["dob"])
                sex = member["sex"] or "Not specified"
                age_str = f"{age} years old" if age is not None else "Age not specified"
                
                # Fetch member's historical results for this biomarker
                history_rows = conn.execute(
                    """SELECT value, unit, value_canonical, value_text, flag, taken_at 
                       FROM results 
                       WHERE member_id = ? AND test_type_id = ? 
                       ORDER BY taken_at DESC""",
                    (member_id, tt_id)
                ).fetchall()
                
                history_list = []
                for hr in history_rows:
                    if hr["value_canonical"] is not None:
                        orig_val = f"{hr['value']} {hr['unit']}"
                        canon_val = f"{round(hr['value_canonical'], 3)} {row['canonical_unit'] or ''}"
                        flag_str = f" (Flagged: {hr['flag']})" if hr['flag'] else ""
                        history_list.append(f"- {hr['taken_at']}: {canon_val}{flag_str} (reported as {orig_val})")
                    else:
                        flag_str = f" (Flagged: {hr['flag']})" if hr['flag'] else ""
                        history_list.append(f"- {hr['taken_at']}: {hr['value_text'] or hr['value']}{flag_str}")
                
                history_str = "\n".join(history_list) if history_list else "No results on file"

                # Fetch other test types in the same category
                related_rows = conn.execute(
                    """SELECT id, name, canonical_unit 
                       FROM test_types 
                       WHERE category = ? AND id != ?""",
                    (row["category"], tt_id)
                ).fetchall()
                
                # Fetch historical readings for all related test types
                related_readings = []
                for rr in related_rows:
                    rel_history = conn.execute(
                        """SELECT value_canonical, value_text, flag, taken_at 
                           FROM results 
                           WHERE member_id = ? AND test_type_id = ? 
                           ORDER BY taken_at DESC""",
                        (member_id, rr["id"])
                    ).fetchall()
                    if rel_history:
                        h_lines = []
                        for rh in rel_history:
                            if rh['value_canonical'] is not None:
                                val_str = f"{round(rh['value_canonical'], 3)} {rr['canonical_unit'] or ''}"
                            else:
                                val_str = str(rh['value_text'] or rh['value'] or '')
                            flag_str = f" ({rh['flag']})" if rh['flag'] else ""
                            h_lines.append(f"  * {rh['taken_at']}: {val_str}{flag_str}")
                        related_readings.append(f"- {rr['name']}:\n" + "\n".join(h_lines))
                    else:
                        related_readings.append(f"- {rr['name']}: No readings on file")
                
                related_readings_str = "\n".join(related_readings) if related_readings else "none"

                # Deliberately no name: the provider needs age/sex to interpret a
                # value, but never who the person is. Keep identifiers local.
                member_context = (
                    f"Write this clinical reference guide specifically for the patient:\n"
                    f"Age: {age_str}, Sex: {sex}.\n\n"
                    f"Patient's Historical Results for {row['name']} (Main Test):\n{history_str}\n\n"
                    f"Patient's Historical Results for Related Tests in the same panel ({row['category']}):\n{related_readings_str}\n"
                )

        if member_id is not None and member_context:
            system_prompt = _get_setting(conn, "prompt_biomarker_personalized", ai.BIOMARKER_PERSONALIZED_SYSTEM)
            prompt = (
                f"{member_context}\n"
                f"Biomarker: {row['name']}" + (f" (measured in {row['canonical_unit']})" if row['canonical_unit'] else "") + ".\n"
                f"Reference range limits: low {row['ref_low'] or 'n/a'}, high {row['ref_high'] or 'n/a'}.\n\n"
                f"Please write a guide that addresses the following:\n"
                f"1. **description**: Explain the biomarker clearly, what the reference ranges mean, and why it matters.\n"
                f"2. **high**: Ramifications of a high level.\n"
                f"3. **low**: Ramifications of a low level.\n"
                f"4. **age_related**: Note any relevant observations or normal shifts for a {age_str} patient.\n"
                f"5. **related_tests**: Summarize and interpret the patient's historical trends for this biomarker, noting any changes over time. Interpret how these trends track and integrate with the historical results for the related tests in the same panel (listed below). Explain what the combined clinical picture and trajectory means in plain language:\n{related_readings_str}"
            )

            try:
                import json
                text = ai.chat(provider, model, key, system_prompt, prompt).strip()
                parsed = ai._extract_json(text)
            except Exception as e:
                parsed = {
                    "description": text,
                    "high": "Clinical review suggested.",
                    "low": "Clinical review suggested.",
                    "age_related": "Refer to guidelines.",
                    "related_tests": "See related tests tab."
                }
            
            # Save cache
            conn.execute(
                """INSERT INTO member_descriptions (member_id, test_type_id, description, generated_at)
                   VALUES (?, ?, ?, datetime('now'))
                   ON CONFLICT(member_id, test_type_id) DO UPDATE SET description = excluded.description, generated_at = excluded.generated_at""",
                (member_id, tt_id, json.dumps(parsed))
            )
            conn.commit()

            # Retrieve generated_at
            gen_time = conn.execute(
                "SELECT generated_at FROM member_descriptions WHERE member_id = ? AND test_type_id = ?",
                (member_id, tt_id)
            ).fetchone()["generated_at"]

            return {"description": parsed, "cached": False, "generated_at": gen_time}

        else:
            if row["description"]:
                import json
                try:
                    parsed = json.loads(row["description"])
                    return {"description": parsed, "cached": True}
                except ValueError:
                    return {"description": {
                        "description": row["description"],
                        "high": "Refer to doctor.",
                        "low": "Refer to doctor.",
                        "age_related": "Standard limits apply.",
                        "related_tests": "See related tests."
                    }, "cached": True}
            
            system_prompt = _get_setting(conn, "prompt_biomarker_standard", ai.BIOMARKER_STANDARD_SYSTEM)
            prompt = f"Biomarker: {row['name']}" + (f" (measured in {row['canonical_unit']})" if row["canonical_unit"] else "") + "."
            try:
                import json
                text = ai.chat(provider, model, key, system_prompt, prompt).strip()
                parsed = ai._extract_json(text)
            except Exception as e:
                parsed = {
                    "description": text,
                    "high": "Clinical review suggested.",
                    "low": "Clinical review suggested.",
                    "age_related": "Refer to guidelines.",
                    "related_tests": "See related tests."
                }
            conn.execute("UPDATE test_types SET description = ? WHERE id = ?", (json.dumps(parsed), tt_id))
            conn.commit()
            return {"description": parsed, "cached": False}
    finally:
        conn.close()




def sanitize_name(text: str) -> str:
    # replace non-alphanumeric with underscores, stripping duplicate underscores
    clean = re.sub(r'[^a-zA-Z0-9]', '_', text)
    clean = re.sub(r'_+', '_', clean)
    return clean.strip('_')


def match_patient_name(member_name: str, patient_name: str) -> bool:
    if not patient_name or not patient_name.strip():
        # If the report has no patient name, allow it (best effort)
        return True
    m_tokens = set(re.findall(r'[a-zA-Z0-9]+', member_name.lower()))
    p_tokens = set(re.findall(r'[a-zA-Z0-9]+', patient_name.lower()))
    intersect = m_tokens.intersection(p_tokens)
    return len(intersect) > 0


# ---------------- documents / upload / extract ----------------

@app.post("/api/documents")
async def upload_document(
    request: Request,
    file: UploadFile = File(...),
    member_id: Optional[int] = Form(None),
):
    _guard = get_db()
    try:
        _require_member(_guard, request, member_id)
    finally:
        _guard.close()
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    
    import hashlib
    file_hash = hashlib.sha256(data).hexdigest()
    
    # Check for duplicate file hash
    _check_conn = get_db()
    try:
        existing = _check_conn.execute("SELECT id, filename FROM documents WHERE file_hash = ?", (file_hash,)).fetchone()
        if existing:
            if not request.query_params.get("force") == "true":
                raise HTTPException(
                    status_code=409,
                    detail=f"This file has already been uploaded as document #{existing['id']} ('{existing['filename']}')."
                )
    finally:
        _check_conn.close()

    mime = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    ext = Path(file.filename or "").suffix or mimetypes.guess_extension(mime) or ""
    
    conn = get_db()
    try:
        member = None
        if member_id:
            member = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
            if not member:
                raise HTTPException(404, "Member not found")
        
        # 1. AI Extraction
        sanitized_person_name = sanitize_name(member["name"]) if member else "unassigned"
        member_dir = FILES_DIR / sanitized_person_name
        member_dir.mkdir(parents=True, exist_ok=True)

        provider, model, key = _ai_config(conn)
        extraction_sys = _get_setting(conn, "prompt_extraction_system", ai.EXTRACTION_SYSTEM)
        try:
            parsed = ai.extract(provider, model, key, data, mime, system_prompt=extraction_sys)
        except Exception as e:
            error_msg = f"AI extraction failed: {str(e)}"
            temp_filename = f"{sanitized_person_name}_Failed_{uuid.uuid4().hex[:8]}{ext}"
            (member_dir / temp_filename).write_bytes(data)
            stored_name = f"{sanitized_person_name}/{temp_filename}"

            conn.execute(
                """INSERT INTO documents (member_id, filename, stored_name, mime, size, status, extraction, file_hash)
                   VALUES (?, ?, ?, ?, ?, 'failed', ?, ?)""",
                (member_id, file.filename, stored_name, mime, len(data), json.dumps({"error": error_msg}), file_hash),
            )
            conn.commit()
            raise HTTPException(400, error_msg)

        patient_name = parsed.get("patient_name")
        report_date = parsed.get("report_date")
        lab_name = parsed.get("lab_name")

        # 2. Check if selected name matches the report
        if member:
            if not match_patient_name(member["name"], patient_name):
                error_msg = f"Patient name mismatch: Report belongs to '{patient_name or 'Unknown'}', but you selected '{member['name']}'."
                temp_filename = f"{sanitized_person_name}_Failed_{uuid.uuid4().hex[:8]}{ext}"
                (member_dir / temp_filename).write_bytes(data)
                stored_name = f"{sanitized_person_name}/{temp_filename}"

                conn.execute(
                    """INSERT INTO documents (member_id, filename, stored_name, mime, size, status, extraction, file_hash)
                       VALUES (?, ?, ?, ?, ?, 'failed', ?, ?)""",
                    (member_id, file.filename, stored_name, mime, len(data), json.dumps({"error": error_msg}), file_hash),
                )
                conn.commit()
                raise HTTPException(400, error_msg)

        # 3. Organize in folders and rename appropriately with month/year and collision handling
        
        # Extract month and year
        test_month = "UnknownMonth"
        test_year = "UnknownYear"
        if report_date:
            try:
                dt = date.fromisoformat(report_date)
                test_month = dt.strftime("%B")
                test_year = str(dt.year)
            except Exception:
                m = re.match(r'(\d{4})[-/](\d{2})[-/](\d{2})', report_date)
                if m:
                    year_val, month_val = int(m.group(1)), int(m.group(2))
                    try:
                        dt = date(year_val, month_val, 1)
                        test_month = dt.strftime("%B")
                        test_year = str(dt.year)
                    except Exception:
                        pass
        
        # Create member folder
        member_dir = FILES_DIR / sanitized_person_name
        member_dir.mkdir(parents=True, exist_ok=True)
        
        # Collision handling
        base_filename = f"{sanitized_person_name}_{test_month}_{test_year}"
        counter = 0
        final_filename = f"{base_filename}{ext}"
        while (member_dir / final_filename).exists():
            counter += 1
            final_filename = f"{base_filename}_{counter}{ext}"
            
        # Write file to the folder
        (member_dir / final_filename).write_bytes(data)
        
        # Save relative stored name path
        stored_name = f"{sanitized_person_name}/{final_filename}"
        
        # 4. Construct extraction response structure (pre-match test types)
        types = _test_types(conn)
        items = []
        for r in parsed.get("results", []):
            name = r.get("test_name")
            value, parsed_qual = parse_value(r.get("value"))
            qualifier = r.get("qualifier") or parsed_qual
            if qualifier not in ("<", ">"):
                qualifier = None
            unit = (r.get("unit") or "").strip()
            value_text = (r.get("value_text") or "").strip() or None
            is_qual = value is None and value_text is not None
            if (value is None and value_text is None) or not name or not str(name).strip():
                continue
            ref_low = to_number(r.get("ref_low"))
            ref_high = to_number(r.get("ref_high"))
            tt = match_test_type(name, types)
            canonical = None
            if tt and not is_qual:
                canonical = to_canonical(value, unit, tt["canonical_unit"], tt["conversions"])
            match_ok = tt is not None and (is_qual or canonical is not None)
            items.append(
                {
                    "test_name": name,
                    "value": value,
                    "value_text": value_text,
                    "qualifier": qualifier,
                    "unit": unit,
                    "ref_low": ref_low,
                    "ref_high": ref_high,
                    "flag": r.get("flag"),
                    "matched_test_type_id": tt["id"] if match_ok else None,
                    "matched_name": tt["name"] if match_ok else None,
                    "canonical_unit": tt["canonical_unit"] if match_ok else None,
                    "value_canonical": canonical if match_ok else None,
                    "unit_known": match_ok,
                }
            )
            
        extraction_res = {
            "document_id": None,
            "report_date": report_date,
            "lab_name": lab_name,
            "patient_name": patient_name,
            "provider": provider,
            "model": model,
            "items": items,
        }
        
        # Insert into documents table
        cur = conn.execute(
            """INSERT INTO documents (member_id, filename, stored_name, mime, size, report_date, lab_name, status, extraction, file_hash)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'needs_review', ?, ?)""",
            (member_id, final_filename, stored_name, mime, len(data), report_date, lab_name, json.dumps(extraction_res), file_hash),
        )
        doc_id = cur.lastrowid
        
        # Populate document_items table
        for r in parsed.get("results", []):
            name = r.get("test_name")
            value, parsed_qual = parse_value(r.get("value"))
            qualifier = r.get("qualifier") or parsed_qual
            if qualifier not in ("<", ">"):
                qualifier = None
            unit = (r.get("unit") or "").strip()
            value_text = (r.get("value_text") or "").strip() or None
            if (value is None and value_text is None) or not name or not str(name).strip():
                continue
            ref_low = to_number(r.get("ref_low"))
            ref_high = to_number(r.get("ref_high"))
            page_num = r.get("page_number")
            try:
                page_num = int(float(page_num)) if page_num is not None else 1
            except ValueError:
                page_num = 1
                
            tt = match_test_type(name, types)
            canonical = None
            if tt and value is not None:
                canonical = to_canonical(value, unit, tt["canonical_unit"], tt["conversions"])
            match_ok = tt is not None and (value is None or canonical is not None)
            
            conn.execute(
                """INSERT INTO document_items (
                    document_id, raw_name, raw_value, raw_value_text, raw_unit, raw_qualifier, raw_flag,
                    raw_ref_low, raw_ref_high, page_number, test_type_id, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_review')""",
                (
                    doc_id, name, value, value_text, unit, qualifier, r.get("flag"),
                    ref_low, ref_high, page_num, tt["id"] if match_ok else None
                )
            )
            
        # Update extraction payload with real document ID
        extraction_res["document_id"] = doc_id
        conn.execute("UPDATE documents SET extraction = ? WHERE id = ?", (json.dumps(extraction_res), doc_id))
        conn.commit()
        
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@app.get("/api/documents")
def list_documents(
    request: Request,
    limit: Optional[int] = None,
    offset: int = 0,
    member_id: Optional[str] = None,
    status_group: Optional[str] = None,
    search: Optional[str] = None,
):
    conn = get_db()
    try:
        vis = _visible(conn, request)
        vis_list = list(vis)
        
        # If vis_list is empty, we must ensure we handle it safely to avoid SQL syntax error
        if not vis_list:
            placeholders = "-1"
            params = []
        else:
            placeholders = ",".join("?" for _ in vis_list)
            params = list(vis_list)
            
        query = """
            SELECT d.*, m.name AS member_name,
                   (SELECT COUNT(*) FROM results r WHERE r.document_id = d.id) AS result_count
            FROM documents d
            LEFT JOIN members m ON m.id = d.member_id
            WHERE (d.member_id IS NULL OR d.member_id IN ({}))
        """.format(placeholders)
        
        if member_id:
            if member_id == "unassigned":
                query += " AND d.member_id IS NULL"
            else:
                try:
                    query += " AND d.member_id = ?"
                    params.append(int(member_id))
                except ValueError:
                    pass
                    
        if status_group:
            if status_group == "needs_attention":
                query += " AND d.status IN ('needs_review', 'partially_imported', 'failed')"
            elif status_group == "done":
                query += " AND d.status IN ('fully_imported', 'reviewed')"
                
        if search:
            search_str = search.strip()
            if search_str:
                query += " AND (d.filename LIKE ? OR d.lab_name LIKE ?)"
                params.append(f"%{search_str}%")
                params.append(f"%{search_str}%")
                
        query += " ORDER BY COALESCE(d.report_date, d.created_at) DESC, d.id DESC"
        
        if limit is not None:
            query += " LIMIT ? OFFSET ?"
            params.append(limit)
            params.append(offset)
            
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


class ReassignReq(BaseModel):
    member_id: int


@app.post("/api/documents/{doc_id}/reassign")
def reassign_document(doc_id: int, req: ReassignReq, request: Request):
    """Move a document and every result it produced to a different member —
    fixes an import uploaded under the wrong person, without losing the data."""
    conn = get_db()
    try:
        _require_doc(conn, request, doc_id)
        _require_member(conn, request, req.member_id)
        if not conn.execute("SELECT 1 FROM documents WHERE id = ?", (doc_id,)).fetchone():
            raise HTTPException(404, "Document not found")
        if not conn.execute("SELECT 1 FROM members WHERE id = ?", (req.member_id,)).fetchone():
            raise HTTPException(404, "Member not found")
        moved = conn.execute(
            "UPDATE results SET member_id = ? WHERE document_id = ?", (req.member_id, doc_id)
        ).rowcount
        conn.execute("UPDATE documents SET member_id = ? WHERE id = ?", (req.member_id, doc_id))
        conn.commit()
        return {"ok": True, "moved": moved}
    finally:
        conn.close()


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: int, request: Request):
    """Delete an entire import: the document, its stored file, and every result
    that was saved from it. Manually-entered results (no document) are untouched."""
    conn = get_db()
    try:
        _require_doc(conn, request, doc_id)
        doc = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if not doc:
            raise HTTPException(404, "Document not found")
        deleted = conn.execute("DELETE FROM results WHERE document_id = ?", (doc_id,)).rowcount
        conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        conn.commit()
        # Remove the stored file too (best-effort; DB state is the source of truth).
        try:
            path = FILES_DIR / doc["stored_name"]
            if path.exists():
                path.unlink()
        except OSError:
            pass
        return {"ok": True, "deleted_results": deleted}
    finally:
        conn.close()


@app.get("/api/documents/{doc_id}/file")
def get_document_file(doc_id: int, request: Request):
    conn = get_db()
    try:
        _require_doc(conn, request, doc_id)
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        path = FILES_DIR / row["stored_name"]
        if not path.exists():
            raise HTTPException(404, "File missing")
        return FileResponse(path, media_type=row["mime"], filename=row["filename"])
    finally:
        conn.close()


class ExtractReq(BaseModel):
    provider: Optional[str] = None
    model: Optional[str] = None


@app.post("/api/documents/{doc_id}/extract")
def extract_document(doc_id: int, req: ExtractReq, request: Request):
    conn = get_db()
    try:
        _require_doc(conn, request, doc_id)
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")

        if row["extraction"]:
            # If already extracted during upload, return the cached extraction response
            return json.loads(row["extraction"])

        # Fallback for legacy documents uploaded before this update
        data = (FILES_DIR / row["stored_name"]).read_bytes()
        provider, model, key = _ai_config(conn, req.provider, req.model)
        extraction_sys = _get_setting(conn, "prompt_extraction_system", ai.EXTRACTION_SYSTEM)
        try:
            parsed = ai.extract(provider, model, key, data, row["mime"], system_prompt=extraction_sys)
        except ai.AIError as e:
            raise HTTPException(400, str(e))

        types = _test_types(conn)
        items = []
        for r in parsed.get("results", []):
            name = r.get("test_name")
            value, parsed_qual = parse_value(r.get("value"))
            qualifier = r.get("qualifier") or parsed_qual
            if qualifier not in ("<", ">"):
                qualifier = None
            unit = (r.get("unit") or "").strip()
            value_text = (r.get("value_text") or "").strip() or None
            is_qual = value is None and value_text is not None
            if (value is None and value_text is None) or not name or not str(name).strip():
                continue
            ref_low = to_number(r.get("ref_low"))
            ref_high = to_number(r.get("ref_high"))
            tt = match_test_type(name, types)
            canonical = None
            if tt and not is_qual:
                canonical = to_canonical(value, unit, tt["canonical_unit"], tt["conversions"])
            match_ok = tt is not None and (is_qual or canonical is not None)
            items.append(
                {
                    "test_name": name,
                    "value": value,
                    "value_text": value_text,
                    "qualifier": qualifier,
                    "unit": unit,
                    "ref_low": ref_low,
                    "ref_high": ref_high,
                    "flag": r.get("flag"),
                    "matched_test_type_id": tt["id"] if match_ok else None,
                    "matched_name": tt["name"] if match_ok else None,
                    "canonical_unit": tt["canonical_unit"] if match_ok else None,
                    "value_canonical": canonical if match_ok else None,
                    "unit_known": match_ok,
                }
            )

        report_date = parsed.get("report_date")
        response = {
            "document_id": doc_id,
            "report_date": report_date,
            "lab_name": parsed.get("lab_name"),
            "patient_name": parsed.get("patient_name"),
            "provider": provider,
            "model": model,
            "items": items,
        }
        
        # Clear existing items and update documents status
        conn.execute("DELETE FROM document_items WHERE document_id = ?", (doc_id,))
        
        # Populate document_items table
        for r in parsed.get("results", []):
            name = r.get("test_name")
            value, parsed_qual = parse_value(r.get("value"))
            qualifier = r.get("qualifier") or parsed_qual
            if qualifier not in ("<", ">"):
                qualifier = None
            unit = (r.get("unit") or "").strip()
            value_text = (r.get("value_text") or "").strip() or None
            if (value is None and value_text is None) or not name or not str(name).strip():
                continue
            ref_low = to_number(r.get("ref_low"))
            ref_high = to_number(r.get("ref_high"))
            page_num = r.get("page_number")
            try:
                page_num = int(float(page_num)) if page_num is not None else 1
            except ValueError:
                page_num = 1
                
            tt = match_test_type(name, types)
            canonical = None
            if tt and value is not None:
                canonical = to_canonical(value, unit, tt["canonical_unit"], tt["conversions"])
            match_ok = tt is not None and (value is None or canonical is not None)
            
            conn.execute(
                """INSERT INTO document_items (
                    document_id, raw_name, raw_value, raw_value_text, raw_unit, raw_qualifier, raw_flag,
                    raw_ref_low, raw_ref_high, page_number, test_type_id, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_review')""",
                (
                    doc_id, name, value, value_text, unit, qualifier, r.get("flag"),
                    ref_low, ref_high, page_num, tt["id"] if match_ok else None
                )
            )

        conn.execute(
            """UPDATE documents SET status = 'needs_review',
                   report_date = COALESCE(?, report_date),
                   lab_name = COALESCE(?, lab_name),
                   extraction = ? WHERE id = ?""",
            (report_date, parsed.get("lab_name"), json.dumps(response), doc_id),
        )
        conn.commit()
        return response
    finally:
        conn.close()


@app.get("/api/documents/{doc_id}/extraction")
def get_extraction(doc_id: int, request: Request):
    """Return the saved extraction payload for a document so its review can be
    resumed without re-running the AI. 404 if the document was never extracted."""
    conn = get_db()
    try:
        _require_doc(conn, request, doc_id)
        doc = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if not doc:
            raise HTTPException(404, "Not found")
            
        items = conn.execute("SELECT * FROM document_items WHERE document_id = ?", (doc_id,)).fetchall()
        
        # Build items payload
        types = {t["id"]: t for t in _test_types(conn)}
        item_list = []
        for it in items:
            tt = types.get(it["test_type_id"]) if it["test_type_id"] else None
            canonical = None
            if tt and it["raw_value"] is not None:
                canonical = to_canonical(it["raw_value"], it["raw_unit"], tt["canonical_unit"], tt["conversions"])
            match_ok = tt is not None and (it["raw_value"] is None or canonical is not None)
            
            item_list.append({
                "id": it["id"],
                "test_name": it["raw_name"],
                "value": it["raw_value"],
                "value_text": it["raw_value_text"],
                "qualifier": it["raw_qualifier"],
                "unit": it["raw_unit"],
                "ref_low": it["raw_ref_low"],
                "ref_high": it["raw_ref_high"],
                "flag": it["raw_flag"],
                "page_number": it["page_number"],
                "matched_test_type_id": it["test_type_id"] if match_ok else None,
                "matched_name": tt["name"] if match_ok else None,
                "canonical_unit": tt["canonical_unit"] if match_ok else None,
                "value_canonical": canonical if match_ok else None,
                "unit_known": match_ok,
                "status": it["status"],
                "error_reason": it["error_reason"],
                "result_id": it["result_id"]
            })
            
        # Try to parse provider, model, and error from extraction fallback
        provider = None
        model = None
        error = None
        if doc["extraction"]:
            try:
                ext_payload = json.loads(doc["extraction"])
                provider = ext_payload.get("provider")
                model = ext_payload.get("model")
                error = ext_payload.get("error")
            except Exception:
                pass
                
        return {
            "document_id": doc_id,
            "report_date": doc["report_date"],
            "lab_name": doc["lab_name"],
            "patient_name": doc.get("patient_name") or (json.loads(doc["extraction"]).get("patient_name") if doc["extraction"] else None),
            "status": doc["status"],
            "provider": provider,
            "model": model,
            "items": item_list,
            "error": error
        }
    finally:
        conn.close()


# ---------------- commit results ----------------

class CommitItem(BaseModel):
    test_type_id: int
    value: Optional[float] = None       # None for a qualitative result
    value_text: Optional[str] = None    # "Negative", "B+" — set instead of value
    unit: str = ""
    qualifier: Optional[str] = None     # '<' or '>' for a non-detect / limit result
    flag: Optional[str] = None          # only honoured for qualitative rows
    ref_low: Optional[float] = None
    ref_high: Optional[float] = None
    note: Optional[str] = None
    document_item_id: Optional[int] = None


class CommitReq(BaseModel):
    member_id: int
    taken_at: str
    document_id: Optional[int] = None
    # Set true to save even when a result with the same date + value already
    # exists for this member and test (the "save anyway" override).
    force: bool = False
    ignore_duplicates: bool = False
    items: list[CommitItem]


def _same_value(a: Optional[float], b: Optional[float]) -> bool:
    """Two canonical values count as the same reading if they're equal within a
    tiny relative tolerance (guards against float round-trips)."""
    if a is None or b is None:
        return a is b
    return abs(a - b) <= 1e-6 * max(1.0, abs(a), abs(b))


@app.post("/api/results/commit")
def commit_results(req: CommitReq, request: Request):
    conn = get_db()
    try:
        _require_member(conn, request, req.member_id)
        types = {t["id"]: t for t in _test_types(conn)}
        member = conn.execute("SELECT * FROM members WHERE id = ?", (req.member_id,)).fetchone()
        m_sex = member["sex"] if member else None
        # Age at the draw date, not today — a range should reflect who they were
        # when the blood was taken.
        m_age = age_at(member["dob"], req.taken_at) if member else None
        skipped = []
        duplicates = []
        prepared = []  # rows that pass validation, ready to insert
        
        # Track items skipped in this commit pass
        skipped_item_ids = {} # item_id -> reason
        
        for it in req.items:
            tt = types.get(it.test_type_id)
            if not tt:
                skipped.append({"reason": "unknown test type"})
                if it.document_item_id:
                    skipped_item_ids[it.document_item_id] = "unknown test type"
                continue

            # Qualitative result: store the text as reported. There's no unit to
            # convert and no range to compare against, so the lab's own flag is
            # the only abnormality signal we have.
            text = (it.value_text or "").strip()
            if it.value is None and text:
                q_flag = it.flag if it.flag in ("H", "L") else None
                existing = conn.execute(
                    "SELECT value_text FROM results WHERE member_id = ? AND test_type_id = ? AND taken_at = ?",
                    (req.member_id, it.test_type_id, req.taken_at),
                ).fetchall()
                is_dup = any((e["value_text"] or "").strip().lower() == text.lower() for e in existing)
                if is_dup:
                    duplicates.append({"name": tt["name"], "date": req.taken_at, "value": text, "unit": ""})
                    if req.ignore_duplicates:
                        continue
                prepared.append((it, None, None, None, q_flag, None, text))
                continue
            if it.value is None:
                skipped.append({"name": tt["name"], "reason": "no value reported"})
                if it.document_item_id:
                    skipped_item_ids[it.document_item_id] = "no value reported"
                continue

            canonical = to_canonical(it.value, it.unit, tt["canonical_unit"], tt["conversions"])
            if canonical is None:
                # One incompatible unit must not sink the whole report — skip this
                # row, save the rest, and tell the caller what didn't go in.
                if not (it.unit or "").strip():
                    reason = f"no unit reported (expected {tt['canonical_unit']}) — set the unit in review"
                else:
                    reason = f"unit '{it.unit}' can't convert to {tt['canonical_unit'] or 'its unit'}"
                skipped.append({"name": tt["name"], "unit": it.unit, "reason": reason})
                if it.document_item_id:
                    skipped_item_ids[it.document_item_id] = reason
                continue
            rlow_c = to_canonical(it.ref_low, it.unit, tt["canonical_unit"], tt["conversions"]) if it.ref_low is not None else None
            rhigh_c = to_canonical(it.ref_high, it.unit, tt["canonical_unit"], tt["conversions"]) if it.ref_high is not None else None
            # Never blend sources: if the report printed either bound, that range
            # stands on its own (a missing side means unbounded). Only a report
            # with no range at all falls back to the catalog, resolved for this
            # member's sex and age.
            if rlow_c is not None or rhigh_c is not None:
                eff_low, eff_high = rlow_c, rhigh_c
            else:
                eff_low, eff_high = resolve_range(tt["slug"], tt["ref_low"], tt["ref_high"], m_sex, m_age)
            qualifier = it.qualifier if it.qualifier in ("<", ">") else None
            flag = compute_flag(canonical, eff_low, eff_high, qualifier)

            # A duplicate is the same member + test + date carrying the same
            # (canonical) value — i.e. re-importing a report already on file.
            existing = conn.execute(
                "SELECT value_canonical FROM results WHERE member_id = ? AND test_type_id = ? AND taken_at = ?",
                (req.member_id, it.test_type_id, req.taken_at),
            ).fetchall()
            is_dup = any(_same_value(e["value_canonical"], canonical) for e in existing)
            if is_dup:
                duplicates.append({
                    "name": tt["name"], "date": req.taken_at,
                    "value": it.value, "unit": it.unit,
                })
                if req.ignore_duplicates:
                    continue

            prepared.append((it, canonical, rlow_c, rhigh_c, flag, qualifier, None))

        # Block on duplicates unless the caller explicitly forces the save or ignores duplicates. Nothing
        # is written in this case, so the client can safely retry with force=true or ignore_duplicates=true.
        if duplicates and not req.force and not req.ignore_duplicates:
            return {"created": 0, "skipped": skipped, "duplicates": duplicates,
                    "needs_confirmation": True}

        created = 0
        for it, canonical, rlow_c, rhigh_c, flag, qualifier, text in prepared:
            cur = conn.execute(
                """INSERT INTO results
                   (member_id, test_type_id, document_id, taken_at, value, unit, value_canonical,
                    value_text, ref_low, ref_high, ref_low_canonical, ref_high_canonical,
                    flag, qualifier, note)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    req.member_id, it.test_type_id, req.document_id, req.taken_at,
                    it.value, it.unit, canonical, text, it.ref_low, it.ref_high,
                    rlow_c, rhigh_c, flag, qualifier, it.note,
                ),
            )
            result_id = cur.lastrowid
            created += 1
            
            # If from a document_items, update its status
            if it.document_item_id:
                conn.execute(
                    "UPDATE document_items SET status = 'imported', result_id = ? WHERE id = ?",
                    (result_id, it.document_item_id)
                )

        if req.document_id:
            # Update skipped items
            for item_id, reason in skipped_item_ids.items():
                conn.execute(
                    "UPDATE document_items SET status = 'skipped', error_reason = ? WHERE id = ?",
                    (reason, item_id)
                )
                
            # If the user didn't submit some of the document items, mark them as skipped/not selected
            conn.execute(
                """UPDATE document_items SET status = 'skipped', error_reason = 'Not selected for import'
                   WHERE document_id = ? AND status = 'needs_review'""",
                (req.document_id,)
            )
            
            conn.execute(
                "UPDATE documents SET member_id = COALESCE(member_id, ?) WHERE id = ?",
                (req.member_id, req.document_id),
            )
            recompute_doc_status(conn, req.document_id)

        conn.commit()
        return {"created": created, "skipped": skipped, "duplicates": duplicates}
    finally:
        conn.close()


class ItemImportReq(BaseModel):
    member_id: int
    taken_at: str
    item: CommitItem


@app.post("/api/documents/{doc_id}/items/{item_id}/import")
def import_document_item(doc_id: int, item_id: int, req: ItemImportReq, request: Request):
    conn = get_db()
    try:
        # Guard both ends: the destination member AND the source document. Without
        # the second check a locked device could touch a private member's
        # extracted rows if it ever learned the id.
        _require_member(conn, request, req.member_id)
        _require_doc(conn, request, doc_id)

        # Verify document and item exist
        doc = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if not doc:
            raise HTTPException(404, "Document not found")
        item_row = conn.execute("SELECT * FROM document_items WHERE id = ? AND document_id = ?", (item_id, doc_id)).fetchone()
        if not item_row:
            raise HTTPException(404, "Document item not found")
            
        types = {t["id"]: t for t in _test_types(conn)}
        tt = types.get(req.item.test_type_id)
        if not tt:
            raise HTTPException(400, "Unknown test type")
            
        member = conn.execute("SELECT * FROM members WHERE id = ?", (req.member_id,)).fetchone()
        m_sex = member["sex"] if member else None
        m_age = age_at(member["dob"], req.taken_at) if member else None
        
        # Validation
        text = (req.item.value_text or "").strip()
        if req.item.value is None and text:
            q_flag = req.item.flag if req.item.flag in ("H", "L") else None
            canonical = None
            rlow_c, rhigh_c = None, None
            flag = q_flag
            qualifier = None
        else:
            if req.item.value is None:
                raise HTTPException(400, "No value reported")
                
            canonical = to_canonical(req.item.value, req.item.unit, tt["canonical_unit"], tt["conversions"])
            if canonical is None:
                if not (req.item.unit or "").strip():
                    reason = f"No unit reported (expected {tt['canonical_unit']})"
                else:
                    reason = f"Unit '{req.item.unit}' cannot convert to {tt['canonical_unit']}"
                raise HTTPException(400, reason)
                
            rlow_c = to_canonical(req.item.ref_low, req.item.unit, tt["canonical_unit"], tt["conversions"]) if req.item.ref_low is not None else None
            rhigh_c = to_canonical(req.item.ref_high, req.item.unit, tt["canonical_unit"], tt["conversions"]) if req.item.ref_high is not None else None
            
            if rlow_c is not None or rhigh_c is not None:
                eff_low, eff_high = rlow_c, rhigh_c
            else:
                eff_low, eff_high = resolve_range(tt["slug"], tt["ref_low"], tt["ref_high"], m_sex, m_age)
                
            qualifier = req.item.qualifier if req.item.qualifier in ("<", ">") else None
            flag = compute_flag(canonical, eff_low, eff_high, qualifier)
            
        # Insert result
        cur = conn.execute(
            """INSERT INTO results
               (member_id, test_type_id, document_id, taken_at, value, unit, value_canonical,
                value_text, ref_low, ref_high, ref_low_canonical, ref_high_canonical,
                flag, qualifier, note)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                req.member_id, req.item.test_type_id, doc_id, req.taken_at,
                req.item.value, req.item.unit, canonical, text if text else None,
                req.item.ref_low, req.item.ref_high, rlow_c, rhigh_c, flag, qualifier, req.item.note,
            ),
        )
        result_id = cur.lastrowid
        
        # Update document_item
        conn.execute(
            """UPDATE document_items 
               SET status = 'imported', result_id = ?, test_type_id = ?
               WHERE id = ?""",
            (result_id, req.item.test_type_id, item_id)
        )
        
        conn.execute(
            "UPDATE documents SET member_id = COALESCE(member_id, ?) WHERE id = ?",
            (req.member_id, doc_id),
        )
        new_status = recompute_doc_status(conn, doc_id)

        conn.commit()
        return {"ok": True, "result_id": result_id, "document_status": new_status}
    finally:
        conn.close()


# ---------------- reading results / trends ----------------

@app.get("/api/results")
def get_results(request: Request, member_id: Optional[int] = None, test_type_id: Optional[int] = None):
    conn = get_db()
    try:
        _require_member(conn, request, member_id)
        q = """SELECT r.*, t.name AS test_name, t.slug AS test_slug, t.canonical_unit,
                      t.category, t.ref_low AS cat_ref_low, t.ref_high AS cat_ref_high,
                      m.name AS member_name, m.sex AS member_sex, m.dob AS member_dob
               FROM results r
               JOIN test_types t ON t.id = r.test_type_id
               JOIN members m ON m.id = r.member_id
               WHERE 1=1"""
        params = []
        # Unfiltered queries must never spill a private member's rows.
        vis = _visible(conn, request)
        if vis:
            q += f" AND r.member_id IN ({','.join('?' * len(vis))})"
            params.extend(sorted(vis))
        else:
            return []
        if member_id is not None:
            q += " AND r.member_id = ?"
            params.append(member_id)
        if test_type_id is not None:
            q += " AND r.test_type_id = ?"
            params.append(test_type_id)
        q += " ORDER BY r.taken_at"
        rows = conn.execute(q, params).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            # Same reconciliation as the summary, per result: the report's own
            # range wins whole; otherwise the catalog range for this member's sex
            # and age *at that draw*. Never a blend of the two.
            if d["ref_low_canonical"] is not None or d["ref_high_canonical"] is not None:
                d["eff_ref_low"], d["eff_ref_high"] = d["ref_low_canonical"], d["ref_high_canonical"]
                d["ref_source"] = "report"
            else:
                d["eff_ref_low"], d["eff_ref_high"] = resolve_range(
                    d["test_slug"], d["cat_ref_low"], d["cat_ref_high"],
                    d["member_sex"], age_at(d["member_dob"], d["taken_at"]),
                )
                d["ref_source"] = "catalog"
            out.append(d)
        return out
    finally:
        conn.close()


def _summary_for(conn, member_id: int) -> list:
    """One row per test type the member has data for, with latest value + count."""
    rows = conn.execute(
            """SELECT t.id AS test_type_id, t.name, t.slug, t.category, t.canonical_unit,
                      t.ref_low, t.ref_high, t.zones, COUNT(*) AS n,
                      MAX(r.taken_at) AS latest_at,
                      SUM(CASE WHEN r.flag IS NOT NULL THEN 1 ELSE 0 END) AS flagged
               FROM results r JOIN test_types t ON t.id = r.test_type_id
               WHERE r.member_id = ?
               GROUP BY t.id ORDER BY t.category, t.name""",
        (member_id,),
    ).fetchall()
    # Pull every point in one query so the client needs no per-row fetch for
    # the inline sparkline (a member can have 100+ test types).
    pts = conn.execute(
        """SELECT test_type_id, value_canonical, value_text, flag, qualifier, taken_at, value, unit,
                  ref_low_canonical, ref_high_canonical
           FROM results WHERE member_id = ? ORDER BY test_type_id, taken_at""",
        (member_id,),
    ).fetchall()
    series = {}
    for p in pts:
        series.setdefault(p["test_type_id"], []).append(dict(p))

    member = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
    m_sex = member["sex"] if member else None
    out = []
    for r in rows:
        s = series.get(r["test_type_id"], [])
        d = row_to_dict(r)
        d["flagged"] = int(r["flagged"] or 0)
        latest = s[-1] if s else None
        d["latest"] = latest
        # Qualitative points have no number — keep them out of the sparkline.
        d["spark"] = [p["value_canonical"] for p in s if p["value_canonical"] is not None]
        # Resolve ONE authoritative range per marker so the client never has to
        # (and never gets to) blend the report's range with the catalog's.
        m_age = age_at(member["dob"], latest["taken_at"]) if member and latest else None
        lo = latest["ref_low_canonical"] if latest else None
        hi = latest["ref_high_canonical"] if latest else None
        if lo is not None or hi is not None:
            d["ref_low"], d["ref_high"] = lo, hi
            d["ref_source"] = "report"
        else:
            d["ref_low"], d["ref_high"] = resolve_range(r["slug"], r["ref_low"], r["ref_high"], m_sex, m_age)
            d["ref_source"] = "catalog"
        out.append(d)
    return out


@app.get("/api/members/{member_id}/summary")
def member_summary(member_id: int, request: Request):
    conn = get_db()
    try:
        _require_member(conn, request, member_id)
        return _summary_for(conn, member_id)
    finally:
        conn.close()


# ---------------- whole-member AI health analysis ----------------

def _analysis_inputs(conn, member_id: int):
    """Build the full-history prompt body and a hash of the underlying data.

    The hash lets the client tell when a cached analysis has gone stale because
    new results arrived. No member name is included — the model gets age and sex
    only, per the privacy rule.
    """
    member = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
    summary = _summary_for(conn, member_id)
    # Every raw result, so the model sees the real trend, not just the latest.
    rows = conn.execute(
        """SELECT r.test_type_id, r.taken_at, r.value_canonical, r.value_text, r.flag,
                  r.qualifier, t.name, t.canonical_unit, t.category
           FROM results r JOIN test_types t ON t.id = r.test_type_id
           WHERE r.member_id = ? ORDER BY t.category, t.name, r.taken_at""",
        (member_id,),
    ).fetchall()
    if not rows:
        return None, None, None

    hist = {}
    for r in rows:
        hist.setdefault(r["test_type_id"], []).append(r)

    # In/out status per marker uses the same resolved range the UI shows.
    status_by_id = {}
    for s in summary:
        v = s["latest"]["value_canonical"] if s.get("latest") else None
        lo, hi = s.get("ref_low"), s.get("ref_high")
        if v is None:
            status_by_id[s["test_type_id"]] = "text/qualitative"
        elif (lo is not None and v < lo) or (hi is not None and v > hi):
            status_by_id[s["test_type_id"]] = "OUT OF RANGE"
        else:
            status_by_id[s["test_type_id"]] = "in range"
    ref_by_id = {s["test_type_id"]: (s.get("ref_low"), s.get("ref_high")) for s in summary}

    lines = []
    for tid, points in hist.items():
        name = points[0]["name"]
        unit = points[0]["canonical_unit"] or ""
        cat = points[0]["category"] or "Other"
        lo, hi = ref_by_id.get(tid, (None, None))
        ref = ""
        if lo is not None and hi is not None:
            ref = f" (normal {lo}–{hi} {unit})"
        elif hi is not None:
            ref = f" (normal < {hi} {unit})"
        elif lo is not None:
            ref = f" (normal > {lo} {unit})"
        def fmt_val(p):
            if p["value_canonical"] is not None:
                v = f"{round(p['value_canonical'], 3)}"
                return f"{p['qualifier']}{v}" if p["qualifier"] else v
            return p["value_text"] or "—"

        # Points are oldest→newest. Mark the latest explicitly and note the span
        # so the model can separate the recent turn from the long-run trajectory.
        series = [f"{str(p['taken_at'])[:10]}: {fmt_val(p)}" for p in points]
        latest = points[-1]
        status = status_by_id.get(tid, "")
        n = len(points)
        span = ""
        if n > 1:
            try:
                from datetime import date as _date
                d0 = _date.fromisoformat(str(points[0]["taken_at"])[:10])
                d1 = _date.fromisoformat(str(latest["taken_at"])[:10])
                yrs = (d1 - d0).days / 365.25
                span = f" [{n} readings over {yrs:.1f}y]" if yrs >= 0.15 else f" [{n} readings]"
            except ValueError:
                span = f" [{n} readings]"
        head = f"[{cat}] {name}{ref} — LATEST {str(latest['taken_at'])[:10]}: {fmt_val(latest)} ({status})"
        if n > 1:
            lines.append(head + f"\n    full history oldest→newest{span}: " + "; ".join(series))
        else:
            lines.append(head + "  (only one reading — no trend yet)")

    age = age_at(member["dob"]) if member and member["dob"] else None
    sex = (member["sex"] if member else None) or "not specified"
    age_str = f"{age} years old" if age is not None else "age not specified"
    body = (
        f"Patient: {age_str}, sex {sex}. {len(hist)} biomarkers tracked.\n\n"
        "Complete lab history. For each marker the LATEST reading (the current "
        "state) is marked first, then the full history oldest→newest so you can "
        "read short-term vs long-term trend:\n\n"
        + "\n".join(lines)
    )
    import hashlib
    h = hashlib.sha256(
        "|".join(f"{r['test_type_id']}:{r['taken_at']}:{r['value_canonical']}:{r['value_text']}" for r in rows).encode()
    ).hexdigest()
    return body, h, len(hist)


def _stored_analysis(conn, member_id: int):
    row = conn.execute(
        "SELECT analysis, results_hash, generated_at FROM member_analyses WHERE member_id = ?",
        (member_id,),
    ).fetchone()
    if not row:
        return None
    try:
        analysis = json.loads(row["analysis"])
    except (ValueError, TypeError):
        return None
    return {"analysis": analysis, "results_hash": row["results_hash"], "generated_at": row["generated_at"]}


@app.get("/api/members/analyses/counts")
def list_analyses_counts(request: Request):
    conn = get_db()
    try:
        vis = _visible(conn, request)
        if not vis:
            return {}
        vis_list = list(vis)
        placeholders = ",".join("?" for _ in vis_list)
        rows = conn.execute(
            f"SELECT member_id, analysis FROM member_analyses WHERE member_id IN ({placeholders})",
            vis_list
        ).fetchall()
        
        out = {}
        for r in rows:
            mid = r["member_id"]
            try:
                data = json.loads(r["analysis"])
                problems = data.get("problem_areas", [])
                urgent = sum(1 for p in problems if p.get("severity") == "urgent")
                monitor = sum(1 for p in problems if p.get("severity") == "monitor")
                minor = sum(1 for p in problems if p.get("severity") == "minor")
                out[str(mid)] = {"urgent": urgent, "monitor": monitor, "minor": minor}
            except Exception:
                out[str(mid)] = {"urgent": 0, "monitor": 0, "minor": 0}
        
        for mid in vis_list:
            if str(mid) not in out:
                out[str(mid)] = {"urgent": 0, "monitor": 0, "minor": 0}
                
        return out
    finally:
        conn.close()


@app.get("/api/members/{member_id}/analysis")
def get_member_analysis(member_id: int, request: Request):
    """Return the cached whole-member analysis, flagged stale if results changed
    since it was generated. Never triggers an AI call on its own."""
    conn = get_db()
    try:
        _require_member(conn, request, member_id)
        stored = _stored_analysis(conn, member_id)
        if not stored:
            return {"analysis": None, "generated_at": None, "stale": False, "has_data": bool(_summary_for(conn, member_id))}
        _, cur_hash, marker_count = _analysis_inputs(conn, member_id)
        return {
            "analysis": stored["analysis"],
            "generated_at": stored["generated_at"],
            "stale": cur_hash is not None and cur_hash != stored["results_hash"],
            "has_data": True,
            "marker_count": marker_count,
        }
    finally:
        conn.close()


@app.post("/api/members/{member_id}/analysis")
def generate_member_analysis(member_id: int, request: Request):
    """Generate (or regenerate) the whole-member analysis and cache it."""
    conn = get_db()
    try:
        _require_member(conn, request, member_id)
        body, results_hash, marker_count = _analysis_inputs(conn, member_id)
        if not body:
            raise HTTPException(400, "No results to analyze yet")
        provider, model, key = _ai_config(conn)
        system_prompt = _get_setting(conn, "prompt_health_analysis", ai.HEALTH_ANALYSIS_SYSTEM)
        try:
            text = ai.chat(provider, model, key, system_prompt, body)
            analysis = ai._extract_json(text)
        except ai.AIError as e:
            raise HTTPException(400, str(e))
        except (ValueError, KeyError) as e:
            raise HTTPException(400, f"Could not parse AI analysis: {e}")
        conn.execute(
            """INSERT INTO member_analyses (member_id, analysis, results_hash, generated_at)
               VALUES (?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(member_id) DO UPDATE SET
                 analysis = excluded.analysis, results_hash = excluded.results_hash,
                 generated_at = excluded.generated_at""",
            (member_id, json.dumps(analysis), results_hash),
        )
        conn.commit()
        row = conn.execute("SELECT generated_at FROM member_analyses WHERE member_id = ?", (member_id,)).fetchone()
        return {"analysis": analysis, "generated_at": row["generated_at"], "stale": False, "marker_count": marker_count}
    finally:
        conn.close()


# ---------------- export ----------------

@app.get("/api/members/{member_id}/export.csv")
def export_member_csv(member_id: int, request: Request):
    conn = get_db()
    try:
        _require_member(conn, request, member_id)
        member = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
        if not member:
            raise HTTPException(404, "Member not found")
        rows = conn.execute(
            """SELECT r.taken_at, t.name AS test_name, t.category, r.value, r.unit,
                      r.value_canonical, t.canonical_unit, r.ref_low, r.ref_high,
                      r.flag, r.note, d.lab_name, d.filename
               FROM results r
               JOIN test_types t ON t.id = r.test_type_id
               LEFT JOIN documents d ON d.id = r.document_id
               WHERE r.member_id = ?
               ORDER BY t.category, t.name, r.taken_at""",
            (member_id,),
        ).fetchall()
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["date", "test", "category", "value", "unit", "value_canonical",
                    "canonical_unit", "ref_low", "ref_high", "flag", "note", "lab", "source_file"])
        for r in rows:
            w.writerow([r["taken_at"], r["test_name"], r["category"], r["value"], r["unit"],
                        r["value_canonical"], r["canonical_unit"], r["ref_low"], r["ref_high"],
                        r["flag"], r["note"], r["lab_name"], r["filename"]])
        safe = re.sub(r"[^A-Za-z0-9_-]+", "-", member["name"]).strip("-") or "member"
        return Response(
            buf.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{safe}-lab-results.csv"'},
        )
    finally:
        conn.close()


@app.delete("/api/results/{result_id}")
def delete_result(result_id: int, request: Request):
    conn = get_db()
    try:
        row = conn.execute("SELECT member_id FROM results WHERE id = ?", (result_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        _require_member(conn, request, row["member_id"])
        conn.execute("DELETE FROM results WHERE id = ?", (result_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------------- settings ----------------

class SettingsIn(BaseModel):
    ai_provider: Optional[str] = None
    ai_key_anthropic: Optional[str] = None
    ai_key_openai: Optional[str] = None
    ai_key_gemini: Optional[str] = None
    ai_model_anthropic: Optional[str] = None
    ai_model_openai: Optional[str] = None
    ai_model_gemini: Optional[str] = None
    prompt_extraction_system: Optional[str] = None
    prompt_qa_system: Optional[str] = None
    prompt_biomarker_personalized: Optional[str] = None
    prompt_biomarker_standard: Optional[str] = None
    prompt_health_analysis: Optional[str] = None


@app.get("/api/settings")
def get_settings(request: Request):
    conn = get_db()
    try:
        _require_unlocked(conn, request)
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        out = {r["key"]: r["value"] for r in rows}
        # never leak raw keys; report presence only
        for p in ("anthropic", "openai", "gemini"):
            k = f"ai_key_{p}"
            out[f"has_key_{p}"] = bool(out.pop(k, None))
        
        # default prompts fallback if not configured in settings
        out.setdefault("prompt_extraction_system", ai.EXTRACTION_SYSTEM)
        out.setdefault("prompt_qa_system", ai.QA_SYSTEM)
        out.setdefault("prompt_biomarker_personalized", ai.BIOMARKER_PERSONALIZED_SYSTEM)
        out.setdefault("prompt_biomarker_standard", ai.BIOMARKER_STANDARD_SYSTEM)
        out.setdefault("prompt_health_analysis", ai.HEALTH_ANALYSIS_SYSTEM)
        
        # Add commit SHA
        import os
        commit_sha = os.environ.get("COMMIT_SHA", "")
        if not commit_sha:
            try:
                if os.path.exists("/app/commit_sha.txt"):
                    with open("/app/commit_sha.txt", "r") as f:
                        commit_sha = f.read().strip()
            except Exception:
                pass
        if not commit_sha:
            try:
                import subprocess
                commit_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL).decode("utf-8").strip()
            except Exception:
                pass
        out["commit_sha"] = commit_sha
        
        return out
    finally:
        conn.close()



@app.put("/api/settings")
def put_settings(s: SettingsIn, request: Request):
    conn = get_db()
    try:
        _require_unlocked(conn, request)
        for key, value in s.model_dump().items():
            if value is None:
                continue
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


CATEGORIZATION_SYSTEM_PROMPT = """You are a medical lab data categorization assistant.
You are given a list of test names. For each test name, choose the single most appropriate category from the following allowed list:
- Heavy Metals
- Urine
- Heart
- Liver
- Kidney
- Thyroid
- Metabolic
- Iron
- Bone Health
- Minerals
- Vitamins
- Hormones
- Inflammation
- Blood
- Other

Return ONLY a valid JSON object matching this schema:
{
  "suggestions": [
    {
      "test_name": "string",
      "category": "string (one of the allowed category values above)"
    }
  ]
}
Do not include any prose or markdown fences outside the JSON object."""


class BatchCategorizeReq(BaseModel):
    test_names: list[str]


class CategoryOverrideReq(BaseModel):
    test_type_id: int
    category: str


@app.get("/api/settings/defaults")
def get_settings_defaults(request: Request):
    conn = get_db()
    try:
        _require_unlocked(conn, request)
        return {
            "prompt_extraction_system": ai.EXTRACTION_SYSTEM,
            "prompt_qa_system": ai.QA_SYSTEM,
            "prompt_biomarker_personalized": ai.BIOMARKER_PERSONALIZED_SYSTEM,
            "prompt_biomarker_standard": ai.BIOMARKER_STANDARD_SYSTEM,
            "prompt_health_analysis": ai.HEALTH_ANALYSIS_SYSTEM
        }
    finally:
        conn.close()


@app.post("/api/test-types/batch-categorize")
def batch_categorize_tests(req: BatchCategorizeReq, request: Request):
    conn = get_db()
    try:
        _require_unlocked(conn, request)
        if not req.test_names:
            return {"suggestions": []}
            
        provider, model, key = _ai_config(conn)
        prompt = f"Categorize these tests:\n" + "\n".join(f"- {name}" for name in req.test_names)
        
        try:
            import json
            text = ai.chat(provider, model, key, CATEGORIZATION_SYSTEM_PROMPT, prompt).strip()
            if text.startswith("```"):
                lines = text.split("\n")
                if lines[0].startswith("```json"):
                    text = "\n".join(lines[1:-1])
                elif lines[0].startswith("```"):
                    text = "\n".join(lines[1:-1])
            parsed = json.loads(text)
            return parsed
        except Exception as e:
            raise HTTPException(400, f"AI categorization failed: {str(e)}")
    finally:
        conn.close()


@app.post("/api/test-types/override-category")
def override_test_type_category(req: CategoryOverrideReq, request: Request):
    conn = get_db()
    try:
        _require_unlocked(conn, request)
        conn.execute(
            "UPDATE test_types SET category = ?, category_override = ? WHERE id = ?",
            (req.category, req.category, req.test_type_id)
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.get("/api/categories")
def list_categories():
    """The canonical panel list, for the manual-categorization dropdown. Static
    label names, no member data — safe to read without unlock."""
    return {"categories": CATEGORIES}


# ---------------- AI Q&A ----------------

class AskReq(BaseModel):
    member_id: int
    test_type_ids: list[int]
    question: str
    provider: Optional[str] = None
    model: Optional[str] = None


@app.post("/api/ask")
def ask(req: AskReq, request: Request):
    conn = get_db()
    try:
        _require_member(conn, request, req.member_id)
        member = conn.execute("SELECT * FROM members WHERE id = ?", (req.member_id,)).fetchone()
        if not member:
            raise HTTPException(404, "Member not found")
        # Age/sex help interpretation; the person's name never leaves the box.
        age = age_at(member["dob"])
        who = ["Patient"]
        if age is not None:
            who.append(f"{age}y")
        if member["sex"]:
            who.append(str(member["sex"]))
        lines = [" · ".join(who)]
        for ttid in req.test_type_ids:
            tt = conn.execute("SELECT * FROM test_types WHERE id = ?", (ttid,)).fetchone()
            if not tt:
                continue
            rows = conn.execute(
                """SELECT taken_at, value, unit, value_canonical, value_text, flag FROM results
                   WHERE member_id = ? AND test_type_id = ? ORDER BY taken_at""",
                (req.member_id, ttid),
            ).fetchall()
            ref = []
            if tt["ref_low"] is not None:
                ref.append(f"low {tt['ref_low']}")
            if tt["ref_high"] is not None:
                ref.append(f"high {tt['ref_high']}")
            lines.append(f"\n## {tt['name']} (canonical unit {tt['canonical_unit']}; reference {', '.join(ref) or 'n/a'})")
            for r in rows:
                if r['value_canonical'] is not None:
                    orig = f"{r['value']} {r['unit']}"
                    canon = f"{round(r['value_canonical'], 3)} {tt['canonical_unit']}"
                    flag = f" [{r['flag']}]" if r["flag"] else ""
                    extra = f" (reported as {orig})" if orig.replace(" ", "") != canon.replace(" ", "") else ""
                    lines.append(f"- {r['taken_at']}: {canon}{flag}{extra}")
                else:
                    flag = f" [{r['flag']}]" if r["flag"] else ""
                    lines.append(f"- {r['taken_at']}: {r['value_text'] or r['value']}{flag}")
        history = "\n".join(lines)
        prompt = f"Historical lab data:\n{history}\n\nQuestion: {req.question}"
        provider, model, key = _ai_config(conn, req.provider, req.model)
        qa_sys = _get_setting(conn, "prompt_qa_system", ai.QA_SYSTEM)
        try:
            answer = ai.chat(provider, model, key, qa_sys, prompt)
        except ai.AIError as e:
            raise HTTPException(400, str(e))
        return {"answer": answer, "provider": provider, "model": model, "context": history}
    finally:
        conn.close()


# ---------------- static frontend ----------------

_FRONTEND = Path(__file__).parent.parent / "static"
if _FRONTEND.exists():
    app.mount("/", StaticFiles(directory=_FRONTEND, html=True), name="static")
