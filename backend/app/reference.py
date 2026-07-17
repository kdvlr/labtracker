"""Categorization, sex/age reference ranges, and multi-zone bands for biomarkers.

`categorize` maps a test name to a panel/category by keyword. `ZONES` holds
ordered interpretation bands (in canonical units) for well-known markers that
have more than a simple in/out range — e.g. HbA1c's normal / pre-diabetic /
diabetic. Each zone: {"to": upper_bound_or_null, "c": "green|amber|red", "label"}.
Zones are ascending; the last has "to": null meaning +infinity.
"""

# First keyword hit wins — order matters (specific panels before generic ones).
_RULES = [
    ("Heavy Metals", [
        "lead", "mercury", "arsenic", "cadmium", "chromium", "cobalt", "nickel",
        "aluminium", "aluminum", "manganese", "selenium", "zinc", "copper",
        "antimony", "barium", "bismuth", "caesium", "cesium", "thallium",
        "uranium", "strontium", "molybdenum", "silver", "vanadium", "beryllium",
        "tin", "gadolinium", "gold", "platinum", "tungsten", "boron",
    ]),
    ("Urine", ["urinary", "epithelial", "pus cell", "specific gravity", "microalbumin", "albumin/creatinine", "albumin / creatinine"]),
    ("Heart", [
        "cholesterol", "hdl", "ldl", "vldl", "triglyceride", "lipoprotein",
        "apolipoprotein", "apo b", "apo a", "apob", "apoa", "homocysteine",
        "troponin", "non-hdl", "tc/", "trig /",
    ]),
    ("Liver", [
        "alt", "sgpt", "ast", "sgot", "ggt", "gamma glutamyl", "bilirubin",
        "alkaline phosphatase", "albumin", "globulin", "total protein",
        "protein - total", "a/g ratio", "alb/globulin", "alanine", "aspartate",
        "transaminase",
    ]),
    ("Kidney", ["creatinine", "urea", "bun", "egfr", "glomerular", "uric acid", "cystatin"]),
    ("Thyroid", ["tsh", "thyroid", "triiodothyronine", "thyroxine", "t3", "t4", "ft3", "ft4", "tpo", "thyroglobulin"]),
    ("Metabolic", ["glucose", "hba1c", "a1c", "insulin", "c-peptide", "fructosamine", "blood sugar", "(abg)"]),
    ("Iron", ["iron", "ferritin", "transferrin", "tibc", "uibc"]),
    ("Bone Health", ["calcium", "phosphorus", "phosphate", "bone"]),
    ("Minerals", ["sodium", "potassium", "chloride", "magnesium", "bicarbonate"]),
    ("Vitamins", ["vitamin", "folate", "folic", "cobalamin", "b12", "b-12", "25-oh", "25-hydroxy"]),
    ("Hormones", ["testosterone", "estrogen", "estradiol", "progesterone", "cortisol", "dhea", "fsh", "lh ", "prolactin", "shbg", "psa"]),
    ("Inflammation", ["c-reactive", "hs-crp", "crp", "esr", "sedimentation"]),
    ("Blood", [
        "hemoglobin", "haemoglobin", "hematocrit", "haematocrit", "rbc", "wbc",
        "platelet", "mcv", "mch", "mchc", "rdw", "neutrophil", "lymphocyte",
        "monocyte", "eosinophil", "basophil", "granulocyte", "nucleated",
        "leucocyte", "leukocyte", "pcv", "mpv", "pdw", "plcr", "p-lcr",
        "plateletcrit", "red cell", "red blood", "distribution width",
        "corpuscular", "mentzer", "immature",
    ]),
]


def categorize(name: str) -> str:
    n = (name or "").lower()
    for cat, kws in _RULES:
        for kw in kws:
            if kw in n:
                return cat
    return "Other"


# Curated multi-zone bands are reserved for markers where a green/amber/red
# staging is a universally recognized clinical standard that adds information
# beyond a lab's binary cutoff — i.e. the pre-diabetic/diabetic staging of HbA1c
# and fasting glucose. Everything else uses the lab's own reference range
# (binary in/out), which is the authority. Adding a marker here deliberately
# overrides that lab range with staged bands, so only do it when the staging is
# standard AND the lab's cutoff would otherwise hide a meaningful "borderline".
# ---------------------------------------------------------------------------
# Sex/age-specific fallback reference ranges (canonical units).
#
# Used ONLY when a report prints no range of its own. Several common markers are
# strongly sex-dimorphic and age-dependent, so a single adult-male default would
# mis-flag women and children — the exact failure a family tracker must avoid.
#
# Each variant: sex ("female"/"male"/None=any), age_min/age_max in years
# (inclusive lower, exclusive upper, None=unbounded), low/high (None=unbounded).
# These are widely-used adult/pediatric defaults, not medical advice.
# ---------------------------------------------------------------------------
REF_VARIANTS = {
    "hemoglobin": [
        {"age_min": None, "age_max": 1, "low": 10.5, "high": 13.5},
        {"age_min": 1, "age_max": 6, "low": 11.0, "high": 14.0},
        {"age_min": 6, "age_max": 12, "low": 11.5, "high": 15.5},
        {"sex": "female", "age_min": 12, "age_max": 18, "low": 12.0, "high": 16.0},
        {"sex": "male", "age_min": 12, "age_max": 18, "low": 13.0, "high": 16.0},
        {"sex": "female", "age_min": 18, "age_max": None, "low": 12.0, "high": 15.5},
        {"sex": "male", "age_min": 18, "age_max": None, "low": 13.5, "high": 17.5},
    ],
    "ferritin": [
        {"age_min": None, "age_max": 18, "low": 10, "high": 140},
        {"sex": "female", "age_min": 18, "age_max": None, "low": 15, "high": 150},
        {"sex": "male", "age_min": 18, "age_max": None, "low": 30, "high": 400},
    ],
    "creatinine": [
        {"age_min": None, "age_max": 3, "low": 0.2, "high": 0.5},
        {"age_min": 3, "age_max": 18, "low": 0.3, "high": 0.9},
        {"sex": "female", "age_min": 18, "age_max": None, "low": 0.59, "high": 1.04},
        {"sex": "male", "age_min": 18, "age_max": None, "low": 0.74, "high": 1.35},
    ],
    "hdl": [
        {"sex": "female", "age_min": 18, "age_max": None, "low": 50, "high": None},
        {"sex": "male", "age_min": 18, "age_max": None, "low": 40, "high": None},
    ],
    "alt": [
        {"sex": "female", "age_min": 18, "age_max": None, "low": None, "high": 33},
        {"sex": "male", "age_min": 18, "age_max": None, "low": None, "high": 41},
    ],
    "ast": [
        {"sex": "female", "age_min": 18, "age_max": None, "low": None, "high": 32},
        {"sex": "male", "age_min": 18, "age_max": None, "low": None, "high": 40},
    ],
}


def age_at(dob: str, on_date: str = None):
    """Whole years between `dob` and `on_date` (both YYYY-MM-DD), or None."""
    from datetime import date

    if not dob:
        return None
    try:
        born = date.fromisoformat(str(dob)[:10])
    except ValueError:
        return None
    try:
        ref = date.fromisoformat(str(on_date)[:10]) if on_date else date.today()
    except (ValueError, TypeError):
        ref = date.today()
    years = ref.year - born.year - ((ref.month, ref.day) < (born.month, born.day))
    return years if years >= 0 else None


def _sex_ok(variant, sex):
    want = variant.get("sex")
    return want is None or sex is None or str(sex).lower() == want


def _age_ok(variant, age):
    if age is None:
        return True  # unknown age matches every band; we widen below
    lo, hi = variant.get("age_min"), variant.get("age_max")
    if lo is not None and age < lo:
        return False
    if hi is not None and age >= hi:
        return False
    return True


def resolve_range(slug, base_low, base_high, sex=None, age=None):
    """Pick the fallback reference range for a member.

    With an exact sex+age match, use that band. When sex or age is unknown the
    match is ambiguous, so we return the *union* of the candidate bands (widest
    low/high) — a range that never flags something as abnormal just because we
    had to guess. Falls back to the catalog range when the marker has no
    variants.
    """
    variants = REF_VARIANTS.get(slug)
    if not variants:
        return base_low, base_high
    candidates = [v for v in variants if _sex_ok(v, sex) and _age_ok(v, age)]
    if not candidates:
        return base_low, base_high
    if len(candidates) == 1:
        return candidates[0].get("low"), candidates[0].get("high")
    lows = [v.get("low") for v in candidates]
    highs = [v.get("high") for v in candidates]
    low = None if any(x is None for x in lows) else min(lows)
    high = None if any(x is None for x in highs) else max(highs)
    return low, high


ZONES = {
    "hba1c": [
        {"to": 5.7, "c": "green", "label": "Normal"},
        {"to": 6.5, "c": "amber", "label": "Pre-diabetic"},
        {"to": None, "c": "red", "label": "Diabetic"},
    ],
    "glucose-fasting": [
        {"to": 70, "c": "red", "label": "Low"},
        {"to": 100, "c": "green", "label": "Normal"},
        {"to": 126, "c": "amber", "label": "Pre-diabetic"},
        {"to": None, "c": "red", "label": "Diabetic"},
    ],
}
