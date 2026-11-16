#!/bin/sh
# Fixture HTTP response for the local-forward test. A file rather than an
# inline socat SYSTEM command, whose option parser strips the quotes printf
# needs around its format string.
printf 'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello'
