#!/bin/bash

# Create baseline files from current trimmed folder
# This captures the "original" state before adding new tunes

echo "Creating baseline files from current trimmed folder..."

# Check if trimmed folder exists
if [ ! -d "trimmed" ]; then
    echo "Error: trimmed folder not found. Run batch_trim.sh first."
    exit 1
fi

# Create baseline for C files
echo "Creating baseline_c.txt..."
ls trimmed/*-C-*.png 2>/dev/null | sort > baseline_c.txt
c_count=$(wc -l < baseline_c.txt)
echo "  Found $c_count C files"

# Create baseline for Bb files  
echo "Creating baseline_bb.txt..."
ls trimmed/*-Bb-*.png 2>/dev/null | sort > baseline_bb.txt
bb_count=$(wc -l < baseline_bb.txt)
echo "  Found $bb_count Bb files"

# Create baseline for Bass clef files
echo "Creating baseline_b.txt..."
ls trimmed/*-B-*.png 2>/dev/null | sort > baseline_b.txt
b_count=$(wc -l < baseline_b.txt)
echo "  Found $b_count Bass clef files"

echo "✓ Baseline files created successfully"
echo "  - baseline_c.txt ($c_count files)"
echo "  - baseline_bb.txt ($bb_count files)"
echo "  - baseline_b.txt ($b_count files)"
echo ""
echo "Now you can add new tunes and run doit.sh to create booklets with appendix."
echo "To start fresh, simply delete these baseline files."