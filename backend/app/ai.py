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
      "value": number,
      "unit": "string, e.g. mg/dL",
      "ref_low": number or null,
      "ref_high": number or null,
      "flag": "H, L, or null"
    }
  ]
}
Rules: numbers must be numeric (not strings). Omit qualitative/textual results
you cannot express as a number. If a reference range is printed as "70-99",
split into ref_low and ref_high. Use the report's collection/report date."""

QA_SYSTEM = """You are a careful assistant helping someone understand their (or
their family's) lab test results over time. You are given structured historical
data. Answer the user's question grounded ONLY in that data. Note trends,
in/out-of-range values, and unit context. Be concise. Always add a brief reminder
that this is not medical advice and they should consult a clinician for decisions."""

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

def _anthropic_extract(key: str, model: str, data: bytes, mime: str) -> dict:
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
        system=EXTRACTION_SYSTEM,
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

def _openai_extract(key: str, model: str, data: bytes, mime: str) -> dict:
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
            {"role": "system", "content": EXTRACTION_SYSTEM},
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

def _gemini_extract(key: str, model: str, data: bytes, mime: str) -> dict:
    b64 = base64.standard_b64encode(data).decode()
    body = {
        "system_instruction": {"parts": [{"text": EXTRACTION_SYSTEM}]},
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


def extract(provider: str, model: Optional[str], key: Optional[str], data: bytes, mime: str) -> dict:
    provider, model, key = resolve(provider, model, key)
    if provider == "anthropic":
        return _anthropic_extract(key, model, data, mime)
    if provider == "openai":
        return _openai_extract(key, model, data, mime)
    return _gemini_extract(key, model, data, mime)


def chat(provider: str, model: Optional[str], key: Optional[str], system: str, prompt: str) -> str:
    provider, model, key = resolve(provider, model, key)
    if provider == "anthropic":
        return _anthropic_chat(key, model, system, prompt)
    if provider == "openai":
        return _openai_chat(key, model, system, prompt)
    return _gemini_chat(key, model, system, prompt)
