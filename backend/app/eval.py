import json
import sqlite3
import traceback
from pathlib import Path
from typing import Optional

from . import ai
from .config import DB_PATH, FILES_DIR


JUDGE_SYSTEM = """You are an expert clinical reference judge evaluating medical Q&A systems.
You will be given:
1. The TASK TYPE ('qa' or 'health_analysis')
2. The INPUT prompt (context + question)
3. The GROUND TRUTH expected factual guidelines/answers
4. The CANDIDATE output

Evaluate the CANDIDATE output compared to the GROUND TRUTH on a scale from 1 to 5.
Scoring guide:
- 1: Inaccurate, misleading, contradicts ground truth, or clinically unsafe.
- 2: Mostly incorrect, misses key facts, lacks proper medical disclaimers.
- 3: Correct on basic facts, but has significant gaps, lacks completeness, or is poorly framed.
- 4: Mostly correct, covers all key facts from ground truth, minor wording differences or minor omissions.
- 5: Excellent, highly accurate, complete, covers all ground truth points, includes clinical context and appropriate safety caveats.

You must return ONLY a valid JSON object matching this schema:
{
  "score": <integer from 1 to 5>,
  "reason": "<2-3 sentence clinical reasoning explaining the score>"
}
Do not include any prose outside the JSON object. Do not include markdown fences."""


def _get_setting(conn, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return str(row["value"]) if row else default


def _ai_config(conn, override_provider=None, override_model=None):
    # Direct port of main.py's _ai_config to avoid circular import issues
    provider = override_provider or _get_setting(conn, "ai_provider", "anthropic")
    model = override_model or _get_setting(conn, f"ai_model_{provider}") or None
    key = _get_setting(conn, f"ai_key_{provider}")
    
    if not key:
        import os
        env_vars = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY"}
        key = os.environ.get(env_vars.get(provider, ""))
        
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


def evaluate_extraction(gt: dict, candidate: dict) -> float:
    score = 0.0
    total_checks = 0
    
    # 1. Report date (weight = 1)
    gt_date = gt.get("report_date")
    cand_date = candidate.get("report_date")
    total_checks += 1
    if gt_date == cand_date:
        score += 1.0
        
    # 2. Lab name (weight = 1)
    gt_lab = gt.get("lab_name")
    cand_lab = candidate.get("lab_name")
    total_checks += 1
    if str(gt_lab or "").lower().strip() == str(cand_lab or "").lower().strip():
        score += 1.0
        
    # 3. Results comparison
    gt_results = gt.get("results", [])
    cand_results = candidate.get("results", [])
    
    def _slug(n):
        import re
        return re.sub(r'[^a-z0-9]', '', str(n).lower())
        
    cand_map = {}
    for r in cand_results:
        slug = _slug(r.get("test_name", ""))
        if slug:
            cand_map[slug] = r
            
    for gt_r in gt_results:
        slug = _slug(gt_r.get("test_name", ""))
        if not slug:
            continue
            
        cand_r = cand_map.get(slug)
        total_checks += 5  # test value, unit, qualifier, ref_low, ref_high
        
        if not cand_r:
            continue
            
        # Value check
        gt_val = gt_r.get("value")
        cand_val = cand_r.get("value")
        gt_val_txt = gt_r.get("value_text")
        cand_val_txt = cand_r.get("value_text")
        
        if gt_val is not None:
            try:
                if cand_val is not None and abs(float(gt_val) - float(cand_val)) < 1e-5:
                    score += 1.0
            except (ValueError, TypeError):
                pass
        elif gt_val_txt is not None:
            if str(gt_val_txt).lower().strip() == str(cand_val_txt or "").lower().strip():
                score += 1.0
        else:
            if cand_val is None and cand_val_txt is None:
                score += 1.0
                
        # Unit check
        gt_unit = str(gt_r.get("unit") or "").lower().strip()
        cand_unit = str(cand_r.get("unit") or "").lower().strip()
        if gt_unit == cand_unit:
            score += 1.0
            
        # Qualifier check
        gt_qual = gt_r.get("qualifier")
        cand_qual = cand_r.get("qualifier")
        if gt_qual == cand_qual:
            score += 1.0
            
        # Ref low check
        gt_low = gt_r.get("ref_low")
        cand_low = cand_r.get("ref_low")
        if gt_low is not None:
            try:
                if cand_low is not None and abs(float(gt_low) - float(cand_low)) < 1e-5:
                    score += 1.0
            except (ValueError, TypeError):
                pass
        else:
            if cand_low is None:
                score += 1.0
                
        # Ref high check
        gt_high = gt_r.get("ref_high")
        cand_high = cand_r.get("ref_high")
        if gt_high is not None:
            try:
                if cand_high is not None and abs(float(gt_high) - float(cand_high)) < 1e-5:
                    score += 1.0
            except (ValueError, TypeError):
                pass
        else:
            if cand_high is None:
                score += 1.0
                
    if total_checks == 0:
        return 1.0
    return round(score / total_checks, 3)


def run_evaluation_task(run_id: int) -> None:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        # Load run config
        run = conn.execute("SELECT * FROM eval_runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            return
            
        baseline_provider = run["baseline_provider"]
        baseline_model = run["baseline_model"]
        candidate_provider = run["candidate_provider"]
        candidate_model = run["candidate_model"]
        
        # Load judge model settings (from active provider config)
        judge_provider, judge_model, judge_key = _ai_config(conn)
        
        # Resolve API keys for baseline and candidate
        _, _, baseline_key = _ai_config(conn, baseline_provider, baseline_model)
        _, _, candidate_key = _ai_config(conn, candidate_provider, candidate_model)
        
        # Fetch test cases
        cases = conn.execute("SELECT * FROM eval_cases").fetchall()
        
        for case in cases:
            case_id = case["id"]
            task_type = case["task_type"]
            
            # Re-initialize values per case
            b_out = None
            b_tokens_in = 0
            b_tokens_out = 0
            b_latency = 0
            b_score = 0.0
            b_err = None
            
            c_out = None
            c_tokens_in = 0
            c_tokens_out = 0
            c_latency = 0
            c_score = 0.0
            c_err = None
            
            explanation = ""
            
            try:
                # ---------------- Extraction ----------------
                if task_type == "extraction":
                    # Load document bytes
                    doc = conn.execute("SELECT * FROM documents WHERE id = ?", (case["input_id"],)).fetchone()
                    if not doc:
                        raise ValueError(f"Document {case['input_id']} missing for extraction case")
                        
                    file_path = FILES_DIR / doc["stored_name"]
                    data = file_path.read_bytes()
                    mime = doc["mime"]
                    gt_json = json.loads(case["ground_truth"])
                    
                    # 1. Run Baseline
                    try:
                        b_dict, b_tokens_in, b_tokens_out, b_latency = ai.extract_with_usage(
                            baseline_provider, baseline_model, baseline_key, data, mime
                        )
                        b_out = json.dumps(b_dict, indent=2)
                        b_score = evaluate_extraction(gt_json, b_dict)
                    except Exception as e:
                        b_err = f"{type(e).__name__}: {str(e)}"
                        
                    # 2. Run Candidate
                    try:
                        c_dict, c_tokens_in, c_tokens_out, c_latency = ai.extract_with_usage(
                            candidate_provider, candidate_model, candidate_key, data, mime
                        )
                        c_out = json.dumps(c_dict, indent=2)
                        c_score = evaluate_extraction(gt_json, c_dict)
                    except Exception as e:
                        c_err = f"{type(e).__name__}: {str(e)}"
                        
                    explanation = "Automatic key-value extraction accuracy scoring against ground truth."
                    
                # ---------------- Text Generation (QA / Analysis) ----------------
                elif task_type in ("qa", "health_analysis"):
                    input_data = json.loads(case["input_text"])
                    gt = case["ground_truth"]
                    
                    # Formulate parameters
                    if task_type == "qa":
                        system_prompt = ai.QA_SYSTEM
                        prompt = f"Historical lab data:\n{input_data['context']}\n\nQuestion: {input_data['question']}"
                    else:  # health_analysis
                        system_prompt = ai.HEALTH_ANALYSIS_SYSTEM
                        prompt = f"Historical lab data:\n{input_data['context']}"
                        
                    # 1. Run Baseline
                    try:
                        b_out, b_tokens_in, b_tokens_out, b_latency = ai.chat_with_usage(
                            baseline_provider, baseline_model, baseline_key, system_prompt, prompt
                        )
                    except Exception as e:
                        b_err = f"{type(e).__name__}: {str(e)}"
                        
                    # 2. Run Candidate
                    try:
                        c_out, c_tokens_in, c_tokens_out, c_latency = ai.chat_with_usage(
                            candidate_provider, candidate_model, candidate_key, system_prompt, prompt
                        )
                    except Exception as e:
                        c_err = f"{type(e).__name__}: {str(e)}"
                        
                    # 3. Judge Baseline Output
                    if b_out and not b_err:
                        try:
                            judge_prompt = f"TASK TYPE: {task_type}\nINPUT PROMPT: {prompt}\nGROUND TRUTH: {gt}\nCANDIDATE OUTPUT: {b_out}"
                            judge_raw, _, _, _ = ai.chat_with_usage(
                                judge_provider, judge_model, judge_key, JUDGE_SYSTEM, judge_prompt
                            )
                            judge_res = ai._extract_json(judge_raw)
                            b_score = float(judge_res.get("score", 1))
                            explanation += f"Baseline Score: {b_score}/5. Reason: {judge_res.get('reason', '')}\n\n"
                        except Exception as je:
                            explanation += f"Baseline Judge Error: {str(je)}\n\n"
                            b_score = 1.0
                            
                    # 4. Judge Candidate Output
                    if c_out and not c_err:
                        try:
                            judge_prompt = f"TASK TYPE: {task_type}\nINPUT PROMPT: {prompt}\nGROUND TRUTH: {gt}\nCANDIDATE OUTPUT: {c_out}"
                            judge_raw, _, _, _ = ai.chat_with_usage(
                                judge_provider, judge_model, judge_key, JUDGE_SYSTEM, judge_prompt
                            )
                            judge_res = ai._extract_json(judge_raw)
                            c_score = float(judge_res.get("score", 1))
                            explanation += f"Candidate Score: {c_score}/5. Reason: {judge_res.get('reason', '')}"
                        except Exception as je:
                            explanation += f"Candidate Judge Error: {str(je)}"
                            c_score = 1.0
                            
            except Exception as case_exc:
                explanation = f"Failure during evaluation: {str(case_exc)}"
                
            # Insert case result
            conn.execute(
                """INSERT INTO eval_run_results (
                    run_id, case_id,
                    baseline_output, baseline_tokens_in, baseline_tokens_out, baseline_latency_ms, baseline_score, baseline_error,
                    candidate_output, candidate_tokens_in, candidate_tokens_out, candidate_latency_ms, candidate_score, candidate_error,
                    judge_explanation
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    run_id, case_id,
                    b_out, b_tokens_in, b_tokens_out, b_latency, b_score, b_err,
                    c_out, c_tokens_in, c_tokens_out, c_latency, c_score, c_err,
                    explanation
                )
            )
            conn.commit()
            
        # Update run status to completed
        conn.execute("UPDATE eval_runs SET status = 'completed' WHERE id = ?", (run_id,))
        conn.commit()
        
    except Exception as run_exc:
        err_msg = f"{type(run_exc).__name__}: {str(run_exc)}\n{traceback.format_exc()}"
        conn.execute("UPDATE eval_runs SET status = 'failed', error_message = ? WHERE id = ?", (err_msg, run_id))
        conn.commit()
    finally:
        conn.close()
