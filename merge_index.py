#!/usr/bin/env python3
"""
Merge dance name variants in dance_book_index.csv using manual mappings.

Uses two merge strategies:
  1. Strip parenthetical annotations: "Foo (Israel)" -> "Foo"
  2. Manual name mappings from name_mappings.csv

Workflow:
  1. Edit name_mappings.csv to add/fix mappings
  2. Run: python3 merge_index.py
  3. Output: dance_book_index_merged.csv

Input:  dance_book_index.csv  (the raw scraped index)
        name_mappings.csv     (manual variant -> canonical mappings)
Output: dance_book_index_merged.csv  (the clean merged index)
"""

import csv
import re

INPUT_FILE = "dance_book_index.csv"
MAPPINGS_FILE = "name_mappings.csv"
OUTPUT_FILE = "dance_book_index_merged.csv"

# Normalize curly quotes to straight for matching
QUOTE_MAP = str.maketrans("\u2018\u2019\u201c\u201d", "''\"\"")


def normalize_quotes(s):
    return s.translate(QUOTE_MAP)


def load_mappings(path):
    """Load name_mappings.csv: variant_name,canonical_name"""
    mappings = {}
    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            for row in reader:
                # Skip comments and empty lines
                if not row or row[0].startswith("#"):
                    continue
                if len(row) >= 2:
                    variant, canonical = row[0].strip(), row[1].strip()
                    if variant and canonical:
                        mappings[variant] = canonical
    except FileNotFoundError:
        print(f"  Warning: {path} not found, no manual mappings applied")
    return mappings


def strip_parens(name):
    """Strip parenthetical annotations like (Israel), (Gr.), (Bul.)"""
    return re.sub(r'\s*\([^)]*\)', '', name).strip()


def merge_books(*book_strings):
    """Combine book strings, deduplicating."""
    books = set()
    for s in book_strings:
        for b in s.split("; "):
            b = b.strip()
            if b:
                books.add(b)
    return "; ".join(sorted(books))


def main():
    # Load raw index
    rows = []
    with open(INPUT_FILE, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        next(reader)  # skip header
        for row in reader:
            if len(row) >= 2:
                rows.append((row[0], row[1]))

    print(f"Loaded {len(rows)} entries from {INPUT_FILE}")

    # Load manual mappings
    mappings = load_mappings(MAPPINGS_FILE)
    print(f"Loaded {len(mappings)} manual name mappings from {MAPPINGS_FILE}")

    # Build a lookup that works with both curly and straight quotes
    norm_mappings = {}
    for variant, canonical in mappings.items():
        norm_mappings[normalize_quotes(variant)] = canonical

    # Apply mappings and build merged index
    merged = {}  # canonical_name -> books_str
    applied = 0

    for name, books in rows:
        # Check manual mapping first (try both original and quote-normalized)
        norm_name = normalize_quotes(name)
        if name in mappings:
            canonical = mappings[name]
            applied += 1
        elif norm_name in norm_mappings:
            canonical = norm_mappings[norm_name]
            applied += 1
        else:
            canonical = name

        # Normalize quotes in canonical name so curly/straight variants merge
        canonical = normalize_quotes(canonical)

        if canonical in merged:
            merged[canonical] = merge_books(merged[canonical], books)
        else:
            merged[canonical] = books

    # Second pass: merge entries that only differ by parenthetical annotation
    # into an existing canonical entry
    final = {}
    for name, books in sorted(merged.items(), key=lambda x: x[0].lower()):
        bare = strip_parens(name)
        if bare != name and bare in merged and bare in final:
            final[bare] = merge_books(final[bare], books)
            applied += 1
        else:
            if name in final:
                final[name] = merge_books(final[name], books)
            else:
                final[name] = books

    # Write output
    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Dance", "Book(s)"])
        for dance in sorted(final.keys(), key=str.lower):
            writer.writerow([dance, final[dance]])

    print(f"\nApplied {applied} mappings")
    print(f"Merged {len(rows)} -> {len(final)} entries")
    print(f"Written to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
