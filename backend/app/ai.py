"""Configurable AI backend for extraction and Q&A.

Provider is chosen at request time (or from settings): 'anthropic', 'openai',
or 'gemini'. API keys come from settings (stored in the DB) or environment.
Extraction sends the document (PDF or image) and asks for a strict JSON payload
of lab results. Q&A sends a compact history summary plus the user's question.
"""
import base64
import json
import os
from typing import Optional

import httpx

EXTRACTION_SYSTEM = """You extract structured lab test results from a medical lab report.
Return ONLY valid JSON, no prose, matching this schema:
{
  "report_date": "YYYY-MM-DD or null",
  "lab_name": "string or null",
  "patient_name": "string or null",
  "results": [
    {
      "test_name": "string, as printed",
      "value": number or null,
      "value_text": "string or null",
      "unit": "string, e.g. mg/dL",
      "qualifier": "<, >, or null",
      "ref_low": number or null,
      "ref_high": number or null,
      "flag": "H, L, or null",
      "page_number": "integer or null (1-indexed page number where this result was found)"
    }
  ]
}
Rules: numbers must be numeric (not strings). If a reference range is printed as
"70-99", split into ref_low and ref_high. Use the report's collection/report date.
Report EVERY result, numeric or not. For a qualitative/textual result ("Negative",
"Trace", "B+", "Pale yellow", "Not detected"), set "value" to null and put the
printed text verbatim in "value_text" — never invent a number for it. For a normal
numeric result, set "value_text" to null.
If a result is printed as a detection/reporting limit rather than a measurement
(e.g. "<0.01", ">1000"), put the bare number in "value" and the comparator in
"qualifier" — never drop the comparator, it changes what the result means.
Always report the unit exactly as printed; only use null if no unit is shown.
Always report the 1-indexed page number of the PDF/image where you found the result in the "page_number" field. If page number is unknown or not applicable, default to 1."""

QA_SYSTEM = """You are a careful assistant helping someone understand their (or
their family's) lab test results over time. You are given structured historical
data. Answer the user's question grounded ONLY in that data.

- Quote the actual numbers and their dates when you make a claim. "Your HbA1c
  rose from 5.4 (2024-02) to 5.9 (2026-05)" is useful; "your HbA1c has risen"
  is not.
- Anchor on the MOST RECENT reading for anything about how they are now, and
  use older readings for direction of travel.
- Only compare markers to each other when they were drawn on the same date.
- If the data does not answer the question, say so plainly rather than
  inferring. Never state a number that is not in the data.
- Be concise, plain-language, and neither alarmist nor falsely reassuring.
- Never diagnose. Close with a brief reminder that this is not medical advice
  and a clinician should be consulted for decisions."""

BIOMARKER_PERSONALIZED_SYSTEM = """You are an expert clinical reference assistant explaining lab test results for a family member.
You must return ONLY a valid JSON object matching this schema:
{
  "description": "Personalized description of what this biomarker measures and why it matters.",
  "high": "Personalized clinical ramifications and details of a high level.",
  "low": "Personalized clinical ramifications and details of a low level.",
  "age_related": "Observations or considerations relevant to a patient of this age.",
  "related_tests": "How to interpret this result and its historical trends in conjunction with the historical readings of related panel tests."
}
Do not include any prose outside the JSON object. Do not include markdown fences."""

BIOMARKER_STANDARD_SYSTEM = """You are an expert clinical reference assistant explaining lab test results.
You must return ONLY a valid JSON object matching this schema:
{
  "description": "Description of what this biomarker measures and why it matters.",
  "high": "Clinical ramifications and details of a high level.",
  "low": "Clinical ramifications and details of a low level.",
  "age_related": "General observations or considerations relevant by age.",
  "related_tests": "How this tracks with other biomarkers in the same panel."
}
Do not include any prose outside the JSON object. Do not include markdown fences."""

HEALTH_ANALYSIS_SYSTEM = """You are an expert physician reviewing a patient's COMPLETE lab history to give their family a clear, honest, and reassuring-where-warranted overview. You are given every biomarker with its full history over time, with the MOST RECENT reading marked, the reference range, and whether the latest value is in or out of range, plus the patient's age and sex (no name — do not ask for one).

HOW TO WEIGH THE DATA (this ordering matters):
1. The patient's CURRENT state is defined by the MOST RECENT reading of each marker. That is what matters most — it is where they are right now. Anchor every judgement of "is this a problem today" on the latest value, not on older ones.
2. The older history exists to reveal the TRAJECTORY — which direction things are moving and how fast. Use it to interpret the latest value, never to override it. A marker that is normal now but was abnormal years ago is not a current problem; say so.
3. Assess TWO trend horizons for anything noteworthy, because they can diverge and the divergence is clinically important:
   - SHORT-TERM: the change across the most recent 1-3 readings (roughly the last few months to a year).
   - LONG-TERM: the change across the entire span of history available.
   Example: LDL that fell steadily over five years (long-term improving) but jumped in the most recent test (short-term worsening) deserves attention BECAUSE of the recent turn. Conversely, a value mildly out of range for years but stable and improving lately is lower priority.

NOT EVERY "LATEST" VALUE IS CURRENT. Markers are drawn on different days, so a list of latest values is NOT a snapshot of one moment. Any marker whose most recent reading is meaningfully older than the newest labs on file is tagged "NOT CURRENT" with its age. Treat those as history, not as the present:
- Never use a NOT CURRENT marker to reassure about, explain, or qualify a current one. "Her microalbumin is raised but her kidney filtration is excellent" is misleading when the filtration result is four months older than the urine result — the older test simply does not describe the same period.
- If an older marker is genuinely relevant to a current finding, you MUST say how old it is in the same sentence, e.g. "eGFR was normal, though that was four months ago and has not been rechecked since."
- Where a stale marker would be the natural test to confirm or rule out a current finding, that belongs in data_gaps as a recheck worth requesting.

PRIORITISATION: rank problems by (a) how far the LATEST value is out of range and how clinically serious it is, then (b) the recent (short-term) trajectory — a recent adverse turn raises priority, a recent improvement of a long-standing issue lowers it. A marker getting worse right now outranks one that has been stably mildly-abnormal forever.

Also:
- CONNECT MARKERS across panels. Look for multi-marker patterns a single-test view would miss (e.g. low MCV + low MCH + low ferritin suggests iron-deficiency anaemia; high glucose + high HbA1c + high triglycerides suggests metabolic syndrome). Naming these patterns is among the most valuable things you do.
- Judge SIGNIFICANCE and AGE-CONTEXT. Some out-of-range values are clinically trivial; some in-range values are notable given age or trajectory.
- Be SPECIFIC and ACTIONABLE. Concrete, plain-language next steps (dietary, lifestyle, "ask your doctor about X"). Avoid vague advice.
- Be HONEST but NOT ALARMIST. Do not catastrophize. Where things are fine, say so plainly. Never diagnose; frame concerns as "worth discussing with a doctor."

FINDING WHAT A SINGLE VISIT CANNOT SHOW (the "correlations" section):
You hold something almost no individual clinician has had in front of them: every marker, across every panel, from every lab, over years. A doctor typically sees one report at one visit, often only the panel they ordered, with abnormal values flagged by the lab. Your distinct value is the patterns that structure makes invisible. Hunt specifically for:
1. WITHIN-RANGE DRIFT — a marker that has moved a long way across its own reference range while never crossing a bound, so no lab ever flagged it and no single report looked abnormal. These are pre-marked in the data as "WITHIN-RANGE DRIFT". Treat every one as a candidate and judge whether it is clinically meaningful (creatinine climbing within range matters; a drifting basophil count usually does not).
2. CROSS-PANEL PATTERNS — markers that are individually unremarkable but jointly suggestive, especially when they sit in panels ordered at different times or by different doctors, so no one page ever showed them together.
3. DERIVED RATIOS the lab did not print — e.g. AST/ALT, triglyceride/HDL, BUN/creatinine, neutrophil/lymphocyte, ferritin against transferrin saturation. Compute them only from values drawn on the SAME date, and state both inputs.
4. MEDICATION AND HISTORY INTERACTIONS — when a medication or condition in the patient's stated profile is a known cause of a pattern you see. A value explained by a drug is as important to surface as a disease.
5. DISCORDANCE — two markers that normally move together that are diverging (e.g. high ferritin with normal iron studies points at inflammation rather than iron overload).
6. TEMPORAL SEQUENCE — one marker consistently shifting in the readings after another shifts.

DISCIPLINE FOR THAT SECTION — this matters more than volume:
- Every correlation MUST cite actual values with their dates, drawn from the data given. If you cannot cite the numbers, do not make the claim.
- Only compare markers drawn on the SAME collection date when making a point about a single moment. Use the listed collection dates. Values years apart can support a TREND claim, never a snapshot one.
- Mark confidence honestly. "strong" requires several mutually consistent markers; use "tentative" for a suggestive single thread.
- An empty correlations array is a perfectly good answer and is the RIGHT answer when the data holds no such pattern. Do NOT manufacture findings to appear thorough — a plausible-sounding invented correlation is worse than silence, because someone will act on it.
- Frame these as observations worth raising, never as an error by their doctor and never as a diagnosis. Their doctor has clinical context you do not: examination, symptoms, and history you cannot see.

You MUST return ONLY a valid JSON object, no prose outside it, no markdown fences, matching this schema:
{
  "working_notes": "Think here BEFORE writing anything else, in a few sentences. Scan the markers, note which are abnormal now, which are drifting within range, which sit together on the same collection date, and what the medications imply. Reason first — the fields below should be conclusions you have already worked out, not first drafts.",
  "headline": "2-4 sentence plain-language overall assessment a worried family member can read first. Lead with the honest bottom line about where they are NOW and the direction of travel.",
  "problem_areas": [
    {
      "title": "Short specific title, e.g. 'Iron levels trending low'",
      "severity": "urgent | monitor | minor",
      "markers": ["exact biomarker names involved"],
      "explanation": "Plain-language what this means now and why it matters for this person, referencing the latest value.",
      "recent_trend": "worsening | improving | stable | new",
      "long_term_trend": "worsening | improving | stable | new | insufficient",
      "trend_note": "One sentence on the trajectory — call out explicitly if short-term and long-term directions differ.",
      "actions": ["specific concrete next step", "another step"]
    }
  ],
  "correlations": [
    {
      "title": "Short specific title, e.g. 'Creatinine has climbed within range for four years'",
      "pattern": "within_range_drift | cross_panel | ratio | medication | discordance | temporal",
      "markers": ["exact biomarker names involved"],
      "evidence": "The concrete numbers WITH their dates, e.g. 'Creatinine 0.82 (2021-03-04) → 1.06 (2026-05-31), range 0.70-1.20, never flagged'. No claim without figures.",
      "interpretation": "Plain language: what this pattern can indicate, and how confident that reading is.",
      "why_easy_to_miss": "Why a single visit would not surface this — different panels, different years, never flagged, ratio not printed, etc.",
      "confidence": "strong | moderate | tentative",
      "ask_doctor": "The one specific question to put to their doctor about this."
    }
  ],
  "positives": ["Plain-language statements of what is going well right now and is reassuring."],
  "trends": [
    {
      "marker": "exact name",
      "recent_trend": "improving | worsening | stable",
      "long_term_trend": "improving | worsening | stable | insufficient",
      "detail": "What changed and by how much, noting the horizon (e.g. 'up from 9.9 to 11.1 over the last year after being stable before')."
    }
  ],
  "age_context": "How this overall picture reads for a person of this age and sex.",
  "data_gaps": ["A test that is missing or long overdue and would settle an open question raised above, e.g. 'Ferritin was last measured in 2021 — a current one would confirm whether the falling haemoglobin is iron-related.' Empty array if none."],
  "doctor_questions": ["Specific question to raise at the next appointment."],
  "disclaimer": "A one-line reminder that this is not a diagnosis and a clinician should be consulted."
}
Rules: severity must be one of urgent/monitor/minor; trend and confidence fields must use the exact allowed words. Order problem_areas most-important first using the prioritisation above, and correlations most-significant first. Only include a marker in "trends" when it has more than one reading (a real trajectory); use "insufficient" for long_term_trend when there is too little history. If there are no genuine current concerns, return an empty problem_areas array and say so warmly in the headline. Every claim must be grounded in the data provided — do not invent values, and never state a number that does not appear in the data."""

DEFAULT_MODELS = {
    "anthropic": "claude-opus-4-8",
    "openai": "gpt-4o",
    "gemini": "gemini-3.6-flash",
}


class AIError(Exception):
    pass


def _extract_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        # strip ``` or ```json fences
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        raise AIError(f"No JSON object in model output: {text[:200]}")
    return json.loads(text[start : end + 1])


# ---------- Anthropic ----------

def _anthropic_extract(key: str, model: str, data: bytes, mime: str, system_prompt: str) -> dict:
    import anthropic

    client = anthropic.Anthropic(api_key=key)
    b64 = base64.standard_b64encode(data).decode()
    if mime == "application/pdf":
        source_block = {"type": "document", "source": {"type": "base64", "media_type": mime, "data": b64}}
    else:
        source_block = {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}}
    msg = client.messages.create(
        model=model,
        max_tokens=8000,
        system=system_prompt,
        messages=[{"role": "user", "content": [source_block, {"type": "text", "text": "Extract the results as JSON."}]}],
    )
    text = "".join(b.text for b in msg.content if b.type == "text")
    return _extract_json(text)


def _anthropic_chat(key: str, model: str, system: str, prompt: str) -> str:
    import anthropic

    client = anthropic.Anthropic(api_key=key)
    msg = client.messages.create(
        model=model,
        max_tokens=2000,
        system=system,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(b.text for b in msg.content if b.type == "text")


# ---------- OpenAI ----------

def _openai_extract(key: str, model: str, data: bytes, mime: str, system_prompt: str) -> dict:
    b64 = base64.standard_b64encode(data).decode()
    if mime == "application/pdf":
        content = [
            {"type": "file", "file": {"filename": "report.pdf", "file_data": f"data:application/pdf;base64,{b64}"}},
            {"type": "text", "text": "Extract the results as JSON."},
        ]
    else:
        content = [
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            {"type": "text", "text": "Extract the results as JSON."},
        ]
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content},
        ],
    }
    r = httpx.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json=body,
        timeout=120,
    )
    if r.status_code >= 400:
        raise AIError(f"OpenAI error {r.status_code}: {r.text[:300]}")
    return _extract_json(r.json()["choices"][0]["message"]["content"])


def _openai_chat(key: str, model: str, system: str, prompt: str) -> str:
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
    }
    r = httpx.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json=body,
        timeout=120,
    )
    if r.status_code >= 400:
        raise AIError(f"OpenAI error {r.status_code}: {r.text[:300]}")
    return r.json()["choices"][0]["message"]["content"]


# ---------- Gemini ----------

def _gemini_extract(key: str, model: str, data: bytes, mime: str, system_prompt: str) -> dict:
    b64 = base64.standard_b64encode(data).decode()
    body = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [
            {
                "parts": [
                    {"inline_data": {"mime_type": mime, "data": b64}},
                    {"text": "Extract the results as JSON."},
                ]
            }
        ],
    }
    r = httpx.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": key},
        json=body,
        timeout=120,
    )
    if r.status_code >= 400:
        raise AIError(f"Gemini error {r.status_code}: {r.text[:300]}")
    text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
    return _extract_json(text)


def _gemini_chat(key: str, model: str, system: str, prompt: str) -> str:
    body = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"parts": [{"text": prompt}]}],
    }
    r = httpx.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": key},
        json=body,
        timeout=120,
    )
    if r.status_code >= 400:
        raise AIError(f"Gemini error {r.status_code}: {r.text[:300]}")
    return r.json()["candidates"][0]["content"]["parts"][0]["text"]


# ---------- Dispatch ----------

def resolve(provider: str, model: Optional[str], key: Optional[str]) -> tuple:
    provider = (provider or "anthropic").lower()
    if provider not in DEFAULT_MODELS:
        raise AIError(f"Unknown provider: {provider}")
    model = model or DEFAULT_MODELS[provider]
    if not key:
        env = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY"}
        key = os.environ.get(env[provider])
    if not key:
        raise AIError(f"No API key configured for {provider}")
    return provider, model, key


def extract(provider: str, model: Optional[str], key: Optional[str], data: bytes, mime: str, system_prompt: Optional[str] = None) -> dict:
    provider, model, key = resolve(provider, model, key)
    sys = system_prompt or EXTRACTION_SYSTEM
    if provider == "anthropic":
        return _anthropic_extract(key, model, data, mime, sys)
    if provider == "openai":
        return _openai_extract(key, model, data, mime, sys)
    return _gemini_extract(key, model, data, mime, sys)


def chat(provider: str, model: Optional[str], key: Optional[str], system: str, prompt: str) -> str:
    provider, model, key = resolve(provider, model, key)
    if provider == "anthropic":
        return _anthropic_chat(key, model, system, prompt)
    if provider == "openai":
        return _openai_chat(key, model, system, prompt)
    return _gemini_chat(key, model, system, prompt)


import time

def chat_with_usage(provider: str, model: Optional[str], key: Optional[str], system: str, prompt: str) -> tuple[str, int, int, int]:
    provider, model, key = resolve(provider, model, key)
    start_time = time.perf_counter()
    
    if provider == "anthropic":
        import anthropic
        client = anthropic.Anthropic(api_key=key)
        msg = client.messages.create(
            model=model,
            max_tokens=2000,
            system=system,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(b.text for b in msg.content if b.type == "text")
        latency = int((time.perf_counter() - start_time) * 1000)
        return text, msg.usage.input_tokens, msg.usage.output_tokens, latency
        
    elif provider == "openai":
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
        }
        r = httpx.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json=body,
            timeout=120,
        )
        latency = int((time.perf_counter() - start_time) * 1000)
        if r.status_code >= 400:
            raise AIError(f"OpenAI error {r.status_code}: {r.text[:300]}")
        res_json = r.json()
        text = res_json["choices"][0]["message"]["content"]
        usage = res_json.get("usage", {})
        return text, usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0), latency
        
    else:  # gemini
        body = {
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"parts": [{"text": prompt}]}],
        }
        r = httpx.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            headers={"x-goog-api-key": key},
            json=body,
            timeout=120,
        )
        latency = int((time.perf_counter() - start_time) * 1000)
        if r.status_code >= 400:
            raise AIError(f"Gemini error {r.status_code}: {r.text[:300]}")
        res_json = r.json()
        text = res_json["candidates"][0]["content"]["parts"][0]["text"]
        usage = res_json.get("usageMetadata", {})
        return text, usage.get("promptTokenCount", 0), usage.get("candidatesTokenCount", 0), latency


def extract_with_usage(provider: str, model: Optional[str], key: Optional[str], data: bytes, mime: str, system_prompt: Optional[str] = None) -> tuple[dict, int, int, int]:
    provider, model, key = resolve(provider, model, key)
    sys = system_prompt or EXTRACTION_SYSTEM
    start_time = time.perf_counter()
    
    if provider == "anthropic":
        import anthropic
        client = anthropic.Anthropic(api_key=key)
        b64 = base64.standard_b64encode(data).decode()
        if mime == "application/pdf":
            source_block = {"type": "document", "source": {"type": "base64", "media_type": mime, "data": b64}}
        else:
            source_block = {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}}
        msg = client.messages.create(
            model=model,
            max_tokens=8000,
            system=sys,
            messages=[{"role": "user", "content": [source_block, {"type": "text", "text": "Extract the results as JSON."}]}],
        )
        text = "".join(b.text for b in msg.content if b.type == "text")
        latency = int((time.perf_counter() - start_time) * 1000)
        return _extract_json(text), msg.usage.input_tokens, msg.usage.output_tokens, latency
        
    elif provider == "openai":
        b64 = base64.standard_b64encode(data).decode()
        if mime == "application/pdf":
            content = [
                {"type": "file", "file": {"filename": "report.pdf", "file_data": f"data:application/pdf;base64,{b64}"}},
                {"type": "text", "text": "Extract the results as JSON."},
            ]
        else:
            content = [
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                {"type": "text", "text": "Extract the results as JSON."},
            ]
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": sys},
                {"role": "user", "content": content},
            ],
        }
        r = httpx.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json=body,
            timeout=120,
        )
        latency = int((time.perf_counter() - start_time) * 1000)
        if r.status_code >= 400:
            raise AIError(f"OpenAI error {r.status_code}: {r.text[:300]}")
        res_json = r.json()
        text = res_json["choices"][0]["message"]["content"]
        usage = res_json.get("usage", {})
        return _extract_json(text), usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0), latency
        
    else:  # gemini
        b64 = base64.standard_b64encode(data).decode()
        body = {
            "system_instruction": {"parts": [{"text": sys}]},
            "contents": [
                {
                    "parts": [
                        {"inline_data": {"mime_type": mime, "data": b64}},
                        {"text": "Extract the results as JSON."},
                    ]
                }
            ],
        }
        r = httpx.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            headers={"x-goog-api-key": key},
            json=body,
            timeout=120,
        )
        latency = int((time.perf_counter() - start_time) * 1000)
        if r.status_code >= 400:
            raise AIError(f"Gemini error {r.status_code}: {r.text[:300]}")
        res_json = r.json()
        text = res_json["candidates"][0]["content"]["parts"][0]["text"]
        usage = res_json.get("usageMetadata", {})
        return _extract_json(text), usage.get("promptTokenCount", 0), usage.get("candidatesTokenCount", 0), latency
