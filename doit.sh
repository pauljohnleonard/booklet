#!/bin/bash

# Function to ask yes/no questions (defaults to Yes)
ask_yes_no() {
    while true; do
        read -p "$1 (Y/n): " yn
        # Default to yes if empty (just pressed Enter)
        yn=${yn:-y}
        case $yn in
            [Yy]* ) return 0;;
            [Nn]* ) return 1;;
            * ) echo "Please answer y or n.";;
        esac
    done
}

# Function to ask yes/no questions (defaults to No)
ask_yes_no_default_no() {
    while true; do
        read -p "$1 (y/N): " yn
        # Default to no if empty (just pressed Enter)
        yn=${yn:-n}
        case $yn in
            [Yy]* ) return 0;;
            [Nn]* ) return 1;;
            * ) echo "Please answer y or n.";;
        esac
    done
}

echo "=== Booklet Generation Workflow ==="
echo

# Check if baseline files exist to determine workflow mode
baseline_exists=false
if [ -f "baseline_flute.txt" ] || [ -f "baseline_clarinet.txt" ]; then
    baseline_exists=true
    echo "📄 Baseline files detected - Appendix mode available"
    echo "   This will preserve existing booklet structure and add new tunes as appendix"
else
    echo "📄 No baseline files found - Full generation mode"
    echo "   This will create complete booklets from all available tunes"
fi
echo

# Baseline management options
if $baseline_exists; then
    if ask_yes_no_default_no "Reset to full generation mode (delete baseline files)?"; then
        rm -f baseline_*.txt
        echo "✓ Baseline files deleted - switching to full generation mode"
        baseline_exists=false
        echo
    fi
else
    if ask_yes_no "Create baseline files for future appendix mode?"; then
        if [ -d "trimmed" ] && [ "$(ls -A trimmed 2>/dev/null)" ]; then
            ./create_baseline.sh
            baseline_exists=true
            echo
        else
            echo "⚠️  No trimmed files found. Run batch_trim.sh first to create baseline."
            echo
        fi
    fi
fi

# Step 1: Fetch latest images from Google Drive
if ask_yes_no "Fetch latest images from Google Drive (run batch_trim.sh)?"; then
    echo "Running batch_trim.sh..."
    ./batch_trim.sh
    echo "✓ Completed batch_trim.sh"
    echo
else
    echo "Skipping batch_trim.sh"
    echo
fi

# Step 2: Run the Node.js script to create booklets
if ask_yes_no "Generate booklets (run main.js)?"; then
    if $baseline_exists; then
        echo "Running main.js in appendix mode..."
        echo "  - Original tunes will maintain their structure"
        echo "  - New tunes will be added as appendix with 'New Tunes' header"
    else
        echo "Running main.js in full generation mode..."
        echo "  - All tunes will be included in main booklet"
    fi
    node src/main.js
    echo "✓ Completed main.js"
    echo
else
    echo "Skipping main.js"
    echo
fi

# Step 3: Copy the generated booklets to the Google Drive folder
if ask_yes_no "Copy booklets to Google Drive?"; then
    echo "Copying to Google Drive..."
    cp booklets/*.pdf /Users/paulleonard/Google\ Drive/My\ Drive/MUSIC/BalFolkFrome/Booklets/
    echo "✓ Completed copy to Google Drive"
    echo
else
    echo "Skipping copy to Google Drive"
    echo
fi

echo "=== Workflow Complete ==="
echo
if $baseline_exists; then
    echo "💡 Tip: To add more tunes in the future:"
    echo "   1. Add new tune folders to Google Drive"
    echo "   2. Run ./doit.sh (it will automatically detect and append new tunes)"
    echo "   3. To start fresh, choose 'Reset to full generation mode' next time"
else
    echo "💡 Tip: To use appendix mode in the future:"
    echo "   1. Run ./doit.sh again and choose 'Create baseline files'"
    echo "   2. Add new tunes to Google Drive"
    echo "   3. Run ./doit.sh to generate booklets with appendix"
fi
