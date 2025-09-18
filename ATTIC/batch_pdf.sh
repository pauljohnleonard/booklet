#!/bin/bash
# This script converts a MuseScore file to PNG format using the MuseScore application.
# Ensure the MuseScore application path is correct for your system.

set -x

musescore="/Applications/MuseScore 4.app/Contents/MacOS/mscore"

folder="/Users/paulleonard/Library/CloudStorage/GoogleDrive-pauljohnleonard@gmail.com/My Drive/MUSIC/BalFolkFrome/TUNES/"
ls "${folder}"

filename=`ls "${folder}"Crested\ Hens/*.mscz`

echo "Converting $filename to PNG format..."
# Extract the base filename without extension
base_filename=$(basename "$filename" .mscz)

"${musescore}" -o "${base_filename}.png" "$filename"
