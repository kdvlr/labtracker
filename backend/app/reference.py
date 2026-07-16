"""Categorization + multi-zone interpretation bands for biomarkers.

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
