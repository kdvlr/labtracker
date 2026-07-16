import csv
import io
import json
import mimetypes
import re
import uuid
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ai
from .config import FILES_DIR
from .db import get_db, init_db, row_to_dict
from .matching import match_test_type
from .reference import categorize
from .units import compute_flag, known_units, to_canonical, to_number

app = FastAPI(title="LabTracker")


@app.on_event("startup")
def _startup():
    init_db()


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


# ---------------- members ----------------

class Member(BaseModel):
    name: str
    dob: Optional[str] = None
    sex: Optional[str] = None
    color: Optional[str] = None


@app.get("/api/members")
def list_members():
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM members ORDER BY id").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@app.post("/api/members")
def create_member(m: Member):
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO members (name, dob, sex, color) VALUES (?, ?, ?, ?)",
            (m.name, m.dob, m.sex, m.color),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM members WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@app.put("/api/members/{member_id}")
def update_member(member_id: int, m: Member):
    conn = get_db()
    try:
        cur = conn.execute(
            "UPDATE members SET name = ?, dob = ?, sex = ?, color = ? WHERE id = ?",
            (m.name, m.dob, m.sex, m.color, member_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
        conn.commit()
        row = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@app.delete("/api/members/{member_id}")
def delete_member(member_id: int):
    conn = get_db()
    try:
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
def describe_test_type(tt_id: int, member_id: Optional[int] = None):
    """Return a clinical reference description. If member_id is provided,
    generates a dynamic, age-specific and history-aware guide for that member.
    Otherwise, returns the cached generic test description."""
    conn = get_db()
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
            member = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
            if member:
                age = _calculate_age(member["dob"])
                sex = member["sex"] or "Not specified"
                age_str = f"{age} years old" if age is not None else "Age not specified"
                
                # Fetch member's latest results for this biomarker
                latest = conn.execute(
                    """SELECT value, unit, value_canonical, flag, taken_at 
                       FROM results 
                       WHERE member_id = ? AND test_type_id = ? 
                       ORDER BY taken_at DESC LIMIT 1""",
                    (member_id, tt_id)
                ).fetchone()
                
                latest_str = "No results on file yet."
                if latest:
                    orig_val = f"{latest['value']} {latest['unit']}"
                    canon_val = f"{round(latest['value_canonical'], 3)} {row['canonical_unit'] or ''}"
                    flag_str = f" (Flagged as {latest['flag']})" if latest['flag'] else ""
                    latest_str = f"Latest reading on {latest['taken_at']}: {canon_val} {flag_str} (reported as {orig_val})."

                # Fetch other test types in the same category
                related_rows = conn.execute(
                    """SELECT name 
                       FROM test_types 
                       WHERE category = ? AND id != ?""",
                    (row["category"], tt_id)
                ).fetchall()
                related_names = [r["name"] for r in related_rows]
                related_str = ", ".join(related_names[:5]) if related_names else "none"

                member_context = (
                    f"Write this clinical reference guide specifically for the patient: "
                    f"Name: {member['name']}, Age: {age_str}, Sex: {sex}.\n"
                    f"Patient's Latest Result: {latest_str}\n"
                    f"Related tests in the same category ({row['category']}): {related_str}.\n"
                )

        if member_id is not None and member_context:
            system_prompt = (
                "You are an expert clinical reference assistant explaining lab test results for a family member. "
                "You must return ONLY a valid JSON object matching this schema:\n"
                "{\n"
                "  \"description\": \"Personalized description of what this biomarker measures and why it matters.\",\n"
                "  \"high\": \"Personalized clinical ramifications and details of a high level.\",\n"
                "  \"low\": \"Personalized clinical ramifications and details of a low level.\",\n"
                "  \"age_related\": \"Observations or considerations relevant to a patient of this age.\",\n"
                "  \"related_tests\": \"How to interpret this result in conjunction with related panel tests.\"\n"
                "}\n"
                "Do not include any prose outside the JSON object. Do not include markdown fences."
            )
            prompt = (
                f"{member_context}\n"
                f"Biomarker: {row['name']}" + (f" (measured in {row['canonical_unit']})" if row['canonical_unit'] else "") + ".\n"
                f"Reference range limits: low {row['ref_low'] or 'n/a'}, high {row['ref_high'] or 'n/a'}.\n\n"
                f"Please write a guide that addresses the following:\n"
                f"1. **description**: Explain the biomarker clearly, what the reference ranges mean, and why it matters.\n"
                f"2. **high**: Ramifications of a high level.\n"
                f"3. **low**: Ramifications of a low level.\n"
                f"4. **age_related**: Note any relevant observations or normal shifts for a {age_str} patient.\n"
                f"5. **related_tests**: Explain how this biomarker relates to other tests in the same panel ({related_str}), and how to interpret their results together."
            )
            try:
                import json
                text = ai.chat(provider, model, key, system_prompt, prompt).strip()
                if text.startswith("```"):
                    lines = text.split("\n")
                    if lines[0].startswith("```json"):
                        text = "\n".join(lines[1:-1])
                    elif lines[0].startswith("```"):
                        text = "\n".join(lines[1:-1])
                parsed = json.loads(text)
            except Exception as e:
                parsed = {
                    "description": text,
                    "high": "Clinical review suggested.",
                    "low": "Clinical review suggested.",
                    "age_related": "Refer to guidelines.",
                    "related_tests": "See related tests tab."
                }
            return {"description": parsed, "cached": False}
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
            
            system_prompt = (
                "You are an expert clinical reference assistant explaining lab test results. "
                "You must return ONLY a valid JSON object matching this schema:\n"
                "{\n"
                "  \"description\": \"Description of what this biomarker measures and why it matters.\",\n"
                "  \"high\": \"Clinical ramifications and details of a high level.\",\n"
                "  \"low\": \"Clinical ramifications and details of a low level.\",\n"
                "  \"age_related\": \"General observations or considerations relevant by age.\",\n"
                "  \"related_tests\": \"How this tracks with other biomarkers in the same panel.\"\n"
                "}\n"
                "Do not include any prose outside the JSON object. Do not include markdown fences."
            )
            prompt = f"Biomarker: {row['name']}" + (f" (measured in {row['canonical_unit']})" if row["canonical_unit"] else "") + "."
            try:
                import json
                text = ai.chat(provider, model, key, system_prompt, prompt).strip()
                if text.startswith("```"):
                    lines = text.split("\n")
                    if lines[0].startswith("```json"):
                        text = "\n".join(lines[1:-1])
                    elif lines[0].startswith("```"):
                        text = "\n".join(lines[1:-1])
                parsed = json.loads(text)
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




# ---------------- documents / upload / extract ----------------

@app.post("/api/documents")
async def upload_document(
    file: UploadFile = File(...),
    member_id: Optional[int] = Form(None),
):
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    mime = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    ext = Path(file.filename or "").suffix or mimetypes.guess_extension(mime) or ""
    stored = f"{uuid.uuid4().hex}{ext}"
    (FILES_DIR / stored).write_bytes(data)
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO documents (member_id, filename, stored_name, mime, size) VALUES (?, ?, ?, ?, ?)",
            (member_id, file.filename, stored, mime, len(data)),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@app.get("/api/documents")
def list_documents():
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT d.*, m.name AS member_name,
                      (SELECT COUNT(*) FROM results r WHERE r.document_id = d.id) AS result_count
               FROM documents d LEFT JOIN members m ON m.id = d.member_id
               ORDER BY d.created_at DESC"""
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


class ReassignReq(BaseModel):
    member_id: int


@app.post("/api/documents/{doc_id}/reassign")
def reassign_document(doc_id: int, req: ReassignReq):
    """Move a document and every result it produced to a different member —
    fixes an import uploaded under the wrong person, without losing the data."""
    conn = get_db()
    try:
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
def delete_document(doc_id: int):
    """Delete an entire import: the document, its stored file, and every result
    that was saved from it. Manually-entered results (no document) are untouched."""
    conn = get_db()
    try:
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
def get_document_file(doc_id: int):
    conn = get_db()
    try:
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
def extract_document(doc_id: int, req: ExtractReq):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        data = (FILES_DIR / row["stored_name"]).read_bytes()
        provider, model, key = _ai_config(conn, req.provider, req.model)
        try:
            parsed = ai.extract(provider, model, key, data, row["mime"])
        except ai.AIError as e:
            raise HTTPException(400, str(e))

        types = _test_types(conn)
        items = []
        for r in parsed.get("results", []):
            name = r.get("test_name")
            value = to_number(r.get("value"))
            unit = (r.get("unit") or "").strip()
            # Skip rows with no numeric value or no name — a qualitative result
            # ("Negative") or a garbled cell can't sink the rest of the report.
            if value is None or not name or not str(name).strip():
                continue
            ref_low = to_number(r.get("ref_low"))
            ref_high = to_number(r.get("ref_high"))
            tt = match_test_type(name, types)
            canonical = None
            if tt:
                canonical = to_canonical(value, unit, tt["canonical_unit"], tt["conversions"])
            # Only pre-select a merge when the extracted unit actually converts into
            # the matched type. Otherwise a fuzzy name match (e.g. "Cholesterol/HDL
            # Ratio" → "HDL Cholesterol", unit "Ratio") would pair an incompatible
            # unit and fail on save. Those rows default to "track as new" instead.
            match_ok = tt is not None and canonical is not None
            items.append(
                {
                    "test_name": name,
                    "value": value,
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
        # Persist the extraction so the review can be resumed later (e.g. after a
        # reload or if the browser closed mid-review) without re-calling the AI.
        conn.execute(
            """UPDATE documents SET status = 'extracted',
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
def get_extraction(doc_id: int):
    """Return the saved extraction payload for a document so its review can be
    resumed without re-running the AI. 404 if the document was never extracted."""
    conn = get_db()
    try:
        row = conn.execute("SELECT extraction FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        if not row["extraction"]:
            raise HTTPException(404, "No saved extraction — run extraction first")
        return json.loads(row["extraction"])
    finally:
        conn.close()


# ---------------- commit results ----------------

class CommitItem(BaseModel):
    test_type_id: int
    value: float
    unit: str
    ref_low: Optional[float] = None
    ref_high: Optional[float] = None
    note: Optional[str] = None


class CommitReq(BaseModel):
    member_id: int
    taken_at: str
    document_id: Optional[int] = None
    # Set true to save even when a result with the same date + value already
    # exists for this member and test (the "save anyway" override).
    force: bool = False
    items: list[CommitItem]


def _same_value(a: Optional[float], b: Optional[float]) -> bool:
    """Two canonical values count as the same reading if they're equal within a
    tiny relative tolerance (guards against float round-trips)."""
    if a is None or b is None:
        return a is b
    return abs(a - b) <= 1e-6 * max(1.0, abs(a), abs(b))


@app.post("/api/results/commit")
def commit_results(req: CommitReq):
    conn = get_db()
    try:
        types = {t["id"]: t for t in _test_types(conn)}
        skipped = []
        duplicates = []
        prepared = []  # rows that pass validation, ready to insert
        for it in req.items:
            tt = types.get(it.test_type_id)
            if not tt:
                skipped.append({"reason": "unknown test type"})
                continue
            canonical = to_canonical(it.value, it.unit, tt["canonical_unit"], tt["conversions"])
            if canonical is None:
                # One incompatible unit must not sink the whole report — skip this
                # row, save the rest, and tell the caller what didn't go in.
                skipped.append({
                    "name": tt["name"],
                    "unit": it.unit,
                    "reason": f"unit '{it.unit}' can't convert to {tt['canonical_unit'] or 'its unit'}",
                })
                continue
            rlow_c = to_canonical(it.ref_low, it.unit, tt["canonical_unit"], tt["conversions"]) if it.ref_low is not None else None
            rhigh_c = to_canonical(it.ref_high, it.unit, tt["canonical_unit"], tt["conversions"]) if it.ref_high is not None else None
            # Fall back to canonical reference range from the catalog.
            eff_low = rlow_c if rlow_c is not None else tt["ref_low"]
            eff_high = rhigh_c if rhigh_c is not None else tt["ref_high"]
            flag = compute_flag(canonical, eff_low, eff_high)

            # A duplicate is the same member + test + date carrying the same
            # (canonical) value — i.e. re-importing a report already on file.
            existing = conn.execute(
                "SELECT value_canonical FROM results WHERE member_id = ? AND test_type_id = ? AND taken_at = ?",
                (req.member_id, it.test_type_id, req.taken_at),
            ).fetchall()
            if any(_same_value(e["value_canonical"], canonical) for e in existing):
                duplicates.append({
                    "name": tt["name"], "date": req.taken_at,
                    "value": it.value, "unit": it.unit,
                })

            prepared.append((it, canonical, rlow_c, rhigh_c, flag))

        # Block on duplicates unless the caller explicitly forces the save. Nothing
        # is written in this case, so the client can safely retry with force=true.
        if duplicates and not req.force:
            return {"created": 0, "skipped": skipped, "duplicates": duplicates,
                    "needs_confirmation": True}

        created = 0
        for it, canonical, rlow_c, rhigh_c, flag in prepared:
            conn.execute(
                """INSERT INTO results
                   (member_id, test_type_id, document_id, taken_at, value, unit, value_canonical,
                    ref_low, ref_high, ref_low_canonical, ref_high_canonical, flag, note)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    req.member_id, it.test_type_id, req.document_id, req.taken_at,
                    it.value, it.unit, canonical, it.ref_low, it.ref_high,
                    rlow_c, rhigh_c, flag, it.note,
                ),
            )
            created += 1
        if req.document_id and created:
            conn.execute("UPDATE documents SET status = 'committed', member_id = COALESCE(member_id, ?) WHERE id = ?", (req.member_id, req.document_id))
        conn.commit()
        return {"created": created, "skipped": skipped, "duplicates": duplicates}
    finally:
        conn.close()


# ---------------- reading results / trends ----------------

@app.get("/api/results")
def get_results(member_id: Optional[int] = None, test_type_id: Optional[int] = None):
    conn = get_db()
    try:
        q = """SELECT r.*, t.name AS test_name, t.slug AS test_slug, t.canonical_unit,
                      t.category, m.name AS member_name
               FROM results r
               JOIN test_types t ON t.id = r.test_type_id
               JOIN members m ON m.id = r.member_id
               WHERE 1=1"""
        params = []
        if member_id is not None:
            q += " AND r.member_id = ?"
            params.append(member_id)
        if test_type_id is not None:
            q += " AND r.test_type_id = ?"
            params.append(test_type_id)
        q += " ORDER BY r.taken_at"
        rows = conn.execute(q, params).fetchall()
        return [dict(r) for r in rows]
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
        """SELECT test_type_id, value_canonical, flag, taken_at, value, unit,
                  ref_low_canonical, ref_high_canonical
           FROM results WHERE member_id = ? ORDER BY test_type_id, taken_at""",
        (member_id,),
    ).fetchall()
    series = {}
    for p in pts:
        series.setdefault(p["test_type_id"], []).append(dict(p))
    out = []
    for r in rows:
        s = series.get(r["test_type_id"], [])
        d = row_to_dict(r)
        d["flagged"] = int(r["flagged"] or 0)
        d["latest"] = s[-1] if s else None
        d["spark"] = [p["value_canonical"] for p in s]
        out.append(d)
    return out


@app.get("/api/members/{member_id}/summary")
def member_summary(member_id: int):
    conn = get_db()
    try:
        return _summary_for(conn, member_id)
    finally:
        conn.close()


# ---------------- checkup schedules ----------------

DUE_SOON_DAYS = 30  # "due" window before the target date


def _schedule_rows(conn, member_id: int) -> list:
    """Member's schedules with computed due status from their latest result."""
    rows = conn.execute(
        """SELECT s.*, t.name AS test_name, t.slug AS test_slug,
                  (SELECT MAX(r.taken_at) FROM results r
                    WHERE r.member_id = s.member_id AND r.test_type_id = s.test_type_id) AS last_at
           FROM schedules s JOIN test_types t ON t.id = s.test_type_id
           WHERE s.member_id = ? ORDER BY t.name""",
        (member_id,),
    ).fetchall()
    today = date.today()
    out = []
    for r in rows:
        d = dict(r)
        if d["last_at"]:
            try:
                last = date.fromisoformat(str(d["last_at"])[:10])
            except ValueError:
                last = today
            next_due = last + timedelta(days=round(d["interval_months"] * 30.44))
            d["next_due"] = next_due.isoformat()
            if next_due < today:
                d["due_status"] = "overdue"
            elif (next_due - today).days <= DUE_SOON_DAYS:
                d["due_status"] = "due"
            else:
                d["due_status"] = "ok"
        else:
            # Never tested: the reminder exists precisely because this should be
            # measured, so treat it as due now.
            d["next_due"] = None
            d["due_status"] = "due"
        out.append(d)
    return out


class ScheduleIn(BaseModel):
    member_id: int
    test_type_id: int
    interval_months: int
    note: Optional[str] = None


@app.get("/api/members/{member_id}/schedules")
def member_schedules(member_id: int):
    conn = get_db()
    try:
        return _schedule_rows(conn, member_id)
    finally:
        conn.close()


@app.post("/api/schedules")
def upsert_schedule(s: ScheduleIn):
    if s.interval_months < 1:
        raise HTTPException(400, "Interval must be at least 1 month")
    conn = get_db()
    try:
        if not conn.execute("SELECT 1 FROM members WHERE id = ?", (s.member_id,)).fetchone():
            raise HTTPException(404, "Member not found")
        if not conn.execute("SELECT 1 FROM test_types WHERE id = ?", (s.test_type_id,)).fetchone():
            raise HTTPException(404, "Test type not found")
        conn.execute(
            """INSERT INTO schedules (member_id, test_type_id, interval_months, note)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(member_id, test_type_id)
               DO UPDATE SET interval_months = excluded.interval_months, note = excluded.note""",
            (s.member_id, s.test_type_id, s.interval_months, s.note),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.delete("/api/schedules/{schedule_id}")
def delete_schedule(schedule_id: int):
    conn = get_db()
    try:
        conn.execute("DELETE FROM schedules WHERE id = ?", (schedule_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------------- export ----------------

@app.get("/api/members/{member_id}/export.csv")
def export_member_csv(member_id: int):
    conn = get_db()
    try:
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
def delete_result(result_id: int):
    conn = get_db()
    try:
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


@app.get("/api/settings")
def get_settings():
    conn = get_db()
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        out = {r["key"]: r["value"] for r in rows}
        # never leak raw keys; report presence only
        for p in ("anthropic", "openai", "gemini"):
            k = f"ai_key_{p}"
            out[f"has_key_{p}"] = bool(out.pop(k, None))
        
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
def put_settings(s: SettingsIn):
    conn = get_db()
    try:
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


# ---------------- AI Q&A ----------------

class AskReq(BaseModel):
    member_id: int
    test_type_ids: list[int]
    question: str
    provider: Optional[str] = None
    model: Optional[str] = None


@app.post("/api/ask")
def ask(req: AskReq):
    conn = get_db()
    try:
        member = conn.execute("SELECT * FROM members WHERE id = ?", (req.member_id,)).fetchone()
        if not member:
            raise HTTPException(404, "Member not found")
        lines = [f"Member: {member['name']}"]
        for ttid in req.test_type_ids:
            tt = conn.execute("SELECT * FROM test_types WHERE id = ?", (ttid,)).fetchone()
            if not tt:
                continue
            rows = conn.execute(
                """SELECT taken_at, value, unit, value_canonical, flag FROM results
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
                orig = f"{r['value']} {r['unit']}"
                canon = f"{round(r['value_canonical'], 3)} {tt['canonical_unit']}"
                flag = f" [{r['flag']}]" if r["flag"] else ""
                extra = f" (reported as {orig})" if orig.replace(" ", "") != canon.replace(" ", "") else ""
                lines.append(f"- {r['taken_at']}: {canon}{flag}{extra}")
        history = "\n".join(lines)
        prompt = f"Historical lab data:\n{history}\n\nQuestion: {req.question}"
        provider, model, key = _ai_config(conn, req.provider, req.model)
        try:
            answer = ai.chat(provider, model, key, ai.QA_SYSTEM, prompt)
        except ai.AIError as e:
            raise HTTPException(400, str(e))
        return {"answer": answer, "provider": provider, "model": model, "context": history}
    finally:
        conn.close()


# ---------------- static frontend ----------------

_FRONTEND = Path(__file__).parent.parent / "static"
if _FRONTEND.exists():
    app.mount("/", StaticFiles(directory=_FRONTEND, html=True), name="static")
