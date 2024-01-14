#!/bin/bash

while IFS= read -r line; do
    if echo "$line" | jq . 2>/dev/null; then
        echo ""  # New line after successful jq processing
    else
        echo "$line"  # Just print the line for non-JSON content
    fi
done
