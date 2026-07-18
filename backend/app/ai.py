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
data. Answer the user's question grounded ONLY in that data. Note trends,
in/out-of-range values, and unit context. Be concise. Always add a brief reminder
that this is not medical advice and they should consult a clinician for decisions."""

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

PRIORITISATION: rank problems by (a) how far the LATEST value is out of range and how clinically serious it is, then (b) the recent (short-term) trajectory — a recent adverse turn raises priority, a recent improvement of a long-standing issue lowers it. A marker getting worse right now outranks one that has been stably mildly-abnormal forever.

Also:
- CONNECT MARKERS across panels. Look for multi-marker patterns a single-test view would miss (e.g. low MCV + low MCH + low ferritin suggests iron-deficiency anaemia; high glucose + high HbA1c + high triglycerides suggests metabolic syndrome). Naming these patterns is among the most valuable things you do.
- Judge SIGNIFICANCE and AGE-CONTEXT. Some out-of-range values are clinically trivial; some in-range values are notable given age or trajectory.
- Be SPECIFIC and ACTIONABLE. Concrete, plain-language next steps (dietary, lifestyle, "ask your doctor about X"). Avoid vague advice.
- Be HONEST but NOT ALARMIST. Do not catastrophize. Where things are fine, say so plainly. Never diagnose; frame concerns as "worth discussing with a doctor."

You MUST return ONLY a valid JSON object, no prose outside it, no markdown fences, matching this schema:
{
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
  "doctor_questions": ["Specific question to raise at the next appointment."],
  "disclaimer": "A one-line reminder that this is not a diagnosis and a clinician should be consulted."
}
Rules: severity must be one of urgent/monitor/minor; trend fields must use the exact allowed words. Order problem_areas most-important first using the prioritisation above. Only include a marker in "trends" when it has more than one reading (a real trajectory); use "insufficient" for long_term_trend when there is too little history. If there are no genuine current concerns, return an empty problem_areas array and say so warmly in the headline. Every claim must be grounded in the data provided — do not invent values."""

DEFAULT_MODELS = {
    "anthropic": "claude-opus-4-8",
    "openai": "gpt-4o",
    "gemini": "gemini-2.0-flash",
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
