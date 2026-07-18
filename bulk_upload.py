#!/usr/bin/env python3
import os
import sys
import argparse
import mimetypes
from datetime import date
import requests

def main():
    parser = argparse.ArgumentParser(description="Bulk upload lab reports to LabTracker")
    parser.add_argument("--url", default="http://localhost:8000", help="Base URL of your LabTracker instance (e.g. http://localhost:8000 or https://labs.dkiran.com)")
    parser.add_argument("--pin", required=True, help="Your device unlock PIN")
    parser.add_argument("--member-id", type=int, required=True, help="ID of the family member to upload results to")
    parser.add_argument("--dir", required=True, help="Directory containing the lab report files (PDFs/Images)")
    parser.add_argument("--force", action="store_true", help="Force upload of duplicate files")
    
    args = parser.parse_args()
    
    base_url = args.url.rstrip("/")
    
    # 1. Authenticate to retrieve member-scoped token
    print("Authenticating with PIN...")
    try:
        r = requests.post(f"{base_url}/api/unlock", json={"pin": args.pin, "scope": "member"})
        r.raise_for_status()
        token = r.json().get("token")
        if not token:
            print("Authentication failed: No token received.")
            sys.exit(1)
        print("Authenticated successfully!")
    except Exception as e:
        print(f"Failed to authenticate: {e}")
        sys.exit(1)
        
    headers = {"X-Unlock": token}
    
    # 2. Scan directory for valid files
    supported_exts = {".pdf", ".png", ".jpg", ".jpeg", ".webp"}
    files_to_process = []
    for f in os.listdir(args.dir):
        path = os.path.join(args.dir, f)
        if os.path.isfile(path):
            _, ext = os.path.splitext(f.lower())
            if ext in supported_exts:
                files_to_process.append(path)
                
    if not files_to_process:
        print(f"No supported files (PDF/Image) found in directory '{args.dir}'.")
        sys.exit(0)
        
    print(f"Found {len(files_to_process)} file(s) to process. Starting bulk import...\n")
    
    success_count = 0
    
    for i, file_path in enumerate(files_to_process, 1):
        filename = os.path.basename(file_path)
        print(f"[{i}/{len(files_to_process)}] Processing '{filename}'...")
        
        # Determine mime type
        mime, _ = mimetypes.guess_type(file_path)
        if not mime:
            if filename.lower().endswith(".pdf"):
                mime = "application/pdf"
            else:
                mime = "image/png"
                
        # A. Upload file
        try:
            with open(file_path, "rb") as f:
                upload_res = requests.post(
                    f"{base_url}/api/documents",
                    headers=headers,
                    files={"file": (filename, f, mime)},
                    data={"member_id": args.member_id}
                )
            
            # Handle duplicate conflict error (409)
            if upload_res.status_code == 409:
                detail = "This file has already been uploaded."
                try:
                    detail = upload_res.json().get("detail", detail)
                except Exception:
                    pass
                
                if args.force:
                    print(f"  ⚠️ Duplicate detected: {detail} -> Overriding (--force active)...")
                    with open(file_path, "rb") as f:
                        upload_res = requests.post(
                            f"{base_url}/api/documents?force=true",
                            headers=headers,
                            files={"file": (filename, f, mime)},
                            data={"member_id": args.member_id}
                        )
                    upload_res.raise_for_status()
                else:
                    print(f"  ⚠️ Duplicate skipped: {detail} (Use --force to override)")
                    continue
            else:
                upload_res.raise_for_status()
                
            doc = upload_res.json()
            doc_id = doc["id"]
            print(f"  -> Uploaded successfully (Document ID: {doc_id})")
        except Exception as e:
            print(f"  ❌ Upload failed: {e}")
            continue
            
        # B. Run extraction
        try:
            print("  -> Running AI extraction (can take ~20s)...")
            extract_res = requests.post(
                f"{base_url}/api/documents/{doc_id}/extract",
                headers=headers,
                json={}
            )
            extract_res.raise_for_status()
            extraction = extract_res.json()
        except Exception as e:
            print(f"  ❌ AI extraction failed: {e}")
            continue
            
        # C. Retrieve parsed items from the database table
        try:
            detail_res = requests.get(
                f"{base_url}/api/documents/{doc_id}/extraction",
                headers=headers
            )
            detail_res.raise_for_status()
            details = detail_res.json()
        except Exception as e:
            print(f"  ❌ Failed to retrieve extraction details: {e}")
            continue
            
        taken_at = details.get("report_date")
        if not taken_at:
            taken_at = date.today().isoformat()
            print(f"  ⚠️ Warning: No report date detected by AI. Defaulting to today: {taken_at}")
            
        # Prepare items for commit
        commit_items = []
        for it in details.get("items", []):
            if it.get("matched_test_type_id"):
                commit_items.append({
                    "test_type_id": it["matched_test_type_id"],
                    "value": it["value"],
                    "value_text": it["value_text"],
                    "unit": it["unit"] or "",
                    "qualifier": it["qualifier"],
                    "flag": it["flag"],
                    "ref_low": it["ref_low"],
                    "ref_high": it["ref_high"],
                    "note": None,
                    "document_item_id": it["id"]
                })
                
        if not commit_items:
            print("  ⚠️ No matched test types found in this document. Skipping save.")
            continue
            
        # D. Commit results
        try:
            print(f"  -> Committing {len(commit_items)} matched biomarkers to patient record...")
            commit_payload = {
                "member_id": args.member_id,
                "taken_at": taken_at,
                "document_id": doc_id,
                "force": True,
                "ignore_duplicates": True,
                "items": commit_items
            }
            commit_res = requests.post(
                f"{base_url}/api/results/commit",
                headers=headers,
                json=commit_payload
            )
            commit_res.raise_for_status()
            print(f"  ✓ Successfully imported '{filename}' into patient record!")
            success_count += 1
        except Exception as e:
            print(f"  ❌ Commit failed: {e}")
            continue
            
    print(f"\nImport finished! Successfully imported {success_count}/{len(files_to_process)} document(s).")

if __name__ == "__main__":
    main()
