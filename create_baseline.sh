#!/bin/bash

# Create baseline files from current trimmed folder
# This captures the "original" state before adding new tunes

echo "Creating baseline files from current trimmed folder..."

# Check if trimmed folder exists
if [ ! -d "trimmed" ]; then
    echo "Error: trimmed folder not found. Run batch_trim.sh first."
    exit 1
fi

# Create baseline for Flute files
echo "Creating baseline_flute.txt..."
ls trimmed/*Flute*.png 2>/dev/null | sort > baseline_flute.txt
flute_count=$(wc -l < baseline_flute.txt)
echo "  Found $flute_count Flute files"

# Create baseline for Clarinet files  
echo "Creating baseline_clarinet.txt..."
ls trimmed/*Clarinet_in_Bb*.png 2>/dev/null | sort > baseline_clarinet.txt
clarinet_count=$(wc -l < baseline_clarinet.txt)
echo "  Found $clarinet_count Clarinet files"

echo "✓ Baseline files created successfully"
echo "  - baseline_flute.txt ($flute_count files)"
echo "  - baseline_clarinet.txt ($clarinet_count files)"
echo ""
echo "Now you can add new tunes and run doit.sh to create booklets with appendix."
echo "To start fresh, simply delete these baseline files."