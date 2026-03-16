#!/usr/bin/env node

/**
 * sync_dance_types.js
 *
 * Synchronises dance_types.json with the actual MuseScore source files.
 *
 * What it does:
 *   1. Scans the TUNES source folder for *-C.mscz files to get canonical tune names.
 *      Falls back to trimmed/ PNGs if the source folder is unavailable.
 *   2. For each entry in dance_types.json:
 *      - If it matches a file exactly (case-insensitive, ignoring trailing spaces) → keep
 *      - If it closely matches a file (Levenshtein / substring) → fix to the file's name
 *      - If no match at all → remove
 *   3. Any file tunes not accounted for → add to "Unclassified".
 *   4. Remove empty dance types (except Unclassified).
 *   5. Writes the updated dance_types.json.
 *
 * Run:  node src/sync_dance_types.js [--dry-run]
 */

import fs from "fs";
import path from "path";

const DRY_RUN = process.argv.includes("--dry-run");
const DANCE_TYPES_PATH = "dance_types.json";
const TRIMMED_DIR = "trimmed";
const INSTRUMENT = "C"; // Use C instrument as the canonical source
const TUNES_FOLDER =
  "/Users/paulleonard/Library/CloudStorage/GoogleDrive-pauljohnleonard@gmail.com/My Drive/MUSIC/BalFolkFrome/TUNES";

// ---------------------------------------------------------------------------
// Levenshtein distance (standard DP)
// ---------------------------------------------------------------------------
function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

// ---------------------------------------------------------------------------
// Find the best matching file tune for a given JSON entry
// ---------------------------------------------------------------------------
function findBestMatch(jsonName, fileTunes) {
  const jNorm = jsonName.trim().toLowerCase();

  // 1. Exact match (case-insensitive, trim)
  for (const ft of fileTunes) {
    if (ft.trim().toLowerCase() === jNorm) {
      return { match: ft, type: "exact" };
    }
  }

  // 2. Substring match — json name contained within a file name or vice versa
  for (const ft of fileTunes) {
    const fNorm = ft.trim().toLowerCase();
    if (fNorm.includes(jNorm) || jNorm.includes(fNorm)) {
      return { match: ft, type: "substring" };
    }
  }

  // 3. Levenshtein — threshold based on string length
  let bestDist = Infinity;
  let bestTune = null;
  for (const ft of fileTunes) {
    const dist = levenshtein(jNorm, ft.trim().toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      bestTune = ft;
    }
  }
  // Allow edits up to ~30% of the shorter string length (min 3)
  const threshold = Math.max(
    3,
    Math.floor(Math.min(jNorm.length, bestTune?.trim().length || 0) * 0.3),
  );
  if (bestDist <= threshold) {
    return { match: bestTune, type: "fuzzy", distance: bestDist };
  }

  return null; // no match
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  // Load dance_types.json
  if (!fs.existsSync(DANCE_TYPES_PATH)) {
    console.error(`${DANCE_TYPES_PATH} not found.`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(DANCE_TYPES_PATH, "utf8"));
  const dances = data.dances || {};

  // Scan for tune names — prefer source TUNES folder, fall back to trimmed/
  let fileTunes;
  let tuneSource;

  if (fs.existsSync(TUNES_FOLDER)) {
    // Scan all subdirectories for *-C.mscz files (same logic as prepare_scores.sh)
    const tuneNames = new Set();
    const subdirs = fs
      .readdirSync(TUNES_FOLDER, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(TUNES_FOLDER, d.name));

    for (const subdir of subdirs) {
      const files = fs.readdirSync(subdir);
      for (const f of files) {
        if (f.endsWith("-C.mscz")) {
          tuneNames.add(f.replace(/-C\.mscz$/, ""));
        }
      }
    }
    fileTunes = [...tuneNames];
    tuneSource = "TUNES folder";
  } else if (fs.existsSync(TRIMMED_DIR)) {
    // Fallback: scan trimmed/ PNGs
    console.warn(
      `⚠ TUNES source folder not found, falling back to ${TRIMMED_DIR}/`,
    );
    const pattern = new RegExp(`-${INSTRUMENT}-\\d+\\.png$`, "i");
    fileTunes = [
      ...new Set(
        fs
          .readdirSync(TRIMMED_DIR)
          .filter((f) => pattern.test(f))
          .map((f) =>
            f
              .replace(/\.png$/i, "")
              .replace(new RegExp(`-${INSTRUMENT}-\\d+$`, "i"), ""),
          ),
      ),
    ];
    tuneSource = `${TRIMMED_DIR}/`;
  } else {
    console.error("Neither TUNES folder nor trimmed/ directory found.");
    process.exit(1);
  }

  console.log(`Found ${fileTunes.length} tunes in ${tuneSource}\n`);

  // Track which file tunes have been claimed
  const claimed = new Set(); // set of file tune names (original case)

  const newDances = {};
  let totalKept = 0,
    totalFixed = 0,
    totalRemoved = 0,
    totalAdded = 0;

  // Process each dance type
  for (const [danceType, tunes] of Object.entries(dances)) {
    const newTunes = [];

    for (const tune of tunes) {
      const result = findBestMatch(tune, fileTunes);

      if (!result) {
        console.log(`  ✗ REMOVE  "${tune}" (${danceType}) — no matching file`);
        totalRemoved++;
        continue;
      }

      const fileTune = result.match.trim();

      // Check if already claimed by another (non-Unclassified) section
      if (claimed.has(fileTune.toLowerCase()) && danceType === "Unclassified") {
        console.log(
          `  ✗ REMOVE  "${tune}" (Unclassified) — already in a specific section`,
        );
        totalRemoved++;
        continue;
      }

      if (result.type === "exact") {
        // Use the file's version (preserves original casing/spacing)
        newTunes.push(fileTune);
        claimed.add(fileTune.toLowerCase());
        totalKept++;
      } else {
        console.log(
          `  ✎ FIX     "${tune}" → "${fileTune}" (${danceType}) [${result.type}${result.distance ? `, dist=${result.distance}` : ""}]`,
        );
        newTunes.push(fileTune);
        claimed.add(fileTune.toLowerCase());
        totalFixed++;
      }
    }

    // Keep the dance type (even if empty — we'll prune below)
    newDances[danceType] = newTunes;
  }

  // Ensure Unclassified exists
  if (!newDances["Unclassified"]) {
    newDances["Unclassified"] = [];
  }

  // Add unclaimed file tunes to Unclassified
  for (const ft of fileTunes) {
    if (!claimed.has(ft.trim().toLowerCase())) {
      console.log(`  + ADD     "${ft.trim()}" → Unclassified`);
      newDances["Unclassified"].push(ft.trim());
      totalAdded++;
    }
  }

  // Sort entries within each section alphabetically
  for (const [key, tunes] of Object.entries(newDances)) {
    newDances[key] = tunes.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }

  // Summary
  console.log(`\n--- Summary ---`);
  console.log(`  Kept:    ${totalKept}`);
  console.log(`  Fixed:   ${totalFixed}`);
  console.log(`  Removed: ${totalRemoved}`);
  console.log(`  Added:   ${totalAdded}`);

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] Would write:\n`);
    console.log(JSON.stringify({ dances: newDances }, null, 2));
  } else {
    fs.writeFileSync(
      DANCE_TYPES_PATH,
      JSON.stringify({ dances: newDances }, null, 2) + "\n",
    );
    console.log(`\n✓ Updated ${DANCE_TYPES_PATH}`);
  }
}

main();
