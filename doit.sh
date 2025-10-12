#!/bin/bash

# Function to ask yes/no questions
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

echo "=== Booklet Generation Workflow ==="
echo

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
    echo "Running main.js..."
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
