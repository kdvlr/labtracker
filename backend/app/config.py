import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("LABTRACKER_DATA", "./data")).resolve()
FILES_DIR = DATA_DIR / "files"
DB_PATH = DATA_DIR / "labtracker.db"

DATA_DIR.mkdir(parents=True, exist_ok=True)
FILES_DIR.mkdir(parents=True, exist_ok=True)
