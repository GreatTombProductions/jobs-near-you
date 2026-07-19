#!/usr/bin/env python3
"""
Jobs Near You — pipeline.

Downloads Census LODES8 WAC (Workplace Area Characteristics) data for all 50
states + DC, joins with crosswalk to county FIPS, aggregates block-level job
counts to county-level summaries with industry/age/earnings breakdowns.

Output: static-site shards for GitHub Pages.
  - letter-sharded county search index
  - MD5-keyed county detail shards
  - per-state county rankings by total jobs
  - proximity shards (county centroids from neighborhood-health)

~220MB total download → ~3,100 counties with 20 industry sectors + demographics.
Pipeline: ~5-10min (download dominates). Data vintage: LODES 8.4, 2023.
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import json
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(line_buffering=True)

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
RAW_DIR = Path("/tmp/lodes-jobs")
SITE_DIR = PROJECT_DIR / "site"
DATA_DIR = SITE_DIR / "data"
DETAIL_DIR = DATA_DIR / "details"
SEARCH_DIR = DATA_DIR / "search"
STATE_DIR = DATA_DIR / "states"
PROX_DIR = DATA_DIR / "proximity"

LODES_BASE = "https://lehd.ces.census.gov/data/lodes/LODES8"
YEAR = 2023
NUM_DETAIL_SHARDS = 256

STATES = [
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "dc", "fl",
    "ga", "hi", "id", "il", "in", "ia", "ks", "ky", "la", "me",
    "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh",
    "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri",
    "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy",
]

STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii",
    "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming",
}

# LODES CNS (NAICS sector) columns → labels
INDUSTRY_LABELS = {
    "CNS01": "Agriculture, Forestry, Fishing and Hunting",
    "CNS02": "Mining, Quarrying, and Oil and Gas Extraction",
    "CNS03": "Utilities",
    "CNS04": "Construction",
    "CNS05": "Manufacturing",
    "CNS06": "Wholesale Trade",
    "CNS07": "Retail Trade",
    "CNS08": "Transportation and Warehousing",
    "CNS09": "Information",
    "CNS10": "Finance and Insurance",
    "CNS11": "Real Estate and Rental and Leasing",
    "CNS12": "Professional, Scientific, and Technical Services",
    "CNS13": "Management of Companies and Enterprises",
    "CNS14": "Admin & Support, Waste Management and Remediation",
    "CNS15": "Educational Services",
    "CNS16": "Health Care and Social Assistance",
    "CNS17": "Arts, Entertainment, and Recreation",
    "CNS18": "Accommodation and Food Services",
    "CNS19": "Other Services (except Public Administration)",
    "CNS20": "Public Administration",
}

AGE_LABELS = {
    "CA01": "Age 29 or younger",
    "CA02": "Age 30 to 54",
    "CA03": "Age 55 or older",
}

EARNINGS_LABELS = {
    "CE01": "$1,250/month or less",
    "CE02": "$1,251 to $3,333/month",
    "CE03": "More than $3,333/month",
}


def download(url: str, dest: Path) -> None:
    """Download a file with progress."""
    if dest.exists():
        print(f"  (cached) {dest.name}")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  downloading {dest.name}...", end=" ", flush=True)
    urllib.request.urlretrieve(url, dest)
    size_mb = dest.stat().st_size / (1024 * 1024)
    print(f"{size_mb:.1f}MB")


def download_state_data(state: str) -> tuple[Path, Path]:
    """Download WAC and crosswalk for a state. Returns (wac_path, xwalk_path)."""
    state_raw = RAW_DIR / state
    state_raw.mkdir(parents=True, exist_ok=True)

    wac_url = f"{LODES_BASE}/{state}/wac/{state}_wac_S000_JT00_{YEAR}.csv.gz"
    xwalk_url = f"{LODES_BASE}/{state}/{state}_xwalk.csv.gz"

    wac_path = state_raw / f"{state}_wac_S000_JT00_{YEAR}.csv.gz"
    xwalk_path = state_raw / f"{state}_xwalk.csv.gz"

    download(wac_url, wac_path)
    download(xwalk_url, xwalk_path)

    return wac_path, xwalk_path


def process_state(state: str, wac_path: Path, xwalk_path: Path) -> dict[str, dict]:
    """
    Process a single state's data. Returns dict of county_fips → aggregated job stats.

    Joins WAC block-level data to crosswalk (block → county FIPS), aggregates.
    """
    # Build block → county FIPS + county name map from crosswalk
    print(f"  building crosswalk...", end=" ", flush=True)
    block_to_county: dict[str, tuple[str, str]] = {}  # block → (fips, name)
    with gzip.open(xwalk_path, "rt", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        for row in reader:
            blk = row.get("tabblk2020", "").strip()
            fips = row.get("cty", "").strip()
            name = row.get("ctyname", "").strip()
            if blk and fips:
                block_to_county[blk] = (fips, name)

    print(f"{len(block_to_county)} blocks", end=" ", flush=True)

    # Read WAC data, aggregate to county
    county_jobs: dict[str, dict] = defaultdict(lambda: {
        "total": 0,
        "industries": defaultdict(int),
        "ages": defaultdict(int),
        "earnings": defaultdict(int),
        "county_name": "",
    })

    matched = 0
    unmatched = 0
    with gzip.open(wac_path, "rt", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        for row in reader:
            blk = row.get("w_geocode", "").strip()
            if not blk:
                continue

            county_info = block_to_county.get(blk)
            if not county_info:
                unmatched += 1
                continue
            matched += 1

            fips, name = county_info
            c = county_jobs[fips]
            c["county_name"] = name

            # Total jobs
            total = int(row.get("C000", 0) or 0)
            c["total"] += total

            # Industry breakdown
            for col, label in INDUSTRY_LABELS.items():
                val = int(row.get(col, 0) or 0)
                if val:
                    c["industries"][col] += val

            # Age breakdown
            for col, label in AGE_LABELS.items():
                val = int(row.get(col, 0) or 0)
                if val:
                    c["ages"][col] += val

            # Earnings breakdown
            for col, label in EARNINGS_LABELS.items():
                val = int(row.get(col, 0) or 0)
                if val:
                    c["earnings"][col] += val

    print(f"→ {len(county_jobs)} counties ({matched} matched, {unmatched} unmatched)")

    return dict(county_jobs)


def build_site(all_counties: dict[str, dict]) -> None:
    """Build all static site shards from county data."""
    counties = [
        (fips, data)
        for fips, data in all_counties.items()
        if data["total"] > 0
    ]
    counties.sort(key=lambda x: x[1]["total"], reverse=True)

    total_us_jobs = sum(c[1]["total"] for c in counties)
    total_counties = len(counties)
    print(f"\nTotal: {total_us_jobs:,} jobs across {total_counties} counties")

    # Compute national medians for comparison
    all_totals = sorted(c[1]["total"] for c in counties)
    median_jobs = all_totals[len(all_totals) // 2]

    # Collect all industry totals across all counties for national comparison
    national_industry: dict[str, int] = defaultdict(int)
    for _, data in counties:
        for col, val in data["industries"].items():
            national_industry[col] += val

    for dirpath in [DETAIL_DIR, SEARCH_DIR, STATE_DIR, PROX_DIR]:
        dirpath.mkdir(parents=True, exist_ok=True)

    # --- Letter-sharded search index ---
    print("Building search index...")
    letter_buckets: dict[str, list] = defaultdict(list)
    for fips, data in counties:
        name = data["county_name"]
        state_abbr = fips_to_state(fips)
        first = name[0].upper() if name else "?"
        letter_buckets[first].append({
            "f": fips,
            "n": name,
            "s": state_abbr,
            "t": data["total"],
        })

    for letter, entries in letter_buckets.items():
        entries.sort(key=lambda x: x["t"], reverse=True)
        shard = letter if letter.isalpha() else "other"
        with open(SEARCH_DIR / f"search_{shard}.json", "w") as f:
            json.dump(entries, f)

    # --- MD5-keyed detail shards ---
    print("Building detail shards...")
    detail_shards: dict[str, dict] = defaultdict(dict)
    for fips, data in counties:
        shard_key = hashlib.md5(fips.encode()).hexdigest()[:2]
        # Build industry list sorted by job count
        industries = [
            {"code": col, "label": INDUSTRY_LABELS[col], "jobs": val}
            for col, val in sorted(data["industries"].items(), key=lambda x: -x[1])
        ]
        # Age breakdown
        ages = [
            {"code": col, "label": AGE_LABELS[col], "jobs": int(data["ages"].get(col, 0))}
            for col in ["CA01", "CA02", "CA03"]
        ]
        # Earnings breakdown
        earnings = [
            {"code": col, "label": EARNINGS_LABELS[col], "jobs": int(data["earnings"].get(col, 0))}
            for col in ["CE01", "CE02", "CE03"]
        ]
        detail_shards[shard_key][fips] = {
            "n": data["county_name"],
            "s": fips_to_state(fips),
            "t": data["total"],
            "ind": industries,
            "age": ages,
            "earn": earnings,
        }

    for shard_key, entries in detail_shards.items():
        with open(DETAIL_DIR / f"detail_{shard_key}.json", "w") as f:
            json.dump(entries, f)

    # --- State browse ---
    print("Building state browse...")
    state_buckets: dict[str, list] = defaultdict(list)
    for fips, data in counties:
        st = fips_to_state(fips)
        state_buckets[st].append({
            "f": fips,
            "n": data["county_name"],
            "t": data["total"],
        })

    for st, entries in state_buckets.items():
        entries.sort(key=lambda x: x["t"], reverse=True)
        with open(STATE_DIR / f"state_{st}.json", "w") as f:
            json.dump({
                "state": st,
                "state_name": STATE_NAMES.get(st, st),
                "total_jobs": sum(e["t"] for e in entries),
                "counties": entries,
            }, f)

    # --- Proximity shards (copy centroids from neighborhood-health) ---
    print("Building proximity shards...")
    nh_centroids = (
        Path("/home/ray/greattomb/0th-floor-exterior/east-mausoleum/projects/neighborhood-health/site/data/details")
    )
    prox_entries: list[dict] = []
    if nh_centroids.exists():
        for shard_file in sorted(nh_centroids.glob("detail_*.json")):
            with open(shard_file) as f:
                shard_data = json.load(f)
            for fips, nh_detail in shard_data.items():
                lat = nh_detail.get("lat")
                lon = nh_detail.get("lon")
                if lat is not None and lon is not None and fips in all_counties:
                    data = all_counties[fips]
                    prox_entries.append({
                        "f": fips,
                        "n": data["county_name"],
                        "s": fips_to_state(fips),
                        "t": data["total"],
                        "lat": lat,
                        "lon": lon,
                    })
        print(f"  {len(prox_entries)} counties with centroids from neighborhood-health")
    else:
        print("  WARNING: neighborhood-health centroids not found, proximity search disabled")
        # Build without centroids — proximity will be unavailable
        for fips, data in counties:
            prox_entries.append({
                "f": fips,
                "n": data["county_name"],
                "s": fips_to_state(fips),
                "t": data["total"],
                "lat": 0,
                "lon": 0,
            })

    # Write proximity as one file (small enough at county level)
    with open(PROX_DIR / "proximity.json", "w") as f:
        json.dump(prox_entries, f)

    # --- Meta ---
    meta = {
        "total_jobs_us": total_us_jobs,
        "total_counties": total_counties,
        "median_county_jobs": median_jobs,
        "data_year": YEAR,
        "data_source": "Census LODES 8.4 (LEHD Origin-Destination Employment Statistics)",
        "data_url": "https://lehd.ces.census.gov/data/lodes/LODES8/",
        "national_industry": {
            col: {"label": INDUSTRY_LABELS[col], "jobs": national_industry.get(col, 0)}
            for col in INDUSTRY_LABELS
            if national_industry.get(col, 0) > 0
        },
        "industry_labels": INDUSTRY_LABELS,
        "age_labels": AGE_LABELS,
        "earnings_labels": EARNINGS_LABELS,
        "detail_shards": NUM_DETAIL_SHARDS,
        "search_letters": sorted(letter_buckets.keys()),
        "states": sorted(state_buckets.keys()),
        "proximity_available": nh_centroids.exists(),
    }
    with open(DATA_DIR / "meta.json", "w") as f:
        json.dump(meta, f)

    # --- Site size summary ---
    total_site = 0
    for fpath in sorted(DATA_DIR.rglob("*.json")):
        total_site += fpath.stat().st_size
    print(f"\nSite data: {total_site / (1024*1024):.1f}MB ({total_site / 1024:.0f}KB)")


def fips_to_state(fips: str) -> str:
    """Extract state abbreviation from county FIPS code."""
    if len(fips) < 2:
        return "??"
    state_fips = fips[:2]
    # FIPS → USPS mapping
    fips_map = {
        "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA",
        "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
        "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN",
        "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME",
        "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS",
        "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
        "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND",
        "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
        "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
        "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI",
        "56": "WY",
    }
    return fips_map.get(state_fips, "??")


def main():
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Jobs Near You — LODES8 WAC {YEAR}")
    print(f"Downloading {len(STATES)} states...\n")

    all_counties: dict[str, dict] = {}

    for i, state in enumerate(STATES):
        print(f"[{i+1}/{len(STATES)}] {state.upper()}")
        try:
            wac_path, xwalk_path = download_state_data(state)
            state_counties = process_state(state, wac_path, xwalk_path)
            all_counties.update(state_counties)
        except Exception as e:
            print(f"  ERROR: {e}")
            continue

    print(f"\n{len(all_counties)} total counties across all states")
    build_site(all_counties)
    print("\nDone.")


if __name__ == "__main__":
    main()
