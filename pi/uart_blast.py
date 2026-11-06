#!/usr/bin/env python3
"""Bench probe: transmit 0x55 ('U', alternating bits) on the Pi's UART for N seconds,
so the beacon's pinscan can see which header pin the Pi's TX wire reaches."""
import sys, time
import serial

secs = float(sys.argv[1]) if len(sys.argv) > 1 else 10
s = serial.Serial("/dev/ttyAMA0", 38400)
t0, sent = time.time(), 0
while time.time() - t0 < secs:
    sent += s.write(b"U" * 64)
    s.flush()
print(f"uart_blast: sent {sent} bytes in {secs:.0f} s")
