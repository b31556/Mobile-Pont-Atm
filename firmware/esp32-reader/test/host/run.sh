#!/bin/sh
# Builds and runs the display-logic tests on this computer.
set -e
cd "$(dirname "$0")"
g++ -std=c++17 -Wall -Wextra -Werror -o /tmp/reader_host_tests test_display_logic.cpp
/tmp/reader_host_tests
