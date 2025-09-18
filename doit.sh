#!/bin/bash

rm -f booklet
./batch_trim.sh
node src/main.js
cp booklets/*.pdf /Users/paulleonard/Google\ Drive/My\ Drive/MUSIC/BalFolkFrome/Booklets/
